export class StockReservedEvent {
  constructor(
    public readonly listingId: string,
    public readonly quantity: number,
    public readonly onHandQuantity: number,
    public readonly reservedQuantity: number,
  ) {}
}

export class StockReleasedEvent {
  constructor(
    public readonly listingId: string,
    public readonly quantity: number,
    public readonly onHandQuantity: number,
    public readonly reservedQuantity: number,
  ) {}
}

export class StockAdjustedEvent {
  constructor(
    public readonly listingId: string,
    public readonly onHandQuantity: number,
  ) {}
}

export class ListingCreatedEvent {
  constructor(
    public readonly listingId: string,
    public readonly vendorId: string,
    public readonly sku: string,
    public readonly priceCents: bigint,
  ) {}
}

export class ListingUpdatedEvent {
  constructor(
    public readonly listingId: string,
    public readonly vendorId: string,
  ) {}
}

export class ListingDelistedEvent {
  constructor(
    public readonly listingId: string,
    public readonly vendorId: string,
  ) {}
}
