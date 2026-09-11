import { AggregateRoot } from '@nestjs/cqrs';
import {
  ListingCreatedEvent,
  ListingUpdatedEvent,
  ListingDelistedEvent,
} from './events';

export class ProductListing extends AggregateRoot {
  constructor(
    public readonly id: string,
    public readonly vendorId: string,
    public categoryId: string,
    public readonly sku: string,
    public title: string,
    public description: string,
    public priceCents: bigint,
    public currency: string = 'USD',
    public status: string = 'DRAFT',
  ) {
    super();
  }

  static create(
    id: string,
    vendorId: string,
    categoryId: string,
    sku: string,
    title: string,
    description: string,
    priceCents: bigint,
    currency: string = 'USD',
    status: string = 'ACTIVE',
  ): ProductListing {
    const listing = new ProductListing(
      id,
      vendorId,
      categoryId,
      sku,
      title,
      description,
      priceCents,
      currency,
      status,
    );
    listing.apply(new ListingCreatedEvent(id, vendorId, sku, priceCents));
    return listing;
  }

  update(
    title?: string,
    description?: string,
    priceCents?: bigint,
    categoryId?: string,
  ): void {
    if (title !== undefined) this.title = title;
    if (description !== undefined) this.description = description;
    if (priceCents !== undefined) this.priceCents = priceCents;
    if (categoryId !== undefined) this.categoryId = categoryId;

    this.apply(new ListingUpdatedEvent(this.id, this.vendorId));
  }

  delist(): void {
    this.status = 'DELISTED';
    this.apply(new ListingDelistedEvent(this.id, this.vendorId));
  }
}
