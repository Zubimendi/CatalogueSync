import { ProductListing } from './product-listing.aggregate';

describe('ProductListing Aggregate', () => {
  it('creates listing with initial status ACTIVE and applies ListingCreatedEvent', () => {
    const listing = ProductListing.create(
      'list-1',
      'vendor-1',
      'cat-1',
      'SKU-TEST',
      'Ergonomic Mouse',
      'Wireless mouse',
      4999n,
      'USD',
      'ACTIVE',
    );

    expect(listing.id).toBe('list-1');
    expect(listing.vendorId).toBe('vendor-1');
    expect(listing.title).toBe('Ergonomic Mouse');
    expect(listing.priceCents).toBe(4999n);
    expect(listing.status).toBe('ACTIVE');

    const events = listing.getUncommittedEvents();
    expect(events.length).toBe(1);
  });

  it('updates title, price, description and applies ListingUpdatedEvent', () => {
    const listing = ProductListing.create(
      'list-2',
      'vendor-1',
      'cat-1',
      'SKU-2',
      'Old Title',
      '',
      1000n,
    );

    listing.update('New Title', 'New Description', 1500n);
    expect(listing.title).toBe('New Title');
    expect(listing.description).toBe('New Description');
    expect(listing.priceCents).toBe(1500n);
  });

  it('delists a listing and sets status to DELISTED', () => {
    const listing = ProductListing.create(
      'list-3',
      'vendor-1',
      'cat-1',
      'SKU-3',
      'Delist Me',
      '',
      2000n,
    );

    listing.delist();
    expect(listing.status).toBe('DELISTED');
  });
});
