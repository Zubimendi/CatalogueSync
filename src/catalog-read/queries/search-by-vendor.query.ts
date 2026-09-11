import { IQuery, IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ReadDbService } from '../../common/db/read-db.service';
import { CatalogCacheService } from '../catalog-cache.service';

export class SearchListingsByVendorQuery implements IQuery {
  constructor(
    public readonly vendorId: string,
    public readonly page: number = 1,
    public readonly limit: number = 20,
  ) {}
}

@QueryHandler(SearchListingsByVendorQuery)
export class SearchListingsByVendorHandler
  implements IQueryHandler<SearchListingsByVendorQuery>
{
  constructor(
    private readonly readDb: ReadDbService,
    private readonly cache: CatalogCacheService,
  ) {}

  async execute(query: SearchListingsByVendorQuery) {
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const skip = (page - 1) * limit;

    const cacheKey = this.cache.getVendorBrowseKey(query.vendorId, page, limit);
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const where = {
      vendorId: query.vendorId,
      status: 'ACTIVE',
    };

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

    await this.cache.set(cacheKey, result);
    return result;
  }
}
