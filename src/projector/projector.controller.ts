import { Controller, Get } from '@nestjs/common';
import { OutboxProjectorService } from './outbox-projector.service';

@Controller('internal/outbox')
export class ProjectorController {
  constructor(private readonly projectorService: OutboxProjectorService) {}

  @Get('stuck')
  async getStuckEvents() {
    const stuck = await this.projectorService.getStuckEvents();
    // Serialize bigints safely
    return stuck.map((row) => ({
      ...row,
      id: row.id.toString(),
    }));
  }
}
