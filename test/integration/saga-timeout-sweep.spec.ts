import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule } from '@nestjs/cqrs';
import { CommonDbModule } from '../../src/common/db/common-db.module';
import { WriteDbService } from '../../src/common/db/write-db.service';
import { OrderingModule } from '../../src/ordering/ordering.module';
import { SagaReconciliationService } from '../../src/ordering/saga-reconciliation.service';

describe('Saga Timeout Sweep (Test §4)', () => {
  let moduleRef: TestingModule;
  let writeDb: WriteDbService;
  let sweepService: SagaReconciliationService;

  let vendorId: string;
  let categoryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CommonDbModule, CqrsModule, OrderingModule],
    }).compile();

    await moduleRef.init();
    writeDb = moduleRef.get<WriteDbService>(WriteDbService);
    sweepService = moduleRef.get<SagaReconciliationService>(SagaReconciliationService);

    const v = await writeDb.vendor.create({
      data: { name: 'Sweep Vendor', slug: `sweep-v-${Date.now()}`, status: 'ACTIVE' },
    });
    vendorId = v.id;

    const cat = await writeDb.category.create({
      data: { name: 'Sweep Cat', slug: `sweep-cat-${Date.now()}` },
    });
    categoryId = cat.id;
  });

  afterAll(async () => {
    if (writeDb) {
      await writeDb.customerOrder.deleteMany({
        where: { buyerRef: { in: ['buyer-crashed-session', 'buyer-fresh'] } },
      });
      await writeDb.productListing.deleteMany({ where: { vendorId } });
      await writeDb.vendor.delete({ where: { id: vendorId } }).catch(() => {});
      await writeDb.category.delete({ where: { id: categoryId } }).catch(() => {});
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('A simulated crashed saga is caught and compensated by the timeout sweep', async () => {
    // 1. Create a listing with 10 on hand, 0 reserved
    const listing = await writeDb.productListing.create({
      data: {
        vendorId,
        categoryId,
        sku: `SWEEP-CRASH-${Date.now()}`,
        title: 'Crashed Item',
        priceCents: 5000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    // 2. Reserve 4 units manually on inventory (simulating what happened before crash)
    await writeDb.reserveStock(listing.id, 4);

    // 3. Create simulated crashed order created 5 minutes ago (well past timeout)
    const fiveMinutesAgo = new Date(Date.now() - 300 * 1000);
    const crashedOrder = await writeDb.customerOrder.create({
      data: {
        buyerRef: 'buyer-crashed-session',
        status: 'PENDING',
        totalCents: 20000n,
        createdAt: fiveMinutesAgo,
        updatedAt: fiveMinutesAgo,
        vendorSuborders: {
          create: {
            vendorId,
            status: 'RESERVED',
            subtotalCents: 20000n,
            createdAt: fiveMinutesAgo,
            updatedAt: fiveMinutesAgo,
            lineItems: {
              create: {
                listingId: listing.id,
                quantity: 4,
                unitPriceCents: 5000n,
                createdAt: fiveMinutesAgo,
              },
            },
          },
        },
      },
      include: {
        vendorSuborders: { include: { lineItems: true } },
      },
    });

    // 4. Run sweep pass with 60 second timeout threshold
    const compensatedCount = await sweepService.sweepStuckOrders(60);
    expect(compensatedCount).toBeGreaterThanOrEqual(1);

    // 5. Verify inventory reservation is fully released back to 0
    const inv = await writeDb.inventory.findUnique({ where: { listingId: listing.id } });
    expect(inv!.reservedQuantity).toBe(0);

    // 6. Verify suborder is ROLLED_BACK and order is FAILED
    const updatedSub = await writeDb.vendorSuborder.findFirst({
      where: { customerOrderId: crashedOrder.id },
    });
    expect(updatedSub!.status).toBe('ROLLED_BACK');

    const updatedOrder = await writeDb.customerOrder.findUnique({
      where: { id: crashedOrder.id },
    });
    expect(updatedOrder!.status).toBe('FAILED');

    // 7. Verify distinct SWEEP_COMPENSATED step recorded
    const steps = await writeDb.sagaStep.findMany({
      where: { customerOrderId: crashedOrder.id },
    });
    expect(steps.some((s) => s.stepType === 'SWEEP_COMPENSATED')).toBe(true);
  });

  it('Fresh in-flight order within timeout window is NOT touched by the sweep', async () => {
    const listing = await writeDb.productListing.create({
      data: {
        vendorId,
        categoryId,
        sku: `SWEEP-FRESH-${Date.now()}`,
        title: 'Fresh Item',
        priceCents: 2000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    await writeDb.reserveStock(listing.id, 2);

    // Created right now (fresh)
    const freshOrder = await writeDb.customerOrder.create({
      data: {
        buyerRef: 'buyer-fresh',
        status: 'PENDING',
        totalCents: 4000n,
        vendorSuborders: {
          create: {
            vendorId,
            status: 'RESERVED',
            subtotalCents: 4000n,
            lineItems: {
              create: {
                listingId: listing.id,
                quantity: 2,
                unitPriceCents: 2000n,
              },
            },
          },
        },
      },
    });

    // Run sweep with 120s timeout
    await sweepService.sweepStuckOrders(120);

    // Order must remain PENDING and stock must still be held
    const orderCheck = await writeDb.customerOrder.findUnique({ where: { id: freshOrder.id } });
    expect(orderCheck!.status).toBe('PENDING');

    const inv = await writeDb.inventory.findUnique({ where: { listingId: listing.id } });
    expect(inv!.reservedQuantity).toBe(2);

    // Clean up
    await writeDb.releaseStock(listing.id, 2);
  });

  it('Sweep is idempotent: running twice does not double-release or error', async () => {
    // Run second sweep pass
    const secondPass = await sweepService.sweepStuckOrders(60);
    expect(secondPass).toBe(0);
  });
});
