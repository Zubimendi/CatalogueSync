import { Module } from '@nestjs/common';
import { OutboxProjectorService } from './outbox-projector.service';
import { ProjectorController } from './projector.controller';

@Module({
  controllers: [ProjectorController],
  providers: [OutboxProjectorService],
  exports: [OutboxProjectorService],
})
export class ProjectorModule {}
