import { HttpException, HttpStatus } from '@nestjs/common';

export class ErrListingNotFound extends HttpException {
  constructor(listingId: string) {
    super(`Listing '${listingId}' not found`, HttpStatus.NOT_FOUND);
  }
}

export class ErrNotYourListing extends HttpException {
  constructor(listingId: string, vendorId: string) {
    super(`Listing '${listingId}' does not belong to vendor '${vendorId}'`, HttpStatus.FORBIDDEN);
  }
}

export class ErrInsufficientStock extends HttpException {
  constructor(listingId: string, requested: number) {
    super(`Insufficient stock for listing '${listingId}': requested ${requested}`, HttpStatus.CONFLICT);
  }
}

export class ErrVendorSuspended extends HttpException {
  constructor(vendorId: string) {
    super(`Vendor '${vendorId}' is suspended`, HttpStatus.FORBIDDEN);
  }
}
