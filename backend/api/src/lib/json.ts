import type { Prisma } from '@prisma/client';

/** Narrows plain records to Prisma's JSON input type without weakening call sites. */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}
