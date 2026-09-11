import { ICommand, ICommandHandler, CommandHandler } from '@nestjs/cqrs';
import { WriteDbService } from '../../common/db/write-db.service';
import { ErrInsufficientStock, ErrListingNotFound } from '../errors';

export class ReserveStockCommand implements ICommand {
  constructor(
    public readonly listingId: string,
    public readonly quantity: number,
  ) {}
}

@CommandHandler(ReserveStockCommand)
export class ReserveStockHandler implements ICommandHandler<ReserveStockCommand> {
  constructor(private readonly writeDb: WriteDbService) {}

  async execute(command: ReserveStockCommand) {
    if (command.quantity <= 0) {
      throw new Error('Reservation quantity must be greater than zero');
    }

    const reserved = await this.writeDb.reserveStock(
      command.listingId,
      command.quantity,
    );

    if (!reserved) {
      // Check if listing actually exists to produce accurate error
      const listing = await this.writeDb.productListing.findUnique({
        where: { id: command.listingId },
      });
      if (!listing) {
        throw new ErrListingNotFound(command.listingId);
      }
      throw new ErrInsufficientStock(command.listingId, command.quantity);
    }

    return {
      success: true,
      listingId: command.listingId,
      quantity: command.quantity,
    };
  }
}
