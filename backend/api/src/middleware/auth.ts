import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../modules/auth/tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessTokenClaims;
  }
}

export const ACCESS_COOKIE = 'dsx_access';
export const REFRESH_COOKIE = 'dsx_refresh';

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.cookies?.[ACCESS_COOKIE];
  return typeof cookie === 'string' ? cookie : undefined;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) return next(unauthorized());
  try {
    req.auth = await verifyAccessToken(token);
    next();
  } catch {
    next(unauthorized('Session expired'));
  }
}

/** Narrowing helper so route handlers never have to assert on req.auth. */
export function authOf(req: Request): AccessTokenClaims {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
