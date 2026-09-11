import { IQuery, IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { ReadDbService } from '../../common/db/read-db.service';
import { CatalogCacheService } from '../catalog-cache.service';

export class GetListingQuery implements IQuery {
  constructor(public readonly listingId: string) {}
}

@QueryHandler(GetListingQuery)
export class GetListingHandler implements IQueryHandler<GetListingQuery> {
  constructor(
    private readonly readDb: ReadDbService,
    private readonly cache: CatalogCacheService,
  ) {}

  async execute(query: GetListingQuery) {
    const cacheKey = this.cache.getListingKey(query.listingId);
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const listing = await this.readDb.catalogListingsView.findUnique({
      where: { listingId: query.listingId },
    });

    if (!listing) {
      throw new NotFoundException(`Listing '${query.listingId}' not found in catalog`);
    }

    const result = {
      ...listing,
      priceCents: listing.priceCents.toString(),
      lastSyncedOutboxId: listing.lastSyncedOutboxId.toString(),
    };

    await this.cache.set(cacheKey, result);
    return result;
  }
}
