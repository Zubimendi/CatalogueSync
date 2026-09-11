import { Global, Module } from '@nestjs/common';
import { WriteDbService } from './write-db.service';
import { ReadDbService } from './read-db.service';
import { ProjectorDbService } from './projector-db.service';

@Global()
@Module({
  providers: [WriteDbService, ReadDbService, ProjectorDbService],
  exports: [WriteDbService, ReadDbService, ProjectorDbService],
})
export class CommonDbModule {}
