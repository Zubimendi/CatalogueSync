import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ProjectorDbService } from '../common/db/projector-db.service';
import { RedisService } from '../common/redis/redis.service';

export interface OutboxRow {
  id: bigint;
  entity_type: string;
  entity_id: string;
  vendor_id: string | null;
  operation: string;
  payload: any;
  created_at: Date;
  processed_at: Date | null;
  attempts: number;
  last_error: string | null;
}

@Injectable()
export class OutboxProjectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProjectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;

  constructor(
    private readonly projectorDb: ProjectorDbService,
    private readonly redis: RedisService,
  ) {
    this.pollIntervalMs = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '250', 10);
    this.batchSize = parseInt(process.env.OUTBOX_BATCH_SIZE || '200', 10);
    this.maxAttempts = parseInt(process.env.OUTBOX_MAX_ATTEMPTS || '5', 10);
  }

  onModuleInit() {
    // In dev / test, caller can manually control polling or let it run
    if (process.env.AUTO_START_PROJECTOR === 'true') {
      this.startPolling();
    }
  }

  onModuleDestroy() {
    this.stopPolling();
  }

  startPolling() {
    if (this.timer) return;
    this.logger.log(`Starting OutboxProjector polling every ${this.pollIntervalMs}ms`);
    this.timer = setInterval(() => {
      this.processBatch().catch((err) => {
        this.logger.error(`Error in outbox poll batch: ${err.message}`);
      });
    }, this.pollIntervalMs);
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processBatch(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      // Select batch with FOR UPDATE SKIP LOCKED
      const events: OutboxRow[] = await this.projectorDb.$queryRawUnsafe(
        `SELECT id, entity_type, entity_id, vendor_id, operation, payload,
                created_at, processed_at, attempts, last_error
         FROM outbox_events
         WHERE processed_at IS NULL
           AND attempts < $1
         ORDER BY id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED;`,
        this.maxAttempts,
        this.batchSize,
      );

      if (events.length === 0) {
        return 0;
      }

      for (const event of events) {
        await this.processEvent(event);
      }

      return events.length;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processEvent(event: OutboxRow): Promise<void> {
    try {
      const payload =
        typeof event.payload === 'string'
          ? JSON.parse(event.payload)
          : event.payload;

      let categoryIdToInvalidate: string | null = null;
      let listingIdToInvalidate: string = event.entity_id;

      if (event.entity_type === 'product_listing') {
        if (event.operation === 'DELETE') {
          // Hard delete in DB -> remove from read model
          await this.projectorDb.$executeRawUnsafe(
            `DELETE FROM catalog_listings_view WHERE listing_id = $1::uuid;`,
            event.entity_id,
          );
        } else {
          // INSERT or UPDATE
          // Denormalize vendor and category data via ProjectorDbService
          const vendors: any[] = await this.projectorDb.$queryRawUnsafe(
            `SELECT name, status FROM vendors WHERE id = $1::uuid;`,
            payload.vendor_id,
          );
          const vendor = vendors[0] || { name: 'Unknown', status: 'ACTIVE' };

          const categories: any[] = await this.projectorDb.$queryRawUnsafe(
            `SELECT id, name FROM categories WHERE id = $1::uuid;`,
            payload.category_id,
          );
          const category = categories[0] || { id: payload.category_id, name: 'Uncategorized' };
          categoryIdToInvalidate = category.id;

          const invRows: any[] = await this.projectorDb.$queryRawUnsafe(
            `SELECT on_hand_quantity, reserved_quantity FROM inventory WHERE listing_id = $1::uuid;`,
            payload.id,
          );
          const onHand = invRows[0]?.on_hand_quantity || 0;
          const reserved = invRows[0]?.reserved_quantity || 0;
          const availableQuantity = onHand - reserved;

          await this.projectorDb.$executeRawUnsafe(
            `INSERT INTO catalog_listings_view (
               listing_id, vendor_id, vendor_name, vendor_status,
               category_id, category_name, title, description,
               price_cents, currency, status, available_quantity,
               last_synced_outbox_id, updated_at
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4,
               $5::uuid, $6, $7, $8,
               $9, $10, $11, $12,
               $13, now()
             )
             ON CONFLICT (listing_id) DO UPDATE SET
               vendor_id = EXCLUDED.vendor_id,
               vendor_name = EXCLUDED.vendor_name,
               vendor_status = EXCLUDED.vendor_status,
               category_id = EXCLUDED.category_id,
               category_name = EXCLUDED.category_name,
               title = EXCLUDED.title,
               description = EXCLUDED.description,
               price_cents = EXCLUDED.price_cents,
               currency = EXCLUDED.currency,
               status = EXCLUDED.status,
               available_quantity = EXCLUDED.available_quantity,
               last_synced_outbox_id = EXCLUDED.last_synced_outbox_id,
               updated_at = now();`,
            payload.id,
            payload.vendor_id,
            vendor.name,
            vendor.status,
            category.id,
            category.name,
            payload.title,
            payload.description || '',
            payload.price_cents,
            payload.currency || 'USD',
            payload.status,
            availableQuantity,
            event.id,
          );
        }
      } else if (event.entity_type === 'inventory') {
        const availableQuantity = payload.on_hand_quantity - payload.reserved_quantity;
        listingIdToInvalidate = payload.listing_id;

        const updatedRows = await this.projectorDb.$executeRawUnsafe(
          `UPDATE catalog_listings_view
           SET available_quantity = $1,
               last_synced_outbox_id = $2,
               updated_at = now()
           WHERE listing_id = $3::uuid;`,
          availableQuantity,
          event.id,
          payload.listing_id,
        );

        // If categoryId wasn't known from inventory event, lookup from view for invalidation
        if (updatedRows > 0) {
          const viewRows: any[] = await this.projectorDb.$queryRawUnsafe(
            `SELECT category_id FROM catalog_listings_view WHERE listing_id = $1::uuid;`,
            payload.listing_id,
          );
          if (viewRows[0]) {
            categoryIdToInvalidate = viewRows[0].category_id;
          }
        }
      }

      // Mark outbox row processed
      await this.projectorDb.$executeRawUnsafe(
        `UPDATE outbox_events
         SET processed_at = now(), last_error = NULL
         WHERE id = $1;`,
        event.id,
      );

      // Invalidate Redis cache keys
      await this.redis.del(`catalog:listing:${listingIdToInvalidate}`);
      if (categoryIdToInvalidate) {
        await this.redis.delByPattern(`catalog:category:${categoryIdToInvalidate}:*`);
      }
    } catch (err: any) {
      this.logger.error(
        `Failed processing outbox event ${event.id} (${event.entity_type}): ${err.message}`,
      );
      await this.projectorDb.$executeRawUnsafe(
        `UPDATE outbox_events
         SET attempts = attempts + 1, last_error = $1
         WHERE id = $2;`,
        err.message,
        event.id,
      );
    }
  }

  async getStuckEvents(): Promise<OutboxRow[]> {
    return this.projectorDb.$queryRawUnsafe(
      `SELECT id, entity_type, entity_id, vendor_id, operation, payload,
              created_at, processed_at, attempts, last_error
       FROM outbox_events
       WHERE processed_at IS NULL
         AND attempts >= $1
       ORDER BY id ASC;`,
      this.maxAttempts,
    );
  }

  async getLagSeconds(): Promise<number> {
    const rows: any[] = await this.projectorDb.$queryRawUnsafe(
      `SELECT EXTRACT(EPOCH FROM (now() - created_at)) as lag_seconds
       FROM outbox_events
       WHERE processed_at IS NULL
       ORDER BY id ASC
       LIMIT 1;`,
    );
    return rows.length > 0 ? parseFloat(rows[0].lag_seconds) || 0 : 0;
  }
}
