import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ReadDbService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadDbService.name);

  constructor() {
    super({
      datasources: {
        db: {
          url:
            process.env.DATABASE_URL_READ ||
            'postgres://catalogsync_read:catalogsync_read_dev_password@localhost:5432/catalogsync',
        },
      },
      log: process.env.NODE_ENV === 'test' ? [] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('ReadDbService connected (role: catalogsync_read)');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
