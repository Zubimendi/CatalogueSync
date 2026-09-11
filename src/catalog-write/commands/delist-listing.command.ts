import { ICommand, ICommandHandler, CommandHandler } from '@nestjs/cqrs';
import { WriteDbService } from '../../common/db/write-db.service';
import { ErrListingNotFound, ErrNotYourListing } from '../errors';

export class DelistListingCommand implements ICommand {
  constructor(
    public readonly listingId: string,
    public readonly actorVendorId: string,
  ) {}
}

@CommandHandler(DelistListingCommand)
export class DelistListingHandler implements ICommandHandler<DelistListingCommand> {
  constructor(private readonly writeDb: WriteDbService) {}

  async execute(command: DelistListingCommand) {
    const existing = await this.writeDb.productListing.findUnique({
      where: { id: command.listingId },
    });

    if (!existing) {
      throw new ErrListingNotFound(command.listingId);
    }

    if (existing.vendorId !== command.actorVendorId) {
      throw new ErrNotYourListing(command.listingId, command.actorVendorId);
    }

    await this.writeDb.productListing.updateMany({
      where: {
        id: command.listingId,
        vendorId: command.actorVendorId,
      },
      data: {
        status: 'DELISTED',
        updatedAt: new Date(),
      },
    });

    return { listingId: command.listingId, status: 'DELISTED' };
  }
}
