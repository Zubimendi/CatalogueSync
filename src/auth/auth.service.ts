import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

export interface ActorClaims {
  actorId: string;
  vendorId?: string;
  roles: string[];
}

@Injectable()
export class AuthService {
  private readonly secret: string;

  constructor() {
    this.secret = process.env.ACTOR_TOKEN_SECRET || 'dev-secret-change-me';
  }

  issueToken(claims: ActorClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  verifyToken(token: string): ActorClaims | null {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payload, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);

    if (sigBuffer.length !== expectedBuffer.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return null;
    }

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!decoded.actorId || !Array.isArray(decoded.roles)) {
        return null;
      }
      return decoded as ActorClaims;
    } catch {
      return null;
    }
  }
}
