import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class WriteDbService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WriteDbService.name);

  constructor() {
    super({
      datasources: {
        db: {
          url:
            process.env.DATABASE_URL_WRITE ||
            'postgres://catalogsync_write:catalogsync_write_dev_password@localhost:5432/catalogsync',
        },
      },
      log: process.env.NODE_ENV === 'test' ? [] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('WriteDbService connected (role: catalogsync_write)');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Atomic stock reservation via a single conditional update.
   * Per docs/ARCHITECTURE.md §2:
   * Computed availability: (on_hand_quantity - reserved_quantity) >= qty.
   * Returns true if 1 row updated; false if 0 rows (insufficient stock or listing missing).
   */
  async reserveStock(listingId: string, quantity: number): Promise<boolean> {
    const result: any[] = await this.$queryRawUnsafe(
      `UPDATE inventory
       SET reserved_quantity = reserved_quantity + $1, updated_at = now()
       WHERE listing_id = $2::uuid
         AND (on_hand_quantity - reserved_quantity) >= $1
       RETURNING listing_id;`,
      quantity,
      listingId,
    );
    return result.length > 0;
  }

  /**
   * Atomic stock release via a single conditional update.
   * Per docs/ARCHITECTURE.md §2:
   * Decrements reserved_quantity if reserved_quantity >= qty.
   * Returns true if 1 row updated; false if 0 rows (accounting mismatch).
   */
  async releaseStock(listingId: string, quantity: number): Promise<boolean> {
    const result: any[] = await this.$queryRawUnsafe(
      `UPDATE inventory
       SET reserved_quantity = reserved_quantity - $1, updated_at = now()
       WHERE listing_id = $2::uuid
         AND reserved_quantity >= $1
       RETURNING listing_id;`,
      quantity,
      listingId,
    );
    return result.length > 0;
  }
}
