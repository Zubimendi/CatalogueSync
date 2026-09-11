import {
  Controller,
  Post,
  Patch,
  Get,
  Param,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { VendorsService } from './vendors.service';

export class CreateVendorDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;
}

export class UpdateVendorStatusDto {
  @IsString()
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status: 'ACTIVE' | 'SUSPENDED';
}

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;
}

@Controller('v1')
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Post('vendors')
  async createVendor(@Body() dto: CreateVendorDto) {
    return this.vendorsService.createVendor(dto.name, dto.slug);
  }

  @Patch('vendors/:id')
  async updateVendorStatus(
    @Param('id') id: string,
    @Body() dto: UpdateVendorStatusDto,
  ) {
    return this.vendorsService.updateVendorStatus(id, dto.status);
  }

  @Get('vendors/:id')
  async getVendor(@Param('id') id: string) {
    return this.vendorsService.getVendor(id);
  }

  @Post('categories')
  async createCategory(@Body() dto: CreateCategoryDto) {
    return this.vendorsService.createCategory(dto.name, dto.slug);
  }

  @Get('categories')
  async getCategories() {
    return this.vendorsService.getCategories();
  }
}
