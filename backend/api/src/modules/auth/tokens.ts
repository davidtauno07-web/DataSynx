import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';

const secret = () => new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims {
  sub: string;
  email: string;
  workspaceId: string;
  role: string;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ email: claims.email, workspaceId: claims.workspaceId, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('datasynx')
    .setAudience('datasynx-api')
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secret(), {
    issuer: 'datasynx',
    audience: 'datasynx-api',
  });
  if (!payload.sub || typeof payload.email !== 'string' || typeof payload.workspaceId !== 'string') {
    throw new Error('Malformed access token');
  }
  return {
    sub: payload.sub,
    email: payload.email,
    workspaceId: payload.workspaceId,
    role: typeof payload.role === 'string' ? payload.role : 'MEMBER',
  };
}

/** Converts strings like `30d`, `15m`, `12h` into milliseconds. */
export function ttlToMs(ttl: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(ttl.trim());
  if (!m) throw new Error(`Unsupported TTL: ${ttl}`);
  const value = Number(m[1]);
  const unit = m[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return value * factors[unit];
}
