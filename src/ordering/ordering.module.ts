import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { OrderSagaService } from './order-saga.service';
import { SagaReconciliationService } from './saga-reconciliation.service';
import { OrderingController } from './ordering.controller';

@Module({
  imports: [CqrsModule],
  controllers: [OrderingController],
  providers: [OrderSagaService, SagaReconciliationService],
  exports: [OrderSagaService, SagaReconciliationService],
})
export class OrderingModule {}
