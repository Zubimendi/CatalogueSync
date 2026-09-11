import { Controller, Get, Param, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { BrowseListingsQuery } from './queries/browse-listings.query';
import { GetListingQuery } from './queries/get-listing.query';
import { SearchListingsByVendorQuery } from './queries/search-by-vendor.query';

@Controller('v1/catalog')
export class CatalogReadController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get()
  async browseListings(
    @Query('category') categoryId?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.queryBus.execute(
      new BrowseListingsQuery(
        categoryId,
        minPrice ? BigInt(minPrice) : undefined,
        maxPrice ? BigInt(maxPrice) : undefined,
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 20,
      ),
    );
  }

  @Get(':id')
  async getListing(@Param('id') id: string) {
    return this.queryBus.execute(new GetListingQuery(id));
  }

  @Get('vendor/:vendorId')
  async getByVendor(
    @Param('vendorId') vendorId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.queryBus.execute(
      new SearchListingsByVendorQuery(
        vendorId,
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 20,
      ),
    );
  }
}
