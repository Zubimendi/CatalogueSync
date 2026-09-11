import { AggregateRoot } from '@nestjs/cqrs';
import {
  StockReservedEvent,
  StockReleasedEvent,
  StockAdjustedEvent,
} from './events';
import { ErrInsufficientStock } from '../errors';

export class Inventory extends AggregateRoot {
  constructor(
    public readonly listingId: string,
    public onHandQuantity: number,
    public reservedQuantity: number,
  ) {
    super();
  }

  get availableQuantity(): number {
    return this.onHandQuantity - this.reservedQuantity;
  }

  reserve(qty: number): void {
    if (qty <= 0) {
      throw new Error('Quantity to reserve must be greater than zero');
    }
    if (this.availableQuantity < qty) {
      throw new ErrInsufficientStock(this.listingId, qty);
    }
    this.reservedQuantity += qty;
    this.apply(
      new StockReservedEvent(
        this.listingId,
        qty,
        this.onHandQuantity,
        this.reservedQuantity,
      ),
    );
  }

  release(qty: number): void {
    if (qty <= 0) {
      throw new Error('Quantity to release must be greater than zero');
    }
    if (this.reservedQuantity < qty) {
      throw new Error(
        `Cannot release ${qty} units: only ${this.reservedQuantity} currently reserved`,
      );
    }
    this.reservedQuantity -= qty;
    this.apply(
      new StockReleasedEvent(
        this.listingId,
        qty,
        this.onHandQuantity,
        this.reservedQuantity,
      ),
    );
  }

  adjustOnHand(newCount: number): void {
    if (newCount < 0) {
      throw new Error('On-hand quantity cannot be negative');
    }
    if (newCount < this.reservedQuantity) {
      throw new Error(
        `Cannot set on-hand count to ${newCount}: lower than reserved quantity ${this.reservedQuantity}`,
      );
    }
    this.onHandQuantity = newCount;
    this.apply(new StockAdjustedEvent(this.listingId, newCount));
  }
}
