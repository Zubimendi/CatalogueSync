import { Injectable, Logger } from '@nestjs/common';
import { WriteDbService } from '../common/db/write-db.service';
import {
  ErrEmptyCart,
  ErrListingsSpanTooManyVendors,
  ErrOrderNotFound,
  ErrVendorSuspendedForOrder,
} from './errors';
import { ErrListingNotFound } from '../catalog-write/errors';

export interface PlaceOrderItemDto {
  listingId: string;
  quantity: number;
}

export interface PlaceOrderResult {
  customerOrderId: string;
  buyerRef: string;
  status: 'CONFIRMED' | 'FAILED';
  totalCents: string;
  currency: string;
  vendorSuborders: {
    vendorSuborderId: string;
    vendorId: string;
    status: string;
    subtotalCents: string;
    lineItems: {
      listingId: string;
      quantity: number;
      unitPriceCents: string;
    }[];
    failureReason?: string;
  }[];
}

@Injectable()
export class OrderSagaService {
  private readonly logger = new Logger(OrderSagaService.name);

  constructor(private readonly writeDb: WriteDbService) {}

  async placeOrder(
    buyerRef: string,
    items: PlaceOrderItemDto[],
  ): Promise<PlaceOrderResult> {
    if (!items || items.length === 0) {
      throw new ErrEmptyCart();
    }

    for (const item of items) {
      if (!item.quantity || item.quantity <= 0) {
        throw new Error(`Invalid quantity ${item.quantity} for listing ${item.listingId}`);
      }
    }

    // 1. Fetch listings and vendor details using WriteDbService
    const listingIds = items.map((i) => i.listingId);
    const listings = await this.writeDb.productListing.findMany({
      where: { id: { in: listingIds } },
      include: { vendor: true },
    });

    const listingMap = new Map<string, (typeof listings)[0]>();
    for (const l of listings) {
      listingMap.set(l.id, l);
    }

    for (const item of items) {
      if (!listingMap.has(item.listingId)) {
        throw new ErrListingNotFound(item.listingId);
      }
    }

    // Check vendor active status
    // Per docs/CURSOR_CONTEXT.md §0:
    // Vendor suspension blocks new order placement going forward (checked here).
    // An in-flight saga is not retroactively affected if a vendor is suspended mid-saga.
    for (const l of listings) {
      if (l.vendor.status !== 'ACTIVE') {
        throw new ErrVendorSuspendedForOrder(l.vendorId);
      }
    }

    // Group items by vendor
    const vendorGroups = new Map<
      string,
      { item: PlaceOrderItemDto; listing: (typeof listings)[0] }[]
    >();
    for (const item of items) {
      const listing = listingMap.get(item.listingId)!;
      if (!vendorGroups.has(listing.vendorId)) {
        vendorGroups.set(listing.vendorId, []);
      }
      vendorGroups.get(listing.vendorId)!.push({ item, listing });
    }

    // Sanity check vendor count limit (max 10 vendors)
    if (vendorGroups.size > 10) {
      throw new ErrListingsSpanTooManyVendors(vendorGroups.size, 10);
    }

    // 2. Initial Transaction: create customer_orders, vendor_suborders, and order_line_items
    // Captures unit_price_cents at this exact instant (price snapshotting)
    let totalCents = 0n;
    const vendorSuborderData: {
      vendorId: string;
      subtotalCents: bigint;
      items: { listingId: string; quantity: number; unitPriceCents: bigint }[];
    }[] = [];

    for (const [vId, groupItems] of vendorGroups.entries()) {
      let subtotal = 0n;
      const subItems: { listingId: string; quantity: number; unitPriceCents: bigint }[] = [];
      for (const gi of groupItems) {
        const itemCost = gi.listing.priceCents * BigInt(gi.item.quantity);
        subtotal += itemCost;
        subItems.push({
          listingId: gi.item.listingId,
          quantity: gi.item.quantity,
          unitPriceCents: gi.listing.priceCents,
        });
      }
      totalCents += subtotal;
      vendorSuborderData.push({
        vendorId: vId,
        subtotalCents: subtotal,
        items: subItems,
      });
    }

    const { customerOrder, createdSuborders } = await this.writeDb.$transaction(
      async (tx) => {
        const order = await tx.customerOrder.create({
          data: {
            buyerRef,
            status: 'PENDING',
            totalCents,
            currency: 'USD',
          },
        });

        const createdSubs: any[] = [];
        for (const vsd of vendorSuborderData) {
          const suborder = await tx.vendorSuborder.create({
            data: {
              customerOrderId: order.id,
              vendorId: vsd.vendorId,
              status: 'PENDING_RESERVATION',
              subtotalCents: vsd.subtotalCents,
              lineItems: {
                create: vsd.items.map((i) => ({
                  listingId: i.listingId,
                  quantity: i.quantity,
                  unitPriceCents: i.unitPriceCents,
                })),
              },
            },
            include: { lineItems: true },
          });
          createdSubs.push(suborder);
        }

        return { customerOrder: order, createdSuborders: createdSubs };
      },
    );

    // 3. For EVERY vendor_suborder, attempt reservation in its OWN separate transaction.
    // Per docs/ARCHITECTURE.md §5: never one shared transaction across vendors.
    // Per docs/ARCHITECTURE.md §7: never stop at first failure; attempt every vendor.
    const suborderResults: {
      suborder: any;
      success: boolean;
      failureReason?: string;
    }[] = [];

    for (const suborder of createdSuborders) {
      // Record RESERVE_ATTEMPTED step
      await this.recordSagaStep(
        customerOrder.id,
        suborder.id,
        'RESERVE_ATTEMPTED',
        { vendorId: suborder.vendorId, itemCount: suborder.lineItems.length },
      );

      // Attempt reservations for all line items belonging to this vendor
      const successfullyReservedItems: { listingId: string; quantity: number }[] = [];
      let suborderFailed = false;
      let failureReason: string | undefined;

      for (const lineItem of suborder.lineItems) {
        const reserved = await this.writeDb.reserveStock(
          lineItem.listingId,
          lineItem.quantity,
        );

        if (reserved) {
          successfullyReservedItems.push({
            listingId: lineItem.listingId,
            quantity: lineItem.quantity,
          });
        } else {
          suborderFailed = true;
          failureReason = `Insufficient stock for listing ${lineItem.listingId} (requested ${lineItem.quantity})`;
          break;
        }
      }

      if (suborderFailed) {
        // Compensate any partial reservations made within this suborder
        for (const item of successfullyReservedItems) {
          await this.writeDb.releaseStock(item.listingId, item.quantity);
        }

        // Update suborder status in its own transaction
        await this.writeDb.vendorSuborder.update({
          where: { id: suborder.id },
          data: { status: 'RESERVATION_FAILED', updatedAt: new Date() },
        });

        await this.recordSagaStep(
          customerOrder.id,
          suborder.id,
          'RESERVE_FAILED',
          { vendorId: suborder.vendorId, reason: failureReason },
        );

        suborderResults.push({
          suborder,
          success: false,
          failureReason,
        });
      } else {
        // Success for this suborder
        await this.writeDb.vendorSuborder.update({
          where: { id: suborder.id },
          data: { status: 'RESERVED', updatedAt: new Date() },
        });

        await this.recordSagaStep(
          customerOrder.id,
          suborder.id,
          'RESERVE_SUCCEEDED',
          { vendorId: suborder.vendorId },
        );

        suborderResults.push({
          suborder,
          success: true,
        });
      }
    }

    // 4. Decision: Did every suborder succeed?
    const allSucceeded = suborderResults.every((r) => r.success);

    if (allSucceeded) {
      // 4. All suborders reserved -> Confirm customer order
      await this.writeDb.customerOrder.update({
        where: { id: customerOrder.id },
        data: { status: 'CONFIRMED', updatedAt: new Date() },
      });

      return {
        customerOrderId: customerOrder.id,
        buyerRef,
        status: 'CONFIRMED',
        totalCents: customerOrder.totalCents.toString(),
        currency: customerOrder.currency,
        vendorSuborders: suborderResults.map((r) => ({
          vendorSuborderId: r.suborder.id,
          vendorId: r.suborder.vendorId,
          status: 'RESERVED',
          subtotalCents: r.suborder.subtotalCents.toString(),
          lineItems: r.suborder.lineItems.map((li: any) => ({
            listingId: li.listingId,
            quantity: li.quantity,
            unitPriceCents: li.unitPriceCents.toString(),
          })),
        })),
      };
    } else {
      // 5. At least one suborder failed -> Compensate every suborder that reached RESERVED
      // Each compensation happens in its own separate transaction
      for (const res of suborderResults) {
        if (res.success) {
          // Record COMPENSATION_ATTEMPTED
          await this.recordSagaStep(
            customerOrder.id,
            res.suborder.id,
            'COMPENSATION_ATTEMPTED',
            { vendorId: res.suborder.vendorId },
          );

          // Release reservations
          for (const lineItem of res.suborder.lineItems) {
            await this.writeDb.releaseStock(
              lineItem.listingId,
              lineItem.quantity,
            );
          }

          // Mark suborder ROLLED_BACK
          await this.writeDb.vendorSuborder.update({
            where: { id: res.suborder.id },
            data: { status: 'ROLLED_BACK', updatedAt: new Date() },
          });

          // Record COMPENSATION_SUCCEEDED
          await this.recordSagaStep(
            customerOrder.id,
            res.suborder.id,
            'COMPENSATION_SUCCEEDED',
            { vendorId: res.suborder.vendorId },
          );
        }
      }

      // Mark customer order FAILED
      await this.writeDb.customerOrder.update({
        where: { id: customerOrder.id },
        data: { status: 'FAILED', updatedAt: new Date() },
      });

      return {
        customerOrderId: customerOrder.id,
        buyerRef,
        status: 'FAILED',
        totalCents: customerOrder.totalCents.toString(),
        currency: customerOrder.currency,
        vendorSuborders: suborderResults.map((r) => ({
          vendorSuborderId: r.suborder.id,
          vendorId: r.suborder.vendorId,
          status: r.success ? 'ROLLED_BACK' : 'RESERVATION_FAILED',
          subtotalCents: r.suborder.subtotalCents.toString(),
          lineItems: r.suborder.lineItems.map((li: any) => ({
            listingId: li.listingId,
            quantity: li.quantity,
            unitPriceCents: li.unitPriceCents.toString(),
          })),
          failureReason: r.failureReason,
        })),
      };
    }
  }

  async getOrder(orderId: string) {
    const order = await this.writeDb.customerOrder.findUnique({
      where: { id: orderId },
      include: {
        vendorSuborders: {
          include: { lineItems: true },
        },
        sagaSteps: {
          orderBy: { occurredAt: 'asc' },
        },
      },
    });

    if (!order) {
      throw new ErrOrderNotFound(orderId);
    }

    return {
      ...order,
      totalCents: order.totalCents.toString(),
      vendorSuborders: order.vendorSuborders.map((vs) => ({
        ...vs,
        subtotalCents: vs.subtotalCents.toString(),
        lineItems: vs.lineItems.map((li) => ({
          ...li,
          unitPriceCents: li.unitPriceCents.toString(),
        })),
      })),
      sagaSteps: order.sagaSteps.map((step) => ({
        ...step,
        id: step.id.toString(),
      })),
    };
  }

  private async recordSagaStep(
    customerOrderId: string,
    vendorSuborderId: string | null,
    stepType: string,
    detail: any,
  ): Promise<void> {
    await this.writeDb.sagaStep.create({
      data: {
        customerOrderId,
        vendorSuborderId,
        stepType,
        detail,
      },
    });
  }
}
