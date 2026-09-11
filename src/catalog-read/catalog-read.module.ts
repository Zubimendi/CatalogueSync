import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { CatalogCacheService } from './catalog-cache.service';
import { CatalogReadController } from './catalog-read.controller';
import { BrowseListingsHandler } from './queries/browse-listings.query';
import { GetListingHandler } from './queries/get-listing.query';
import { SearchListingsByVendorHandler } from './queries/search-by-vendor.query';

export const QueryHandlers = [
  BrowseListingsHandler,
  GetListingHandler,
  SearchListingsByVendorHandler,
];

@Module({
  imports: [CqrsModule],
  controllers: [CatalogReadController],
  providers: [CatalogCacheService, ...QueryHandlers],
  exports: [CatalogCacheService, ...QueryHandlers],
})
export class CatalogReadModule {}
