import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ProjectorDbService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectorDbService.name);

  constructor() {
    super({
      datasources: {
        db: {
          url:
            process.env.DATABASE_URL_PROJECTOR ||
            'postgres://catalogsync_projector:catalogsync_projector_dev_password@localhost:5432/catalogsync',
        },
      },
      log: process.env.NODE_ENV === 'test' ? [] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('ProjectorDbService connected (role: catalogsync_projector)');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
