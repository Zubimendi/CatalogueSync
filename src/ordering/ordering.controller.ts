import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { IsString, IsNotEmpty, IsArray, ValidateNested, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderSagaService } from './order-saga.service';

export class OrderItemDto {
  @IsString()
  @IsNotEmpty()
  listingId: string;

  @IsNumber()
  @Min(1)
  quantity: number;
}

export class PlaceOrderDto {
  @IsString()
  @IsNotEmpty()
  buyerRef: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}

@Controller('v1/orders')
export class OrderingController {
  constructor(private readonly sagaService: OrderSagaService) {}

  @Post()
  async placeOrder(@Body() dto: PlaceOrderDto) {
    return this.sagaService.placeOrder(dto.buyerRef, dto.items);
  }

  @Get(':id')
  async getOrder(@Param('id') id: string) {
    return this.sagaService.getOrder(id);
  }
}
