import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry = new client.Registry();

  public readonly reservationCounter: client.Counter<string>;
  public readonly sagaCounter: client.Counter<string>;
  public readonly outboxLagGauge: client.Gauge<string>;
  public readonly cacheCounter: client.Counter<string>;

  constructor() {
    client.collectDefaultMetrics({ register: this.registry });

    this.reservationCounter = new client.Counter({
      name: 'catalogsync_reservations_total',
      help: 'Total inventory reservation attempts by outcome',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.sagaCounter = new client.Counter({
      name: 'catalogsync_sagas_total',
      help: 'Total multi-vendor sagas executed by final outcome',
      labelNames: ['outcome'], // 'confirmed' | 'compensated_inline' | 'compensated_sweep'
      registers: [this.registry],
    });

    this.outboxLagGauge = new client.Gauge({
      name: 'catalogsync_outbox_lag_seconds',
      help: 'Age in seconds of the oldest unprocessed outbox event',
      registers: [this.registry],
    });

    this.cacheCounter = new client.Counter({
      name: 'catalogsync_cache_requests_total',
      help: 'Total read-model cache lookups by hit/miss',
      labelNames: ['hit'], // 'true' | 'false'
      registers: [this.registry],
    });
  }

  onModuleInit() {}

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
