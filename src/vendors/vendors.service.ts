import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { WriteDbService } from '../common/db/write-db.service';

@Injectable()
export class VendorsService {
  constructor(private readonly writeDb: WriteDbService) {}

  async createVendor(name: string, slug: string) {
    const existing = await this.writeDb.vendor.findUnique({
      where: { slug },
    });
    if (existing) {
      throw new ConflictException(`Vendor with slug '${slug}' already exists`);
    }

    return this.writeDb.vendor.create({
      data: {
        name,
        slug,
        status: 'ACTIVE',
      },
    });
  }

  async updateVendorStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    const existing = await this.writeDb.vendor.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Vendor '${id}' not found`);
    }

    return this.writeDb.vendor.update({
      where: { id },
      data: { status },
    });
  }

  async getVendor(id: string) {
    const vendor = await this.writeDb.vendor.findUnique({
      where: { id },
    });
    if (!vendor) {
      throw new NotFoundException(`Vendor '${id}' not found`);
    }
    return vendor;
  }

  async createCategory(name: string, slug: string) {
    const existing = await this.writeDb.category.findUnique({
      where: { slug },
    });
    if (existing) {
      throw new ConflictException(`Category with slug '${slug}' already exists`);
    }

    return this.writeDb.category.create({
      data: { name, slug },
    });
  }

  async getCategories() {
    return this.writeDb.category.findMany();
  }
}
