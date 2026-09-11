import { AuthService } from './auth.service';

describe('AuthService (HMAC Token Signing & Verification)', () => {
  let authService: AuthService;

  beforeEach(() => {
    process.env.ACTOR_TOKEN_SECRET = 'super-secret-test-key';
    authService = new AuthService();
  });

  it('issues and verifies a vendor actor token', () => {
    const token = authService.issueToken({
      actorId: 'actor-123',
      vendorId: 'vendor-abc',
      roles: ['vendor'],
    });

    expect(typeof token).toBe('string');
    expect(token).toContain('.');

    const claims = authService.verifyToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.actorId).toBe('actor-123');
    expect(claims!.vendorId).toBe('vendor-abc');
    expect(claims!.roles).toEqual(['vendor']);
  });

  it('issues and verifies a buyer token without vendorId', () => {
    const token = authService.issueToken({
      actorId: 'buyer-999',
      roles: ['buyer'],
    });

    const claims = authService.verifyToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.actorId).toBe('buyer-999');
    expect(claims!.vendorId).toBeUndefined();
  });

  it('rejects tampered token signature', () => {
    const token = authService.issueToken({
      actorId: 'actor-123',
      roles: ['buyer'],
    });

    const [payload, signature] = token.split('.');
    const tamperedToken = `${payload}.${signature}tampered`;

    expect(authService.verifyToken(tamperedToken)).toBeNull();
  });

  it('rejects malformed token strings', () => {
    expect(authService.verifyToken('')).toBeNull();
    expect(authService.verifyToken('invalid')).toBeNull();
    expect(authService.verifyToken('part1.part2.part3')).toBeNull();
  });
});
