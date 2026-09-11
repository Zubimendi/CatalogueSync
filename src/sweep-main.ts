import { NestFactory } from '@nestjs/core';
import { Module, Logger } from '@nestjs/common';
import { CommonDbModule } from './common/db/common-db.module';
import { OrderingModule } from './ordering/ordering.module';
import { SagaReconciliationService } from './ordering/saga-reconciliation.service';

@Module({
  imports: [CommonDbModule, OrderingModule],
})
class StandaloneSweepModule {}

async function bootstrap() {
  const logger = new Logger('SweepWorker');
  logger.log('Starting standalone Saga Reconciliation Sweep worker...');

  const app = await NestFactory.createApplicationContext(StandaloneSweepModule);
  app.enableShutdownHooks();

  const sweepService = app.get(SagaReconciliationService);
  sweepService.startSweep();

  logger.log('Saga Reconciliation Sweep worker is active.');
}

bootstrap();
