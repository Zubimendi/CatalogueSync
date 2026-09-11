import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { CommonDbModule } from '../../src/common/db/common-db.module';
import { WriteDbService } from '../../src/common/db/write-db.service';
import { CatalogWriteModule } from '../../src/catalog-write/catalog-write.module';
import { OrderingModule } from '../../src/ordering/ordering.module';
import { VendorsModule } from '../../src/vendors/vendors.module';
import { VendorsService } from '../../src/vendors/vendors.service';
import { OrderSagaService } from '../../src/ordering/order-saga.service';
import { CreateListingCommand } from '../../src/catalog-write/commands/create-listing.command';
import { UpdateListingCommand } from '../../src/catalog-write/commands/update-listing.command';
import { ErrNotYourListing, ErrVendorSuspended } from '../../src/catalog-write/errors';
import { ErrVendorSuspendedForOrder } from '../../src/ordering/errors';

describe('Vendor-Scoped Write Boundaries (Test §7)', () => {
  let moduleRef: TestingModule;
  let commandBus: CommandBus;
  let writeDb: WriteDbService;
  let vendorsService: VendorsService;
  let sagaService: OrderSagaService;

  let vendorAId: string;
  let vendorBId: string;
  let categoryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CommonDbModule,
        CqrsModule,
        CatalogWriteModule,
        OrderingModule,
        VendorsModule,
      ],
    }).compile();

    await moduleRef.init();
    commandBus = moduleRef.get<CommandBus>(CommandBus);
    writeDb = moduleRef.get<WriteDbService>(WriteDbService);
    vendorsService = moduleRef.get<VendorsService>(VendorsService);
    sagaService = moduleRef.get<OrderSagaService>(OrderSagaService);

    const vA = await vendorsService.createVendor('Vendor Alpha', `v-alpha-${Date.now()}`);
    vendorAId = vA.id;

    const vB = await vendorsService.createVendor('Vendor Beta', `v-beta-${Date.now()}`);
    vendorBId = vB.id;

    const cat = await vendorsService.createCategory('Scoped Category', `cat-scope-${Date.now()}`);
    categoryId = cat.id;
  });

  afterAll(async () => {
    if (writeDb) {
      await writeDb.customerOrder.deleteMany({
        where: { buyerRef: { in: ['buyer-suspended-test', 'buyer-mid-flight'] } },
      });
      await writeDb.productListing.deleteMany({
        where: { vendorId: { in: [vendorAId, vendorBId] } },
      });
      await writeDb.vendor.deleteMany({
        where: { id: { in: [vendorAId, vendorBId] } },
      });
      await writeDb.category.delete({ where: { id: categoryId } }).catch(() => {});
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it("Vendor A attempting UpdateListingCommand against Vendor B's listing is rejected with ErrNotYourListing", async () => {
    // 1. Vendor B creates a listing
    const { listing } = await commandBus.execute(
      new CreateListingCommand(
        vendorBId,
        categoryId,
        `VEND-B-ITEM-${Date.now()}`,
        'Vendor B Item',
        'Belongs to B',
        5000n,
        'USD',
        10,
      ),
    );

    // 2. Vendor A attempts to update Vendor B's listing
    await expect(
      commandBus.execute(
        new UpdateListingCommand(
          listing.id,
          vendorAId, // Wrong vendor!
          'Hijacked Title',
        ),
      ),
    ).rejects.toBeInstanceOf(ErrNotYourListing);

    // Verify title was not changed in DB
    const current = await writeDb.productListing.findUnique({ where: { id: listing.id } });
    expect(current!.title).toBe('Vendor B Item');
  });

  it('A suspended vendor is blocked from creating new listings and from new order placement', async () => {
    // Suspend Vendor B
    await vendorsService.updateVendorStatus(vendorBId, 'SUSPENDED');

    // 1. Creating listing under suspended vendor is rejected
    await expect(
      commandBus.execute(
        new CreateListingCommand(
          vendorBId,
          categoryId,
          `VEND-B-BLOCKED-${Date.now()}`,
          'Blocked Item',
          'Desc',
          1000n,
          'USD',
          5,
        ),
      ),
    ).rejects.toBeInstanceOf(ErrVendorSuspended);

    // 2. Existing listing of Vendor B created before suspension
    const listingB = await writeDb.productListing.findFirst({
      where: { vendorId: vendorBId },
    });

    // Placing new order with suspended vendor's listing is rejected
    if (listingB) {
      await expect(
        sagaService.placeOrder('buyer-suspended-test', [
          { listingId: listingB.id, quantity: 1 },
        ]),
      ).rejects.toBeInstanceOf(ErrVendorSuspendedForOrder);
    }

    // Restore Vendor B status to ACTIVE for subsequent tests
    await vendorsService.updateVendorStatus(vendorBId, 'ACTIVE');
  });

  it('Mid-saga suspension: a vendor suspended after order creation does NOT retroactively fail or compensate the order (CURSOR_CONTEXT §0)', async () => {
    // Create listing for Vendor A
    const { listing: listingA } = await commandBus.execute(
      new CreateListingCommand(
        vendorAId,
        categoryId,
        `VEND-A-MIDSAGA-${Date.now()}`,
        'Mid Saga Item',
        'Desc',
        3000n,
        'USD',
        10,
      ),
    );

    // Place order
    const order = await sagaService.placeOrder('buyer-mid-flight', [
      { listingId: listingA.id, quantity: 2 },
    ]);
    expect(order.status).toBe('CONFIRMED');

    // Suspend Vendor A AFTER order placed
    await vendorsService.updateVendorStatus(vendorAId, 'SUSPENDED');

    // Verify order remains CONFIRMED and reservations are intact
    const fetched = await sagaService.getOrder(order.customerOrderId);
    expect(fetched.status).toBe('CONFIRMED');
    expect(fetched.vendorSuborders[0].status).toBe('RESERVED');

    const inv = await writeDb.inventory.findUnique({ where: { listingId: listingA.id } });
    expect(inv!.reservedQuantity).toBe(2);

    // Restore status
    await vendorsService.updateVendorStatus(vendorAId, 'ACTIVE');
  });
});
