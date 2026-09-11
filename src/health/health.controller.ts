import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { WriteDbService } from '../common/db/write-db.service';
import { ReadDbService } from '../common/db/read-db.service';
import { ProjectorDbService } from '../common/db/projector-db.service';
import { RedisService } from '../common/redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly writeDb: WriteDbService,
    private readonly readDb: ReadDbService,
    private readonly projectorDb: ProjectorDbService,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  live() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready(@Res() res: Response) {
    const checks: Record<string, { status: 'up' | 'down'; error?: string }> = {};
    let allHealthy = true;

    // 1. Check catalogsync_write
    try {
      await this.writeDb.$queryRawUnsafe('SELECT 1;');
      checks.catalogsync_write = { status: 'up' };
    } catch (err: any) {
      allHealthy = false;
      checks.catalogsync_write = { status: 'down', error: err.message };
    }

    // 2. Check catalogsync_read
    try {
      await this.readDb.$queryRawUnsafe('SELECT 1;');
      checks.catalogsync_read = { status: 'up' };
    } catch (err: any) {
      allHealthy = false;
      checks.catalogsync_read = { status: 'down', error: err.message };
    }

    // 3. Check catalogsync_projector
    try {
      await this.projectorDb.$queryRawUnsafe('SELECT 1;');
      checks.catalogsync_projector = { status: 'up' };
    } catch (err: any) {
      allHealthy = false;
      checks.catalogsync_projector = { status: 'down', error: err.message };
    }

    // 4. Check Redis
    const redisOk = await this.redis.ping();
    if (redisOk) {
      checks.redis = { status: 'up' };
    } else {
      allHealthy = false;
      checks.redis = { status: 'down', error: 'Redis PING failed' };
    }

    const statusCode = allHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    return res.status(statusCode).json({
      status: allHealthy ? 'ready' : 'unhealthy',
      components: checks,
      timestamp: new Date().toISOString(),
    });
  }
}
