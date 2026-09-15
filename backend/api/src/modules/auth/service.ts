import type { AuthProvider, Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { conflict, unauthorized } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { hashPassword, verifyPassword } from './password.js';
import { signAccessToken, ttlToMs } from './tokens.js';

export interface SessionContext {
  ip?: string;
  userAgent?: string;
}

export interface AuthResult {
  user: Pick<User, 'id' | 'email' | 'name' | 'provider'>;
  workspaceId: string;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'workspace';

async function ensureWorkspace(tx: Prisma.TransactionClient, user: User): Promise<string> {
  const existing = await tx.workspaceMember.findFirst({ where: { userId: user.id } });
  if (existing) return existing.workspaceId;

  const base = slugify(`${user.name}-workspace`);
  let slug = base;
  for (let i = 1; await tx.workspace.findUnique({ where: { slug } }); i += 1) slug = `${base}-${i}`;

  const workspace = await tx.workspace.create({
    data: {
      name: `${user.name}'s Workspace`,
      slug,
      members: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  return workspace.id;
}

async function issueSession(
  userId: string,
  ctx: SessionContext,
): Promise<{ refreshToken: string; expiresAt: Date }> {
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL));
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(refreshToken),
      expiresAt,
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 400),
    },
  });
  return { refreshToken, expiresAt };
}

async function buildAuthResult(user: User, workspaceId: string, ctx: SessionContext): Promise<AuthResult> {
  const member = await prisma.workspaceMember.findFirst({ where: { userId: user.id, workspaceId } });
  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    workspaceId,
    role: member?.role ?? 'MEMBER',
  });
  const { refreshToken, expiresAt } = await issueSession(user.id, ctx);
  return {
    user: { id: user.id, email: user.email, name: user.name, provider: user.provider },
    workspaceId,
    accessToken,
    refreshToken,
    refreshExpiresAt: expiresAt,
  };
}

export async function register(
  input: { name: string; email: string; password: string },
  ctx: SessionContext,
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('An account with this email already exists');

  const passwordHash = await hashPassword(input.password);
  const { user, workspaceId } = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email, name: input.name.trim(), passwordHash, provider: 'PASSWORD' },
    });
    const ws = await ensureWorkspace(tx, created);
    return { user: created, workspaceId: ws };
  });

  return buildAuthResult(user, workspaceId, ctx);
}

export async function login(
  input: { email: string; password: string },
  ctx: SessionContext,
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  // Always run a verification to keep timing uniform for unknown accounts.
  const hash = user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';
  const ok = await verifyPassword(hash, input.password);
  if (!user || !user.passwordHash || !ok) throw unauthorized('Invalid email or password');

  const workspaceId = await prisma.$transaction((tx) => ensureWorkspace(tx, user));
  return buildAuthResult(user, workspaceId, ctx);
}

export async function loginWithGoogle(
  profile: { googleId: string; email: string; name: string },
  ctx: SessionContext,
): Promise<AuthResult> {
  const email = profile.email.trim().toLowerCase();
  const user = await prisma.$transaction(async (tx) => {
    const byGoogle = await tx.user.findUnique({ where: { googleId: profile.googleId } });
    if (byGoogle) return byGoogle;
    const byEmail = await tx.user.findUnique({ where: { email } });
    if (byEmail) {
      // Link the Google identity to the existing local account.
      return tx.user.update({
        where: { id: byEmail.id },
        data: { googleId: profile.googleId, emailVerified: true },
      });
    }
    return tx.user.create({
      data: {
        email,
        name: profile.name || email.split('@')[0] || 'DataSynx User',
        googleId: profile.googleId,
        provider: 'GOOGLE' as AuthProvider,
        emailVerified: true,
      },
    });
  });

  const workspaceId = await prisma.$transaction((tx) => ensureWorkspace(tx, user));
  return buildAuthResult(user, workspaceId, ctx);
}

export async function refresh(refreshToken: string, ctx: SessionContext): Promise<AuthResult> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(refreshToken) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthorized('Session expired, please sign in again');
  }
  // Rotate: the presented token is retired as soon as it is exchanged.
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  const workspaceId = await prisma.$transaction((tx) => ensureWorkspace(tx, session.user));
  return buildAuthResult(session.user, workspaceId, ctx);
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await prisma.session.updateMany({
    where: { tokenHash: sha256Hex(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Always resolves successfully so the endpoint cannot be used to enumerate
 * registered addresses. The token is only returned for local development where
 * no mail transport is configured.
 */
export async function requestPasswordReset(emailInput: string): Promise<{ token?: string }> {
  const email = emailInput.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return {};
  const token = randomToken(32);
  await prisma.passwordReset.create({
    data: {
      userId: user.id,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return env.NODE_ENV === 'production' ? {} : { token };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const reset = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
    throw unauthorized('Reset link is invalid or has expired');
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
    prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    // Password change invalidates every existing session.
    prisma.session.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
