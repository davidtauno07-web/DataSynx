/**
 * Idempotent seed: creates the first owner account and workspace so a freshly
 * migrated database is usable immediately. Safe to re-run — nothing is deleted
 * and existing rows are left untouched.
 *
 *   npm run db:seed
 *
 * Credentials come from the environment (see .env.example):
 *   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME, SEED_WORKSPACE_NAME
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

const email = process.env.SEED_ADMIN_EMAIL ?? 'owner@datasynx.local';
const password = process.env.SEED_ADMIN_PASSWORD ?? '';
const name = process.env.SEED_ADMIN_NAME ?? 'DataSynx Owner';
const workspaceName = process.env.SEED_WORKSPACE_NAME ?? 'DataSynx Workspace';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'workspace';

async function main(): Promise<void> {
  if (password.length < 12) {
    throw new Error('Set SEED_ADMIN_PASSWORD to at least 12 characters before seeding');
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name,
      provider: 'PASSWORD',
      emailVerified: true,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    },
  });

  const membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id } });
  const workspace =
    membership !== null
      ? await prisma.workspace.findUniqueOrThrow({ where: { id: membership.workspaceId } })
      : await prisma.workspace.create({
          data: {
            name: workspaceName,
            slug: slugify(workspaceName),
            members: { create: { userId: user.id, role: 'OWNER' } },
          },
        });

  // Reference counters are created on demand by the API; seeding the current
  // year keeps the very first import from racing on counter creation.
  const year = new Date().getFullYear();
  for (const prefix of ['DSX', 'IMP', 'JOB', 'EXP']) {
    await prisma.referenceCounter.upsert({
      where: { id: `${prefix}:${year}` },
      update: {},
      create: { id: `${prefix}:${year}`, current: 0 },
    });
  }

  console.log(`Seeded owner ${user.email} in workspace ${workspace.slug}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
