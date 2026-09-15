import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { env, googleOAuthConfigured } from '../../config/env.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { randomToken, safeEqual } from '../../lib/crypto.js';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, authOf, requireAuth } from '../../middleware/auth.js';
import { authLimiter, resetLimiter } from '../../middleware/rateLimit.js';
import { recordAudit, requestContext } from '../audit/service.js';
import { buildAuthUrl, exchangeCode } from './google.js';
import { passwordSchema } from './password.js';
import * as service from './service.js';
import { ttlToMs } from './tokens.js';

const OAUTH_STATE_COOKIE = 'dsx_oauth_state';

const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax',
  path: '/',
});

function setAuthCookies(res: Response, result: service.AuthResult): void {
  res.cookie(ACCESS_COOKIE, result.accessToken, {
    ...baseCookie(),
    maxAge: ttlToMs(env.JWT_ACCESS_TTL),
  });
  res.cookie(REFRESH_COOKIE, result.refreshToken, {
    ...baseCookie(),
    path: '/api/auth',
    expires: result.refreshExpiresAt,
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, baseCookie());
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: '/api/auth' });
}

const publicResult = (r: service.AuthResult) => ({
  user: r.user,
  workspaceId: r.workspaceId,
  accessToken: r.accessToken,
});

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({ googleEnabled: googleOAuthConfigured(), mode: env.DATASYNX_MODE });
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  password: passwordSchema,
});

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const result = await service.register(input, requestContext(req));
    setAuthCookies(res, result);
    await recordAudit({
      ...requestContext(req),
      workspaceId: result.workspaceId,
      userId: result.user.id,
      action: 'auth.register',
      entityType: 'User',
      entityId: result.user.id,
    });
    res.status(201).json(publicResult(result));
  }),
);

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await service.login(input, requestContext(req));
    setAuthCookies(res, result);
    await recordAudit({
      ...requestContext(req),
      workspaceId: result.workspaceId,
      userId: result.user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: result.user.id,
    });
    res.json(publicResult(result));
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
    if (typeof token !== 'string' || !token) throw unauthorized('No refresh token supplied');
    const result = await service.refresh(token, requestContext(req));
    setAuthCookies(res, result);
    res.json(publicResult(result));
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await service.logout(req.cookies?.[REFRESH_COOKIE]);
    clearAuthCookies(res);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const user = await prisma.user.findUnique({
      where: { id: auth.sub },
      select: { id: true, email: true, name: true, provider: true, createdAt: true },
    });
    if (!user) throw unauthorized();
    const workspace = await prisma.workspace.findUnique({
      where: { id: auth.workspaceId },
      select: { id: true, name: true, slug: true },
    });
    res.json({ user, workspace, role: auth.role, mode: env.DATASYNX_MODE });
  }),
);

authRouter.post(
  '/password/forgot',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().trim().email() }).parse(req.body);
    const result = await service.requestPasswordReset(email);
    // Response is intentionally identical whether or not the account exists.
    res.json({ ok: true, ...result });
  }),
);

authRouter.post(
  '/password/reset',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const input = z.object({ token: z.string().min(10), password: passwordSchema }).parse(req.body);
    await service.resetPassword(input.token, input.password);
    clearAuthCookies(res);
    res.json({ ok: true });
  }),
);

// --- Google OAuth ----------------------------------------------------------

authRouter.get(
  '/google',
  authLimiter,
  asyncHandler(async (req, res) => {
    const state = randomToken(16);
    res.cookie(OAUTH_STATE_COOKIE, state, { ...baseCookie(), maxAge: 10 * 60 * 1000 });
    res.redirect(buildAuthUrl(state));
  }),
);

authRouter.get(
  '/google/callback',
  authLimiter,
  asyncHandler(async (req, res) => {
    const query = z
      .object({ code: z.string().min(1).optional(), state: z.string().min(1).optional(), error: z.string().optional() })
      .parse(req.query);

    if (query.error) throw unauthorized(`Google sign-in failed: ${query.error}`);
    const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
    if (!query.code || !query.state || typeof cookieState !== 'string' || !safeEqual(cookieState, query.state)) {
      throw badRequest('Invalid OAuth state');
    }
    res.clearCookie(OAUTH_STATE_COOKIE, baseCookie());

    const profile = await exchangeCode(query.code);
    const result = await service.loginWithGoogle(profile, requestContext(req));
    setAuthCookies(res, result);
    await recordAudit({
      ...requestContext(req),
      workspaceId: result.workspaceId,
      userId: result.user.id,
      action: 'auth.login.google',
      entityType: 'User',
      entityId: result.user.id,
    });
    res.redirect(`${env.WEB_PUBLIC_URL}/auth/callback`);
  }),
);
