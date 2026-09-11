/**
 * CATALOG CACHE SERVICE
 * ---------------------
 * Cache-aside layer in front of the read model (catalog_listings_view).
 *
 * CRITICAL ARCHITECTURAL GUARANTEE (docs/ARCHITECTURE.md §10 & docs/CURSOR_CONTEXT.md §4):
 * This cache is NEVER consulted by anything in src/catalog-write or src/ordering.
 * Available stock for reservations is NEVER read from here — it is always computed
 * live against the authoritative write-side inventory table.
 *
 * Self-check:
 * grep -r "CatalogCacheService" src/catalog-write src/ordering
 * must return zero occurrences.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class CatalogCacheService {
  private readonly logger = new Logger(CatalogCacheService.name);
  private readonly ttlSeconds: number;

  constructor(private readonly redis: RedisService) {
    this.ttlSeconds = parseInt(process.env.CATALOG_CACHE_TTL_SECONDS || '60', 10);
  }

  getListingKey(id: string): string {
    return `catalog:listing:${id}`;
  }

  getCategoryBrowseKey(
    categoryId: string,
    page: number,
    limit: number,
    minPrice?: bigint,
    maxPrice?: bigint,
  ): string {
    return `catalog:category:${categoryId}:page:${page}:limit:${limit}:min:${minPrice?.toString() || ''}:max:${maxPrice?.toString() || ''}`;
  }

  getVendorBrowseKey(vendorId: string, page: number, limit: number): string {
    return `catalog:vendor:${vendorId}:page:${page}:limit:${limit}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err: any) {
      this.logger.warn(`Failed parsing cached value for key '${key}': ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      // Custom replacer to handle BigInt values if present
      const serialized = JSON.stringify(value, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      await this.redis.set(key, serialized, ttlSeconds || this.ttlSeconds);
    } catch (err: any) {
      this.logger.warn(`Failed serializing value for cache key '${key}': ${err.message}`);
    }
  }
}
