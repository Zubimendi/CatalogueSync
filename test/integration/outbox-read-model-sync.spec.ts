import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { CommonDbModule } from '../../src/common/db/common-db.module';
import { WriteDbService } from '../../src/common/db/write-db.service';
import { ProjectorDbService } from '../../src/common/db/projector-db.service';
import { CatalogWriteModule } from '../../src/catalog-write/catalog-write.module';
import { ProjectorModule } from '../../src/projector/projector.module';
import { OutboxProjectorService } from '../../src/projector/outbox-projector.service';
import { RedisModule } from '../../src/common/redis/redis.module';
import { RedisService } from '../../src/common/redis/redis.service';
import { CreateListingCommand } from '../../src/catalog-write/commands/create-listing.command';
import { ReserveStockCommand } from '../../src/catalog-write/commands/reserve-stock.command';
import { DelistListingCommand } from '../../src/catalog-write/commands/delist-listing.command';

describe('Outbox-to-Read-Model Sync (Test §5)', () => {
  let moduleRef: TestingModule;
  let commandBus: CommandBus;
  let writeDb: WriteDbService;
  let projectorDb: ProjectorDbService;
  let projectorService: OutboxProjectorService;
  let redis: RedisService;
  let vendorId: string;
  let categoryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CommonDbModule,
        RedisModule,
        CqrsModule,
        CatalogWriteModule,
        ProjectorModule,
      ],
    }).compile();

    await moduleRef.init();
    commandBus = moduleRef.get<CommandBus>(CommandBus);
    writeDb = moduleRef.get<WriteDbService>(WriteDbService);
    projectorDb = moduleRef.get<ProjectorDbService>(ProjectorDbService);
    projectorService = moduleRef.get<OutboxProjectorService>(OutboxProjectorService);
    redis = moduleRef.get<RedisService>(RedisService);

    const vendor = await writeDb.vendor.create({
      data: {
        name: 'Projector Test Vendor',
        slug: `projector-vendor-${Date.now()}`,
        status: 'ACTIVE',
      },
    });
    vendorId = vendor.id;

    const category = await writeDb.category.create({
      data: {
        name: 'Projector Category',
        slug: `projector-category-${Date.now()}`,
      },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    if (writeDb) {
      await writeDb.productListing.deleteMany({ where: { vendorId } });
      await writeDb.vendor.delete({ where: { id: vendorId } }).catch(() => {});
      await writeDb.category.delete({ where: { id: categoryId } }).catch(() => {});
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('A write creates an outbox row via DB trigger, and projector reflects it into catalog_listings_view', async () => {
    // 1. Create a listing
    const { listing } = await commandBus.execute(
      new CreateListingCommand(
        vendorId,
        categoryId,
        `PROJ-SYNC-${Date.now()}`,
        'Sync Test Mechanical Keyboard',
        'Top-tier tactile switches',
        14999n,
        'USD',
        25,
      ),
    );

    // 2. Verify trigger wrote to outbox_events in the same transaction
    const outboxRows: any[] = await writeDb.$queryRawUnsafe(
      `SELECT * FROM outbox_events WHERE entity_id = $1::uuid ORDER BY id ASC;`,
      listing.id,
    );
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);

    // 3. Run one projector batch pass
    const processedCount = await projectorService.processBatch();
    expect(processedCount).toBeGreaterThanOrEqual(1);

    // 4. Verify catalog_listings_view denormalized row
    const viewRow = await projectorDb.catalogListingsView.findUnique({
      where: { listingId: listing.id },
    });

    expect(viewRow).toBeDefined();
    expect(viewRow!.title).toBe('Sync Test Mechanical Keyboard');
    expect(viewRow!.vendorName).toBe('Projector Test Vendor');
    expect(viewRow!.categoryName).toBe('Projector Category');
    expect(viewRow!.availableQuantity).toBe(25);
    expect(viewRow!.status).toBe('ACTIVE');
    expect(viewRow!.lastSyncedOutboxId).toBeDefined();
  });

  it('A stock reservation updates available_quantity in catalog_listings_view via outbox', async () => {
    // Create listing
    const { listing } = await commandBus.execute(
      new CreateListingCommand(
        vendorId,
        categoryId,
        `PROJ-RESERVE-${Date.now()}`,
        'Inventory Sync Item',
        'Stock test item',
        5000n,
        'USD',
        10,
      ),
    );

    // Project initial state
    await projectorService.processBatch();

    // Reserve 4 units
    await commandBus.execute(new ReserveStockCommand(listing.id, 4));

    // Confirm inventory outbox trigger fired
    const invOutbox: any[] = await writeDb.$queryRawUnsafe(
      `SELECT * FROM outbox_events WHERE entity_id = $1::uuid AND entity_type = 'inventory' AND processed_at IS NULL;`,
      listing.id,
    );
    expect(invOutbox.length).toBe(1);

    // Process projector batch
    await projectorService.processBatch();

    // Check read model
    const viewRow = await projectorDb.catalogListingsView.findUnique({
      where: { listingId: listing.id },
    });

    expect(viewRow!.availableQuantity).toBe(6); // 10 on hand - 4 reserved = 6 available
  });

  it('Delisting updates status in the read model', async () => {
    const { listing } = await commandBus.execute(
      new CreateListingCommand(
        vendorId,
        categoryId,
        `PROJ-DELIST-${Date.now()}`,
        'Item to Delist',
        'Description',
        2000n,
        'USD',
        5,
      ),
    );

    await projectorService.processBatch();

    // Delist
    await commandBus.execute(new DelistListingCommand(listing.id, vendorId));

    // Process projector
    await projectorService.processBatch();

    const viewRow = await projectorDb.catalogListingsView.findUnique({
      where: { listingId: listing.id },
    });

    expect(viewRow!.status).toBe('DELISTED');
  });

  it('Redis invalidation happens alongside read-model updates', async () => {
    const { listing } = await commandBus.execute(
      new CreateListingCommand(
        vendorId,
        categoryId,
        `PROJ-CACHE-${Date.now()}`,
        'Cache Invalidation Item',
        'Desc',
        3000n,
        'USD',
        10,
      ),
    );
    await projectorService.processBatch();

    // Warm cache artificially
    const cacheKey = `catalog:listing:${listing.id}`;
    await redis.set(cacheKey, JSON.stringify({ cached: true }), 60);
    expect(await redis.get(cacheKey)).not.toBeNull();

    // Reserve stock to trigger update
    await commandBus.execute(new ReserveStockCommand(listing.id, 2));

    // Process projector
    await projectorService.processBatch();

    // Cache key must be invalidated (deleted)
    const cachedAfter = await redis.get(cacheKey);
    expect(cachedAfter).toBeNull();
  });
});
