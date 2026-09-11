import { ICommand, ICommandHandler, CommandHandler } from '@nestjs/cqrs';
import { WriteDbService } from '../../common/db/write-db.service';
import { ErrListingNotFound, ErrNotYourListing } from '../errors';

/**
 * AdjustStockCommand represents a vendor reporting an authoritative physical
 * warehouse stock count.
 * Semantics: Absolute set with CAS safety bounds.
 * Concurrency implication: Sets on_hand_quantity = newCount, but strictly
 * guards that newCount >= reserved_quantity so existing order reservations
 * are never retroactively violated.
 */
export class AdjustStockCommand implements ICommand {
  constructor(
    public readonly listingId: string,
    public readonly actorVendorId: string,
    public readonly newOnHandQuantity: number,
  ) {}
}

@CommandHandler(AdjustStockCommand)
export class AdjustStockHandler implements ICommandHandler<AdjustStockCommand> {
  constructor(private readonly writeDb: WriteDbService) {}

  async execute(command: AdjustStockCommand) {
    if (command.newOnHandQuantity < 0) {
      throw new Error('On-hand quantity cannot be negative');
    }

    const listing = await this.writeDb.productListing.findUnique({
      where: { id: command.listingId },
      include: { inventory: true },
    });

    if (!listing) {
      throw new ErrListingNotFound(command.listingId);
    }

    if (listing.vendorId !== command.actorVendorId) {
      throw new ErrNotYourListing(command.listingId, command.actorVendorId);
    }

    if (!listing.inventory) {
      throw new Error(`Inventory record missing for listing '${command.listingId}'`);
    }

    if (command.newOnHandQuantity < listing.inventory.reservedQuantity) {
      throw new Error(
        `Cannot adjust on-hand stock to ${command.newOnHandQuantity}: ` +
        `lower than current reserved quantity of ${listing.inventory.reservedQuantity}`,
      );
    }

    // Atomic update
    const result: any[] = await this.writeDb.$queryRawUnsafe(
      `UPDATE inventory
       SET on_hand_quantity = $1, updated_at = now()
       WHERE listing_id = $2::uuid
         AND $1 >= reserved_quantity
       RETURNING listing_id, on_hand_quantity, reserved_quantity;`,
      command.newOnHandQuantity,
      command.listingId,
    );

    if (result.length === 0) {
      throw new Error('Stock adjustment failed concurrent bounds check');
    }

    return {
      listingId: command.listingId,
      onHandQuantity: result[0].on_hand_quantity,
      reservedQuantity: result[0].reserved_quantity,
      availableQuantity: result[0].on_hand_quantity - result[0].reserved_quantity,
    };
  }
}
