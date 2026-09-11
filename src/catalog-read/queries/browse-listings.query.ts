import { IQuery, IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ReadDbService } from '../../common/db/read-db.service';
import { CatalogCacheService } from '../catalog-cache.service';

export class BrowseListingsQuery implements IQuery {
  constructor(
    public readonly categoryId?: string,
    public readonly minPriceCents?: bigint,
    public readonly maxPriceCents?: bigint,
    public readonly page: number = 1,
    public readonly limit: number = 20,
  ) {}
}

@QueryHandler(BrowseListingsQuery)
export class BrowseListingsHandler implements IQueryHandler<BrowseListingsQuery> {
  constructor(
    private readonly readDb: ReadDbService,
    private readonly cache: CatalogCacheService,
  ) {}

  async execute(query: BrowseListingsQuery) {
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const skip = (page - 1) * limit;

    let cacheKey: string | null = null;
    if (query.categoryId) {
      cacheKey = this.cache.getCategoryBrowseKey(
        query.categoryId,
        page,
        limit,
        query.minPriceCents,
        query.maxPriceCents,
      );
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const where: any = {
      status: 'ACTIVE',
    };

    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }

    if (query.minPriceCents !== undefined || query.maxPriceCents !== undefined) {
      where.priceCents = {};
      if (query.minPriceCents !== undefined) where.priceCents.gte = query.minPriceCents;
      if (query.maxPriceCents !== undefined) where.priceCents.lte = query.maxPriceCents;
    }

    const [items, total] = await Promise.all([
      this.readDb.catalogListingsView.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
      }),
      this.readDb.catalogListingsView.count({ where }),
    ]);

    const result = {
      items: items.map((item) => ({
        ...item,
        priceCents: item.priceCents.toString(),
        lastSyncedOutboxId: item.lastSyncedOutboxId.toString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    if (cacheKey) {
      await this.cache.set(cacheKey, result);
    }

    return result;
  }
}
