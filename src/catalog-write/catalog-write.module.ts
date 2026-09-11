import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AuthModule } from '../auth/auth.module';
import { CatalogWriteController } from './catalog-write.controller';
import { CreateListingHandler } from './commands/create-listing.command';
import { UpdateListingHandler } from './commands/update-listing.command';
import { DelistListingHandler } from './commands/delist-listing.command';
import { AdjustStockHandler } from './commands/adjust-stock.command';
import { ReserveStockHandler } from './commands/reserve-stock.command';
import { ReleaseStockHandler } from './commands/release-stock.command';

export const CommandHandlers = [
  CreateListingHandler,
  UpdateListingHandler,
  DelistListingHandler,
  AdjustStockHandler,
  ReserveStockHandler,
  ReleaseStockHandler,
];

@Module({
  imports: [CqrsModule, AuthModule],
  controllers: [CatalogWriteController],
  providers: [...CommandHandlers],
  exports: [...CommandHandlers],
})
export class CatalogWriteModule {}
