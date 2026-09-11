import { ICommand, ICommandHandler, CommandHandler } from '@nestjs/cqrs';
import { WriteDbService } from '../../common/db/write-db.service';
import { ErrVendorSuspended } from '../errors';

export class CreateListingCommand implements ICommand {
  constructor(
    public readonly vendorId: string,
    public readonly categoryId: string,
    public readonly sku: string,
    public readonly title: string,
    public readonly description: string,
    public readonly priceCents: bigint,
    public readonly currency: string = 'USD',
    public readonly initialOnHandQuantity: number = 0,
  ) {}
}

@CommandHandler(CreateListingCommand)
export class CreateListingHandler implements ICommandHandler<CreateListingCommand> {
  constructor(private readonly writeDb: WriteDbService) {}

  async execute(command: CreateListingCommand) {
    // 1. Verify vendor is ACTIVE
    // Per CURSOR_CONTEXT.md §0 / §5: vendor suspension blocks creating new listings
    const vendor = await this.writeDb.vendor.findUnique({
      where: { id: command.vendorId },
    });
    if (!vendor || vendor.status !== 'ACTIVE') {
      throw new ErrVendorSuspended(command.vendorId);
    }

    // 2. In one transaction, create listing and initial inventory row
    return this.writeDb.$transaction(async (tx) => {
      const listing = await tx.productListing.create({
        data: {
          vendorId: command.vendorId,
          categoryId: command.categoryId,
          sku: command.sku,
          title: command.title,
          description: command.description,
          priceCents: command.priceCents,
          currency: command.currency,
          status: 'ACTIVE',
        },
      });

      const inventory = await tx.inventory.create({
        data: {
          listingId: listing.id,
          onHandQuantity: command.initialOnHandQuantity,
          reservedQuantity: 0,
        },
      });

      return { listing, inventory };
    });
  }
}
