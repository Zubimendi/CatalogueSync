import {
  Controller,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { IsString, IsNotEmpty, IsOptional, IsNumber, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Actor } from '../auth/actor.decorator';
import { ActorClaims } from '../auth/auth.service';
import { CreateListingCommand } from './commands/create-listing.command';
import { UpdateListingCommand } from './commands/update-listing.command';
import { DelistListingCommand } from './commands/delist-listing.command';
import { AdjustStockCommand } from './commands/adjust-stock.command';

export class CreateListingDto {
  @IsString()
  @IsNotEmpty()
  categoryId: string;

  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  priceCents: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  initialOnHandQuantity?: number;
}

export class UpdateListingDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  priceCents?: number;

  @IsString()
  @IsOptional()
  categoryId?: string;
}

export class AdjustStockDto {
  @IsNumber()
  @Min(0)
  onHandQuantity: number;
}

@Controller('v1/listings')
export class CatalogWriteController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  @UseGuards(AuthGuard)
  async createListing(
    @Actor() actor: ActorClaims,
    @Body() dto: CreateListingDto,
  ) {
    if (!actor?.vendorId) {
      throw new UnauthorizedException('Vendor token required to create listing');
    }

    return this.commandBus.execute(
      new CreateListingCommand(
        actor.vendorId,
        dto.categoryId,
        dto.sku,
        dto.title,
        dto.description || '',
        BigInt(dto.priceCents),
        dto.currency || 'USD',
        dto.initialOnHandQuantity || 0,
      ),
    );
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  async updateListing(
    @Param('id') listingId: string,
    @Actor() actor: ActorClaims,
    @Body() dto: UpdateListingDto,
  ) {
    if (!actor?.vendorId) {
      throw new UnauthorizedException('Vendor token required to update listing');
    }

    return this.commandBus.execute(
      new UpdateListingCommand(
        listingId,
        actor.vendorId,
        dto.title,
        dto.description,
        dto.priceCents !== undefined ? BigInt(dto.priceCents) : undefined,
        dto.categoryId,
      ),
    );
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async delistListing(
    @Param('id') listingId: string,
    @Actor() actor: ActorClaims,
  ) {
    if (!actor?.vendorId) {
      throw new UnauthorizedException('Vendor token required to delist listing');
    }

    return this.commandBus.execute(
      new DelistListingCommand(listingId, actor.vendorId),
    );
  }

  @Post(':id/adjust-stock')
  @UseGuards(AuthGuard)
  async adjustStock(
    @Param('id') listingId: string,
    @Actor() actor: ActorClaims,
    @Body() dto: AdjustStockDto,
  ) {
    if (!actor?.vendorId) {
      throw new UnauthorizedException('Vendor token required to adjust stock');
    }

    return this.commandBus.execute(
      new AdjustStockCommand(listingId, actor.vendorId, dto.onHandQuantity),
    );
  }
}
