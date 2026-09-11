import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { CommonDbModule } from '../../src/common/db/common-db.module';
import { WriteDbService } from '../../src/common/db/write-db.service';
import { CatalogWriteModule } from '../../src/catalog-write/catalog-write.module';
import { ReserveStockCommand } from '../../src/catalog-write/commands/reserve-stock.command';
import { ReleaseStockCommand } from '../../src/catalog-write/commands/release-stock.command';
import { ErrInsufficientStock } from '../../src/catalog-write/errors';

describe('Reservation Concurrency (Centerpiece 1)', () => {
  let moduleRef: TestingModule;
  let commandBus: CommandBus;
  let writeDb: WriteDbService;
  let vendorId: string;
  let categoryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CommonDbModule, CqrsModule, CatalogWriteModule],
    }).compile();

    await moduleRef.init();
    commandBus = moduleRef.get<CommandBus>(CommandBus);
    writeDb = moduleRef.get<WriteDbService>(WriteDbService);
    await writeDb.onModuleInit();

    // Seed test vendor and category
    const vendor = await writeDb.vendor.create({
      data: {
        name: 'Concurrency Test Vendor',
        slug: `concurrency-vendor-${Date.now()}`,
        status: 'ACTIVE',
      },
    });
    vendorId = vendor.id;

    const category = await writeDb.category.create({
      data: {
        name: 'Concurrency Test Category',
        slug: `concurrency-category-${Date.now()}`,
      },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    if (writeDb) {
      // Clean up test data
      await writeDb.productListing.deleteMany({
        where: { vendorId },
      });
      await writeDb.vendor.delete({ where: { id: vendorId } }).catch(() => {});
      await writeDb.category.delete({ where: { id: categoryId } }).catch(() => {});
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('Exact-stock oversell test: 50 concurrent requests for 1 unit against 10 stock yields exactly 10 successes and 40 failures', async () => {
    // 1. Seed listing with exactly 10 on-hand stock and 0 reserved
    const listing = await writeDb.productListing.create({
      data: {
        vendorId,
        categoryId,
        sku: `CONC-EXACT-${Date.now()}`,
        title: 'High Contention Product',
        priceCents: 1999n,
        status: 'ACTIVE',
        inventory: {
          create: {
            onHandQuantity: 10,
            reservedQuantity: 0,
          },
        },
      },
      include: { inventory: true },
    });

    // 2. Fire 50 genuinely concurrent reservation requests (1 unit each)
    const promises = Array.from({ length: 50 }, () =>
      commandBus.execute(new ReserveStockCommand(listing.id, 1)),
    );

    const results = await Promise.allSettled(promises);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    // 3. Assert exact numbers: exactly 10 succeed, exactly 40 fail
    expect(successes.length).toBe(10);
    expect(failures.length).toBe(40);

    // Verify all failures threw ErrInsufficientStock
    failures.forEach((f: any) => {
      expect(f.reason).toBeInstanceOf(ErrInsufficientStock);
    });

    // 4. Assert direct write-side database state: reserved_quantity must be exactly 10
    const rawInv = await writeDb.inventory.findUnique({
      where: { listingId: listing.id },
    });

    expect(rawInv).toBeDefined();
    expect(rawInv!.onHandQuantity).toBe(10);
    expect(rawInv!.reservedQuantity).toBe(10);
    expect(rawInv!.onHandQuantity - rawInv!.reservedQuantity).toBe(0);
  });

  it('Partial-quantity contention: 5 concurrent requests for 3 units against 10 stock yields exactly 3 successes', async () => {
    // 1. Seed listing with 10 on-hand stock
    const listing = await writeDb.productListing.create({
      data: {
        vendorId,
        categoryId,
        sku: `CONC-PARTIAL-${Date.now()}`,
        title: 'Partial Contention Product',
        priceCents: 2999n,
        status: 'ACTIVE',
        inventory: {
          create: {
            onHandQuantity: 10,
            reservedQuantity: 0,
          },
        },
      },
    });

    // 2. Fire 5 concurrent requests for 3 units each (15 requested against 10 available)
    const promises = Array.from({ length: 5 }, () =>
      commandBus.execute(new ReserveStockCommand(listing.id, 3)),
    );

    const results = await Promise.allSettled(promises);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    // 3 * 3 = 9 used out of 10. The 4th and 5th cannot reserve 3 units (only 1 unit left).
    expect(successes.length).toBe(3);
    expect(failures.length).toBe(2);

    const rawInv = await writeDb.inventory.findUnique({
      where: { listingId: listing.id },
    });

    expect(rawInv!.reservedQuantity).toBe(9);
    expect(rawInv!.onHandQuantity - rawInv!.reservedQuantity).toBe(1);
  });

  it('Release correctness under concurrency: concurrent releases decrement reserved quantity accurately without going negative', async () => {
    // Seed listing with 10 on hand, 9 reserved
    const listing = await writeDb.productListing.create({
      data: {
        vendorId,
        categoryId,
        sku: `CONC-RELEASE-${Date.now()}`,
        title: 'Release Contention Product',
        priceCents: 1500n,
        status: 'ACTIVE',
        inventory: {
          create: {
            onHandQuantity: 10,
            reservedQuantity: 9,
          },
        },
      },
    });

    // Fire 3 concurrent releases for 3 units each (total 9 units released)
    const releasePromises = [
      commandBus.execute(new ReleaseStockCommand(listing.id, 3)),
      commandBus.execute(new ReleaseStockCommand(listing.id, 3)),
      commandBus.execute(new ReleaseStockCommand(listing.id, 3)),
    ];

    const results = await Promise.allSettled(releasePromises);
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBe(3);

    // Reserved quantity should now be 0
    let rawInv = await writeDb.inventory.findUnique({
      where: { listingId: listing.id },
    });
    expect(rawInv!.reservedQuantity).toBe(0);

    // Attempting another release when reservedQuantity is 0 must be rejected
    await expect(
      commandBus.execute(new ReleaseStockCommand(listing.id, 1)),
    ).rejects.toThrow();

    // Verify it never went negative
    rawInv = await writeDb.inventory.findUnique({
      where: { listingId: listing.id },
    });
    expect(rawInv!.reservedQuantity).toBe(0);
  });
});
