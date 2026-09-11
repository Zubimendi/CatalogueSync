import { CatalogCacheService } from './catalog-cache.service';
import { RedisService } from '../common/redis/redis.service';

describe('CatalogCacheService', () => {
  let cacheService: CatalogCacheService;
  let mockRedis: Partial<RedisService>;

  beforeEach(() => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };
    cacheService = new CatalogCacheService(mockRedis as RedisService);
  });

  it('generates consistent deterministic cache keys', () => {
    expect(cacheService.getListingKey('list-123')).toBe('catalog:listing:list-123');
    expect(
      cacheService.getCategoryBrowseKey('cat-456', 1, 20, 1000n, 5000n),
    ).toBe('catalog:category:cat-456:page:1:limit:20:min:1000:max:5000');
    expect(cacheService.getVendorBrowseKey('ven-789', 2, 10)).toBe(
      'catalog:vendor:ven-789:page:2:limit:10',
    );
  });

  it('gets parsed cached value from redis', async () => {
    (mockRedis.get as jest.Mock).mockResolvedValue(JSON.stringify({ title: 'Cached Item' }));
    const result = await cacheService.get<any>('some-key');
    expect(result).toEqual({ title: 'Cached Item' });
  });

  it('safely serializes BigInt values when setting cache', async () => {
    await cacheService.set('some-key', { priceCents: 1500n });
    expect(mockRedis.set).toHaveBeenCalledWith(
      'some-key',
      JSON.stringify({ priceCents: '1500' }),
      60,
    );
  });
});
