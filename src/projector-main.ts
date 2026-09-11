import { NestFactory } from '@nestjs/core';
import { Module, Logger } from '@nestjs/common';
import { CommonDbModule } from './common/db/common-db.module';
import { RedisModule } from './common/redis/redis.module';
import { ProjectorModule } from './projector/projector.module';
import { OutboxProjectorService } from './projector/outbox-projector.service';

@Module({
  imports: [CommonDbModule, RedisModule, ProjectorModule],
})
class StandaloneProjectorModule {}

async function bootstrap() {
  const logger = new Logger('ProjectorWorker');
  logger.log('Starting standalone Outbox Projector worker...');

  const app = await NestFactory.createApplicationContext(StandaloneProjectorModule);
  app.enableShutdownHooks();

  const projectorService = app.get(OutboxProjectorService);
  projectorService.startPolling();

  logger.log('Outbox Projector worker is active and polling.');
}

bootstrap();
