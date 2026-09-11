import { HttpException, HttpStatus } from '@nestjs/common';

export class ErrEmptyCart extends HttpException {
  constructor() {
    super('Cart cannot be empty', HttpStatus.BAD_REQUEST);
  }
}

export class ErrListingsSpanTooManyVendors extends HttpException {
  constructor(vendorCount: number, maxAllowed: number = 10) {
    super(
      `Order spans ${vendorCount} vendors, exceeding maximum allowed of ${maxAllowed}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export class ErrOrderNotFound extends HttpException {
  constructor(orderId: string) {
    super(`Order '${orderId}' not found`, HttpStatus.NOT_FOUND);
  }
}

export class ErrVendorSuspendedForOrder extends HttpException {
  constructor(vendorId: string) {
    super(
      `Cannot place order: vendor '${vendorId}' is suspended`,
      HttpStatus.FORBIDDEN,
    );
  }
}
