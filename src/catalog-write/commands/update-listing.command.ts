import { ICommand, ICommandHandler, CommandHandler } from '@nestjs/cqrs';
import { WriteDbService } from '../../common/db/write-db.service';
import { ErrListingNotFound, ErrNotYourListing } from '../errors';

export class UpdateListingCommand implements ICommand {
  constructor(
    public readonly listingId: string,
    public readonly actorVendorId: string,
    public readonly title?: string,
    public readonly description?: string,
    public readonly priceCents?: bigint,
    public readonly categoryId?: string,
  ) {}
}

@CommandHandler(UpdateListingCommand)
export class UpdateListingHandler implements ICommandHandler<UpdateListingCommand> {
  constructor(private readonly writeDb: WriteDbService) {}

  async execute(command: UpdateListingCommand) {
    // 1. Verify existence and vendor ownership
    const existing = await this.writeDb.productListing.findUnique({
      where: { id: command.listingId },
    });

    if (!existing) {
      throw new ErrListingNotFound(command.listingId);
    }

    if (existing.vendorId !== command.actorVendorId) {
      throw new ErrNotYourListing(command.listingId, command.actorVendorId);
    }

    // 2. Scoped update query explicitly constrained by WHERE vendor_id = :actorVendorId
    const count = await this.writeDb.productListing.updateMany({
      where: {
        id: command.listingId,
        vendorId: command.actorVendorId,
      },
      data: {
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.description !== undefined ? { description: command.description } : {}),
        ...(command.priceCents !== undefined ? { priceCents: command.priceCents } : {}),
        ...(command.categoryId !== undefined ? { categoryId: command.categoryId } : {}),
        updatedAt: new Date(),
      },
    });

    if (count.count === 0) {
      throw new ErrNotYourListing(command.listingId, command.actorVendorId);
    }

    return this.writeDb.productListing.findUnique({
      where: { id: command.listingId },
    });
  }
}
