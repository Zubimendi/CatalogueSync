import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule } from '@nestjs/cqrs';
import { CommonDbModule } from '../../src/common/db/common-db.module';
import { WriteDbService } from '../../src/common/db/write-db.service';
import { OrderingModule } from '../../src/ordering/ordering.module';
import { OrderSagaService } from '../../src/ordering/order-saga.service';

describe('Saga Compensation (Centerpiece 2 - Test §2)', () => {
  let moduleRef: TestingModule;
  let writeDb: WriteDbService;
  let sagaService: OrderSagaService;

  let vendorAId: string;
  let vendorBId: string;
  let vendorCId: string;
  let categoryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CommonDbModule, CqrsModule, OrderingModule],
    }).compile();

    await moduleRef.init();
    writeDb = moduleRef.get<WriteDbService>(WriteDbService);
    sagaService = moduleRef.get<OrderSagaService>(OrderSagaService);

    // Create 3 test vendors
    const vA = await writeDb.vendor.create({
      data: { name: 'Vendor A', slug: `saga-va-${Date.now()}`, status: 'ACTIVE' },
    });
    vendorAId = vA.id;

    const vB = await writeDb.vendor.create({
      data: { name: 'Vendor B', slug: `saga-vb-${Date.now()}`, status: 'ACTIVE' },
    });
    vendorBId = vB.id;

    const vC = await writeDb.vendor.create({
      data: { name: 'Vendor C', slug: `saga-vc-${Date.now()}`, status: 'ACTIVE' },
    });
    vendorCId = vC.id;

    const cat = await writeDb.category.create({
      data: { name: 'Saga Test Category', slug: `saga-cat-${Date.now()}` },
    });
    categoryId = cat.id;
  });

  afterAll(async () => {
    if (writeDb) {
      // Clean up orders first to satisfy foreign keys
      await writeDb.customerOrder.deleteMany({
        where: {
          buyerRef: { in: ['buyer-success-1', 'buyer-fail-1', 'buyer-complete-info'] },
        },
      });
      await writeDb.productListing.deleteMany({
        where: { vendorId: { in: [vendorAId, vendorBId, vendorCId] } },
      });
      await writeDb.vendor.deleteMany({
        where: { id: { in: [vendorAId, vendorBId, vendorCId] } },
      });
      await writeDb.category.delete({ where: { id: categoryId } }).catch(() => {});
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('Multi-vendor success: 3-vendor cart all with sufficient stock results in CONFIRMED order and RESERVED suborders', async () => {
    // Seed 3 listings
    const listingA = await writeDb.productListing.create({
      data: {
        vendorId: vendorAId,
        categoryId,
        sku: `SAGA-OK-A-${Date.now()}`,
        title: 'Item A',
        priceCents: 1000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    const listingB = await writeDb.productListing.create({
      data: {
        vendorId: vendorBId,
        categoryId,
        sku: `SAGA-OK-B-${Date.now()}`,
        title: 'Item B',
        priceCents: 2000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    const listingC = await writeDb.productListing.create({
      data: {
        vendorId: vendorCId,
        categoryId,
        sku: `SAGA-OK-C-${Date.now()}`,
        title: 'Item C',
        priceCents: 3000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    // Place multi-vendor order
    const result = await sagaService.placeOrder('buyer-success-1', [
      { listingId: listingA.id, quantity: 2 },
      { listingId: listingB.id, quantity: 3 },
      { listingId: listingC.id, quantity: 4 },
    ]);

    expect(result.status).toBe('CONFIRMED');
    expect(result.vendorSuborders.length).toBe(3);
    for (const sub of result.vendorSuborders) {
      expect(sub.status).toBe('RESERVED');
    }

    // Verify raw database state for each vendor's inventory
    const invA = await writeDb.inventory.findUnique({ where: { listingId: listingA.id } });
    const invB = await writeDb.inventory.findUnique({ where: { listingId: listingB.id } });
    const invC = await writeDb.inventory.findUnique({ where: { listingId: listingC.id } });

    expect(invA!.reservedQuantity).toBe(2);
    expect(invB!.reservedQuantity).toBe(3);
    expect(invC!.reservedQuantity).toBe(4);
  });

  it('Single-vendor failure triggers full compensation: vendor B fails, vendors A & C are rolled back, all inventory restored', async () => {
    // Seed: A has 10, B has only 1 (requesting 5 -> fail), C has 10
    const listingA = await writeDb.productListing.create({
      data: {
        vendorId: vendorAId,
        categoryId,
        sku: `SAGA-FAIL-A-${Date.now()}`,
        title: 'Item A',
        priceCents: 1000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    const listingB = await writeDb.productListing.create({
      data: {
        vendorId: vendorBId,
        categoryId,
        sku: `SAGA-FAIL-B-${Date.now()}`,
        title: 'Item B (Low Stock)',
        priceCents: 2000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 1, reservedQuantity: 0 } },
      },
    });

    const listingC = await writeDb.productListing.create({
      data: {
        vendorId: vendorCId,
        categoryId,
        sku: `SAGA-FAIL-C-${Date.now()}`,
        title: 'Item C',
        priceCents: 3000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    const result = await sagaService.placeOrder('buyer-fail-1', [
      { listingId: listingA.id, quantity: 2 },
      { listingId: listingB.id, quantity: 5 }, // Will fail!
      { listingId: listingC.id, quantity: 3 },
    ]);

    // Overall order must be FAILED
    expect(result.status).toBe('FAILED');

    // Vendor B suborder must be RESERVATION_FAILED
    const subB = result.vendorSuborders.find((s) => s.vendorId === vendorBId);
    expect(subB!.status).toBe('RESERVATION_FAILED');

    // Vendors A and C suborders must be ROLLED_BACK
    const subA = result.vendorSuborders.find((s) => s.vendorId === vendorAId);
    const subC = result.vendorSuborders.find((s) => s.vendorId === vendorCId);
    expect(subA!.status).toBe('ROLLED_BACK');
    expect(subC!.status).toBe('ROLLED_BACK');

    // CRITICAL: Verify write-side raw inventory rows are strictly restored to 0 reserved
    const invA = await writeDb.inventory.findUnique({ where: { listingId: listingA.id } });
    const invB = await writeDb.inventory.findUnique({ where: { listingId: listingB.id } });
    const invC = await writeDb.inventory.findUnique({ where: { listingId: listingC.id } });

    expect(invA!.reservedQuantity).toBe(0);
    expect(invB!.reservedQuantity).toBe(0);
    expect(invC!.reservedQuantity).toBe(0);

    // Verify saga_steps audit trail
    const steps = await writeDb.sagaStep.findMany({
      where: { customerOrderId: result.customerOrderId },
      orderBy: { occurredAt: 'asc' },
    });

    const stepTypes = steps.map((s) => s.stepType);
    expect(stepTypes).toContain('RESERVE_ATTEMPTED');
    expect(stepTypes).toContain('RESERVE_FAILED');
    expect(stepTypes).toContain('COMPENSATION_ATTEMPTED');
    expect(stepTypes).toContain('COMPENSATION_SUCCEEDED');
  });

  it('Gather complete information: two failing vendors are BOTH attempted without early exit', async () => {
    // Both B and C have insufficient stock
    const listingA = await writeDb.productListing.create({
      data: {
        vendorId: vendorAId,
        categoryId,
        sku: `SAGA-INFO-A-${Date.now()}`,
        title: 'Item A',
        priceCents: 1000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 10, reservedQuantity: 0 } },
      },
    });

    const listingB = await writeDb.productListing.create({
      data: {
        vendorId: vendorBId,
        categoryId,
        sku: `SAGA-INFO-B-${Date.now()}`,
        title: 'Item B',
        priceCents: 2000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 0, reservedQuantity: 0 } }, // 0 stock
      },
    });

    const listingC = await writeDb.productListing.create({
      data: {
        vendorId: vendorCId,
        categoryId,
        sku: `SAGA-INFO-C-${Date.now()}`,
        title: 'Item C',
        priceCents: 3000n,
        status: 'ACTIVE',
        inventory: { create: { onHandQuantity: 0, reservedQuantity: 0 } }, // 0 stock
      },
    });

    const result = await sagaService.placeOrder('buyer-complete-info', [
      { listingId: listingA.id, quantity: 2 },
      { listingId: listingB.id, quantity: 1 },
      { listingId: listingC.id, quantity: 1 },
    ]);

    expect(result.status).toBe('FAILED');

    // Both failing suborders are reported with RESERVATION_FAILED
    const subB = result.vendorSuborders.find((s) => s.vendorId === vendorBId);
    const subC = result.vendorSuborders.find((s) => s.vendorId === vendorCId);
    expect(subB!.status).toBe('RESERVATION_FAILED');
    expect(subC!.status).toBe('RESERVATION_FAILED');

    // Vendor A that succeeded is rolled back (all-or-nothing policy)
    const subA = result.vendorSuborders.find((s) => s.vendorId === vendorAId);
    expect(subA!.status).toBe('ROLLED_BACK');

    const invA = await writeDb.inventory.findUnique({ where: { listingId: listingA.id } });
    expect(invA!.reservedQuantity).toBe(0);
  });
});
