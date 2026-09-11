/**
 * SAGA RECONCILIATION SERVICE
 * ----------------------------
 * The correctness backstop for crashed or interrupted saga coordinators.
 * (docs/ARCHITECTURE.md §8 & docs/CURSOR_CONTEXT.md §6)
 *
 * NOTE ON VENDOR SUSPENSION (docs/CURSOR_CONTEXT.md §0):
 * SagaReconciliationService does NOT check vendors.status when compensating stuck orders.
 * Per PRD §7 resolution: a vendor suspension blocks new listings/orders going forward,
 * but does not retroactively reach into in-flight sagas. The sweep resolves stuck orders
 * solely on timeout and held reservations, releasing stock to its pre-saga state.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { WriteDbService } from '../common/db/write-db.service';

@Injectable()
export class SagaReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SagaReconciliationService.name);
  private timer: NodeJS.Timeout | null = null;
  private isSweeping = false;

  readonly timeoutSeconds: number;
  readonly sweepIntervalMs: number;

  constructor(private readonly writeDb: WriteDbService) {
    this.timeoutSeconds = parseInt(process.env.SAGA_TIMEOUT_SECONDS || '120', 10);
    this.sweepIntervalMs = parseInt(process.env.SAGA_SWEEP_INTERVAL_MS || '15000', 10);
  }

  onModuleInit() {
    if (process.env.AUTO_START_SWEEP === 'true') {
      this.startSweep();
    }
  }

  onModuleDestroy() {
    this.stopSweep();
  }

  startSweep() {
    if (this.timer) return;
    this.logger.log(
      `Starting SagaReconciliationService sweep every ${this.sweepIntervalMs}ms (timeout: ${this.timeoutSeconds}s)`,
    );
    this.timer = setInterval(() => {
      this.sweepStuckOrders().catch((err) => {
        this.logger.error(`Error during saga sweep pass: ${err.message}`);
      });
    }, this.sweepIntervalMs);
  }

  stopSweep() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweepStuckOrders(timeoutOverrideSeconds?: number): Promise<number> {
    if (this.isSweeping) return 0;
    this.isSweeping = true;

    try {
      const timeoutSec = timeoutOverrideSeconds ?? this.timeoutSeconds;
      const cutoffTime = new Date(Date.now() - timeoutSec * 1000);

      // Find PENDING orders older than timeout
      const stuckOrders = await this.writeDb.customerOrder.findMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: cutoffTime },
        },
        include: {
          vendorSuborders: {
            include: { lineItems: true },
          },
        },
      });

      if (stuckOrders.length === 0) {
        return 0;
      }

      this.logger.warn(`Saga sweep found ${stuckOrders.length} stuck PENDING orders`);

      for (const order of stuckOrders) {
        await this.compensateStuckOrder(order);
      }

      return stuckOrders.length;
    } finally {
      this.isSweeping = false;
    }
  }

  private async compensateStuckOrder(order: any): Promise<void> {
    for (const suborder of order.vendorSuborders) {
      if (
        suborder.status === 'PENDING_RESERVATION' ||
        suborder.status === 'RESERVED'
      ) {
        // If it actually reached RESERVED, release the held stock
        if (suborder.status === 'RESERVED') {
          for (const lineItem of suborder.lineItems) {
            await this.writeDb.releaseStock(
              lineItem.listingId,
              lineItem.quantity,
            );
          }
        }

        // Transition suborder to ROLLED_BACK
        await this.writeDb.vendorSuborder.update({
          where: { id: suborder.id },
          data: { status: 'ROLLED_BACK', updatedAt: new Date() },
        });

        // Record SWEEP_COMPENSATED (distinct from COMPENSATION_SUCCEEDED per docs/ARCHITECTURE.md §12)
        await this.writeDb.sagaStep.create({
          data: {
            customerOrderId: order.id,
            vendorSuborderId: suborder.id,
            stepType: 'SWEEP_COMPENSATED',
            detail: {
              previousStatus: suborder.status,
              vendorId: suborder.vendorId,
              reason: 'Reconciliation sweep: coordinator timeout expired',
            },
          },
        });
      }
    }

    // Set order to terminal FAILED state
    await this.writeDb.customerOrder.update({
      where: { id: order.id },
      data: { status: 'FAILED', updatedAt: new Date() },
    });

    this.logger.log(`Saga sweep successfully compensated stuck order ${order.id}`);
  }
}
