import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { CommonDbModule } from '../../src/common/db/common-db.module';
import { WriteDbService } from '../../src/common/db/write-db.service';
import { CatalogWriteModule } from '../../src/catalog-write/catalog-write.module';
import { OrderingModule } from '../../src/ordering/ordering.module';
import { OrderSagaService } from '../../src/ordering/order-saga.service';
import { CreateListingCommand } from '../../src/catalog-write/commands/create-listing.command';
import { UpdateListingCommand } from '../../src/catalog-write/commands/update-listing.command';

describe('Price Snapshotting (Test §6)', () => {
  let moduleRef: TestingModule;
  let commandBus: CommandBus;
  let writeDb: WriteDbService;
  let sagaService: OrderSagaService;

  let vendorId: string;
  let categoryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CommonDbModule, CqrsModule, CatalogWriteModule, OrderingModule],
    }).compile();

    await moduleRef.init();
    commandBus = moduleRef.get<CommandBus>(CommandBus);
    writeDb = moduleRef.get<WriteDbService>(WriteDbService);
    sagaService = moduleRef.get<OrderSagaService>(OrderSagaService);

    const vendor = await writeDb.vendor.create({
      data: { name: 'Price Test Vendor', slug: `price-vendor-${Date.now()}`, status: 'ACTIVE' },
    });
    vendorId = vendor.id;

    const category = await writeDb.category.create({
      data: { name: 'Price Category', slug: `price-cat-${Date.now()}` },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    if (writeDb) {
      await writeDb.customerOrder.deleteMany({
        where: { buyerRef: { in: ['buyer-order-1', 'buyer-order-2'] } },
      });
      await writeDb.productListing.deleteMany({ where: { vendorId } });
      await writeDb.vendor.delete({ where: { id: vendorId } }).catch(() => {});
      await writeDb.category.delete({ where: { id: categoryId } }).catch(() => {});
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('Order line item captures price at order time and does not mutate when live listing price changes', async () => {
    // 1. Create a listing at initial price $20.00 (2000 cents)
    const { listing } = await commandBus.execute(
      new CreateListingCommand(
        vendorId,
        categoryId,
        `PRICE-SNAP-${Date.now()}`,
        'Snapshotted Price Headphones',
        'Noise cancelling',
        2000n,
        'USD',
        50,
      ),
    );

    // 2. Place Order 1 at $20.00
    const order1 = await sagaService.placeOrder('buyer-order-1', [
      { listingId: listing.id, quantity: 1 },
    ]);
    expect(order1.status).toBe('CONFIRMED');

    // 3. Vendor updates live listing price to $35.00 (3500 cents)
    await commandBus.execute(
      new UpdateListingCommand(
        listing.id,
        vendorId,
        undefined,
        undefined,
        3500n,
      ),
    );

    // 4. Verify original order's line item is UNCHANGED ($20.00)
    const savedOrder1 = await sagaService.getOrder(order1.customerOrderId);
    const lineItem1 = savedOrder1.vendorSuborders[0].lineItems[0];
    expect(lineItem1.unitPriceCents).toBe('2000');

    // 5. Place Order 2 after the price change
    const order2 = await sagaService.placeOrder('buyer-order-2', [
      { listingId: listing.id, quantity: 1 },
    ]);
    expect(order2.status).toBe('CONFIRMED');

    // 6. Verify second order captured the NEW price ($35.00)
    const savedOrder2 = await sagaService.getOrder(order2.customerOrderId);
    const lineItem2 = savedOrder2.vendorSuborders[0].lineItems[0];
    expect(lineItem2.unitPriceCents).toBe('3500');
  });
});
