import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { WriteDbService } from '../../src/common/db/write-db.service';
import { AuthService } from '../../src/auth/auth.service';
import { OutboxProjectorService } from '../../src/projector/outbox-projector.service';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

describe('End-to-End Flow (Test §8)', () => {
  let app: INestApplication;
  let writeDb: WriteDbService;
  let authService: AuthService;
  let projectorService: OutboxProjectorService;

  let vendor1Id: string;
  let vendor2Id: string;
  let categoryId: string;
  let token1: string;
  let token2: string;
  let listing1Id: string;
  let listing2Id: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    writeDb = app.get<WriteDbService>(WriteDbService);
    authService = app.get<AuthService>(AuthService);
    projectorService = app.get<OutboxProjectorService>(OutboxProjectorService);
  });

  afterAll(async () => {
    if (writeDb) {
      await writeDb.customerOrder.deleteMany({
        where: { buyerRef: 'e2e-buyer-flow' },
      });
      if (vendor1Id || vendor2Id) {
        await writeDb.productListing.deleteMany({
          where: { vendorId: { in: [vendor1Id, vendor2Id].filter(Boolean) } },
        });
        await writeDb.vendor.deleteMany({
          where: { id: { in: [vendor1Id, vendor2Id].filter(Boolean) } },
        });
      }
      if (categoryId) {
        await writeDb.category.delete({ where: { id: categoryId } }).catch(() => {});
      }
    }
    if (app) {
      await app.close();
    }
  });

  it('1. GET /health/ready reports all three database roles and Redis as healthy', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(res.body.status).toBe('ready');
    expect(res.body.components.catalogsync_write.status).toBe('up');
    expect(res.body.components.catalogsync_read.status).toBe('up');
    expect(res.body.components.catalogsync_projector.status).toBe('up');
    expect(res.body.components.redis.status).toBe('up');
  });

  it('2. Create vendors and categories via HTTP API', async () => {
    // Create Vendor 1
    const v1Res = await request(app.getHttpServer())
      .post('/v1/vendors')
      .send({ name: 'E2E Vendor 1', slug: `e2e-v1-${Date.now()}` })
      .expect(201);
    vendor1Id = v1Res.body.id;

    // Create Vendor 2
    const v2Res = await request(app.getHttpServer())
      .post('/v1/vendors')
      .send({ name: 'E2E Vendor 2', slug: `e2e-v2-${Date.now()}` })
      .expect(201);
    vendor2Id = v2Res.body.id;

    // Create Category
    const catRes = await request(app.getHttpServer())
      .post('/v1/categories')
      .send({ name: 'E2E Audio Gear', slug: `e2e-audio-${Date.now()}` })
      .expect(201);
    categoryId = catRes.body.id;

    // Generate vendor actor tokens
    token1 = authService.issueToken({ actorId: 'actor-1', vendorId: vendor1Id, roles: ['vendor'] });
    token2 = authService.issueToken({ actorId: 'actor-2', vendorId: vendor2Id, roles: ['vendor'] });
  });

  it('3. Vendors create listings via POST /v1/listings and projector syncs to read model', async () => {
    // Vendor 1 creates Listing 1
    const l1Res = await request(app.getHttpServer())
      .post('/v1/listings')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        categoryId,
        sku: `E2E-L1-${Date.now()}`,
        title: 'Studio Monitor Speakers',
        priceCents: 19999,
        currency: 'USD',
        initialOnHandQuantity: 10,
      })
      .expect(201);
    listing1Id = l1Res.body.listing.id;

    // Vendor 2 creates Listing 2
    const l2Res = await request(app.getHttpServer())
      .post('/v1/listings')
      .set('Authorization', `Bearer ${token2}`)
      .send({
        categoryId,
        sku: `E2E-L2-${Date.now()}`,
        title: 'Studio Microphone',
        priceCents: 9999,
        currency: 'USD',
        initialOnHandQuantity: 20,
      })
      .expect(201);
    listing2Id = l2Res.body.listing.id;

    // Run projector batch to sync write-side tables to catalog_listings_view
    await projectorService.processBatch();

    // Verify both listings appear in browse read-model
    const browseRes = await request(app.getHttpServer())
      .get(`/v1/catalog?category=${categoryId}`)
      .expect(200);

    expect(browseRes.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('4. Buyer places multi-vendor order via POST /v1/orders and stock updates in read model', async () => {
    // Place multi-vendor order
    const orderRes = await request(app.getHttpServer())
      .post('/v1/orders')
      .send({
        buyerRef: 'e2e-buyer-flow',
        items: [
          { listingId: listing1Id, quantity: 2 },
          { listingId: listing2Id, quantity: 3 },
        ],
      })
      .expect(201);

    expect(orderRes.body.status).toBe('CONFIRMED');
    expect(orderRes.body.vendorSuborders.length).toBe(2);

    // Sync outbox events from reservations to read model
    await projectorService.processBatch();

    // Verify updated available_quantity in catalog read model
    const l1View = await request(app.getHttpServer())
      .get(`/v1/catalog/${listing1Id}`)
      .expect(200);
    expect(l1View.body.availableQuantity).toBe(8); // 10 - 2

    const l2View = await request(app.getHttpServer())
      .get(`/v1/catalog/${listing2Id}`)
      .expect(200);
    expect(l2View.body.availableQuantity).toBe(17); // 20 - 3
  });

  it('5. GET /metrics returns prometheus metrics', async () => {
    const res = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(res.text).toContain('catalogsync_reservations_total');
    expect(res.text).toContain('catalogsync_sagas_total');
  });
});
