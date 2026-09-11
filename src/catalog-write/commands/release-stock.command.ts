import { ICommand, ICommandHandler, CommandHandler } from '@nestjs/cqrs';
import { WriteDbService } from '../../common/db/write-db.service';

export class ReleaseStockCommand implements ICommand {
  constructor(
    public readonly listingId: string,
    public readonly quantity: number,
  ) {}
}

@CommandHandler(ReleaseStockCommand)
export class ReleaseStockHandler implements ICommandHandler<ReleaseStockCommand> {
  constructor(private readonly writeDb: WriteDbService) {}

  async execute(command: ReleaseStockCommand) {
    if (command.quantity <= 0) {
      throw new Error('Release quantity must be greater than zero');
    }

    const released = await this.writeDb.releaseStock(
      command.listingId,
      command.quantity,
    );

    if (!released) {
      throw new Error(
        `Failed to release ${command.quantity} units for listing '${command.listingId}': accounting mismatch or insufficient reserved quantity`,
      );
    }

    return {
      success: true,
      listingId: command.listingId,
      quantity: command.quantity,
    };
  }
}
