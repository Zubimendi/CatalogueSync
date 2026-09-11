import { Module } from '@nestjs/common';
import { CommonDbModule } from './common/db/common-db.module';
import { RedisModule } from './common/redis/redis.module';
import { CatalogWriteModule } from './catalog-write/catalog-write.module';
import { CatalogReadModule } from './catalog-read/catalog-read.module';
import { ProjectorModule } from './projector/projector.module';
import { OrderingModule } from './ordering/ordering.module';
import { VendorsModule } from './vendors/vendors.module';
import { AuthModule } from './auth/auth.module';
import { ObservabilityModule } from './observability/observability.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    CommonDbModule,
    RedisModule,
    CatalogWriteModule,
    CatalogReadModule,
    ProjectorModule,
    OrderingModule,
    VendorsModule,
    AuthModule,
    ObservabilityModule,
    HealthModule,
  ],
})
export class AppModule {}
