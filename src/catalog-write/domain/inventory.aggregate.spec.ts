import { Inventory } from './inventory.aggregate';
import { ErrInsufficientStock } from '../errors';

describe('Inventory Aggregate', () => {
  it('correctly computes availableQuantity', () => {
    const inv = new Inventory('listing-1', 20, 5);
    expect(inv.availableQuantity).toBe(15);
  });

  it('reserves stock when sufficient and applies StockReservedEvent', () => {
    const inv = new Inventory('listing-1', 10, 0);
    inv.reserve(4);
    expect(inv.reservedQuantity).toBe(4);
    expect(inv.availableQuantity).toBe(6);

    const events = inv.getUncommittedEvents();
    expect(events.length).toBe(1);
    expect((events[0] as any).quantity).toBe(4);
  });

  it('throws ErrInsufficientStock when reservation exceeds available stock', () => {
    const inv = new Inventory('listing-1', 5, 2); // available = 3
    expect(() => inv.reserve(4)).toThrow(ErrInsufficientStock);
  });

  it('releases reserved stock and applies StockReleasedEvent', () => {
    const inv = new Inventory('listing-1', 10, 6);
    inv.release(4);
    expect(inv.reservedQuantity).toBe(2);
    expect(inv.availableQuantity).toBe(8);

    const events = inv.getUncommittedEvents();
    expect(events.length).toBe(1);
  });

  it('throws error when release exceeds current reservations', () => {
    const inv = new Inventory('listing-1', 10, 2);
    expect(() => inv.release(3)).toThrow(/Cannot release 3 units/);
  });

  it('adjusts physical on-hand stock and ensures count >= reservedQuantity', () => {
    const inv = new Inventory('listing-1', 10, 4);
    inv.adjustOnHand(15);
    expect(inv.onHandQuantity).toBe(15);
    expect(inv.availableQuantity).toBe(11);

    expect(() => inv.adjustOnHand(3)).toThrow(/lower than reserved quantity/);
  });
});
