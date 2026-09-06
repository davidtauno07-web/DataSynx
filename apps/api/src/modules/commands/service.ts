import { CommandStatus, ItemStatus, Modality, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { aiClient } from '../../services/ai/client.js';
import { getProcessingQueue } from '../../queue/queues.js';
import { recordAudit } from '../audit/service.js';
import { setRecordsRemoved } from '../compilation/service.js';
import { parseCommand, type Operation } from './parser.js';

export interface CommandContext {
  workspaceId: string;
  userId: string;
  jobId?: string;
  modality?: Modality;
  ip?: string;
  userAgent?: string;
}

export interface CommandResponse {
  operation: Operation;
  status: CommandStatus;
  message: string;
  data?: unknown;
}

const distanceSchema = z.object({
  value: z.number(),
  unit: z.string(),
  status: z.string(),
  method: z.string(),
});

async function resolveCompilation(workspaceId: string, modality?: Modality) {
  if (modality) {
    return prisma.compilation.findUnique({ where: { workspaceId_modality: { workspaceId, modality } } });
  }
  return prisma.compilation.findFirst({ where: { workspaceId }, orderBy: { updatedAt: 'desc' } });
}

async function executeOperation(op: Operation, ctx: CommandContext): Promise<CommandResponse> {
  switch (op.kind) {
    case 'unsupported':
      return { operation: op, status: CommandStatus.REJECTED, message: op.reason };

    case 'measure_distance': {
      const result = await aiClient.measure('geodesic_distance', { from: op.from, to: op.to }, (raw) =>
        distanceSchema.parse(raw),
      );
      return {
        operation: op,
        status: CommandStatus.EXECUTED,
        message: `Distance: ${result.value} ${result.unit} (${result.method})`,
        data: result,
      };
    }

    case 'remove_rows':
    case 'restore_rows': {
      const compilation = await resolveCompilation(ctx.workspaceId, ctx.modality);
      if (!compilation) throw notFound('There is no compilation to modify yet');
      const removed = op.kind === 'remove_rows';
      const count = await setRecordsRemoved({
        workspaceId: ctx.workspaceId,
        compilationId: compilation.id,
        rowKeys: op.rowKeys,
        removed,
      });
      if (count === 0) {
        return {
          operation: op,
          status: CommandStatus.REJECTED,
          message: `No compilation rows matched ${op.rowKeys.join(', ')}`,
        };
      }
      return {
        operation: op,
        status: CommandStatus.EXECUTED,
        message: `${removed ? 'Excluded' : 'Restored'} ${count} row(s). Original files and results are untouched.`,
        data: { count },
      };
    }

    case 'reprocess': {
      const file = await prisma.fileObject.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          OR: [{ reference: op.target.toUpperCase() }, { originalName: op.target }],
        },
      });
      if (!file) throw notFound(`No imported file matches "${op.target}"`);

      const item = await prisma.processingItem.findFirst({
        where: { fileId: file.id, ...(ctx.jobId ? { jobId: ctx.jobId } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      if (!item) throw notFound(`"${op.target}" has not been processed in a job yet`);

      await prisma.processingItem.update({
        where: { id: item.id },
        data: { status: ItemStatus.QUEUED, stage: null, progress: 0, error: null },
      });
      await getProcessingQueue().add(
        'process-item',
        { itemId: item.id, jobId: item.jobId, workspaceId: ctx.workspaceId },
        { jobId: `item-${item.id}-${Date.now()}` },
      );
      return {
        operation: op,
        status: CommandStatus.EXECUTED,
        message: `Requeued ${file.reference} for reprocessing. A new result version will be created.`,
        data: { itemId: item.id, fileReference: file.reference },
      };
    }

    case 'filter':
    case 'show_columns':
    case 'summarise': {
      const compilation = await resolveCompilation(ctx.workspaceId, ctx.modality);
      if (!compilation) throw notFound('There is no compilation to query yet');

      const records = await prisma.compilationRecord.findMany({
        where: { compilationId: compilation.id, removed: false },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      });
      const rows = records.map((r) => ({ rowKey: r.rowKey, source: r.sourceRef, ...(r.data as object) })) as Record<
        string,
        unknown
      >[];

      if (op.kind === 'filter') {
        const key = matchColumn(rows, op.field);
        if (!key) return { operation: op, status: CommandStatus.REJECTED, message: `Unknown field "${op.field}"` };
        const filtered = rows.filter((row) => compare(row[key], op.operator, op.value));
        return {
          operation: op,
          status: CommandStatus.EXECUTED,
          message: `${filtered.length} of ${rows.length} rows match ${key} ${op.operator} ${op.value}`,
          data: { columns: Object.keys(rows[0] ?? {}), rows: filtered.slice(0, 500) },
        };
      }

      if (op.kind === 'show_columns') {
        const keys = op.columns.map((c) => matchColumn(rows, c)).filter((c): c is string => Boolean(c));
        if (keys.length === 0) {
          return {
            operation: op,
            status: CommandStatus.REJECTED,
            message: `None of these columns exist: ${op.columns.join(', ')}`,
          };
        }
        const projected = rows.map((row) =>
          Object.fromEntries([['rowKey', row.rowKey], ...keys.map((k) => [k, row[k]])]),
        );
        return {
          operation: op,
          status: CommandStatus.EXECUTED,
          message: `Showing ${keys.join(', ')} for ${projected.length} rows`,
          data: { columns: ['rowKey', ...keys], rows: projected.slice(0, 500) },
        };
      }

      const key = op.field ? matchColumn(rows, op.field) : null;
      if (op.field && !key) {
        return { operation: op, status: CommandStatus.REJECTED, message: `Unknown field "${op.field}"` };
      }
      if (!key) {
        return {
          operation: op,
          status: CommandStatus.EXECUTED,
          message: `${rows.length} rows in ${compilation.name}`,
          data: { count: rows.length },
        };
      }
      const numbers = rows.map((r) => Number(r[key])).filter((n) => Number.isFinite(n));
      const sum = numbers.reduce((a, b) => a + b, 0);
      return {
        operation: op,
        status: CommandStatus.EXECUTED,
        message: `${key}: count=${numbers.length}, sum=${round(sum)}, average=${numbers.length ? round(sum / numbers.length) : 'n/a'}`,
        data: { field: key, count: numbers.length, sum: round(sum), average: numbers.length ? round(sum / numbers.length) : null },
      };
    }

    default:
      throw badRequest('Unsupported operation');
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function matchColumn(rows: Record<string, unknown>[], field: string): string | null {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 50)) for (const key of Object.keys(row)) keys.add(key);
  const target = field.trim().toLowerCase();
  for (const key of keys) if (key.toLowerCase() === target) return key;
  for (const key of keys) if (key.toLowerCase().includes(target)) return key;
  return null;
}

function compare(value: unknown, operator: string, expected: string): boolean {
  const left = value === null || value === undefined ? '' : String(value);
  switch (operator) {
    case 'eq':
      return left.toLowerCase() === expected.toLowerCase();
    case 'neq':
      return left.toLowerCase() !== expected.toLowerCase();
    case 'contains':
      return left.toLowerCase().includes(expected.toLowerCase());
    case 'gt':
      return Number(left) > Number(expected);
    case 'lt':
      return Number(left) < Number(expected);
    default:
      return false;
  }
}

export async function runCommand(input: string, ctx: CommandContext): Promise<CommandResponse> {
  const operation = parseCommand(input);
  let response: CommandResponse;
  let error: string | null = null;

  try {
    response = await executeOperation(operation, ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Command failed';
    response = { operation, status: CommandStatus.FAILED, message: error };
  }

  const record = await prisma.processingCommand.create({
    data: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      jobId: ctx.jobId,
      input: input.slice(0, 2000),
      operation: operation as unknown as Prisma.InputJsonValue,
      status: response.status,
      response: { message: response.message, data: response.data ?? null } as Prisma.InputJsonValue,
      error,
    },
  });

  await recordAudit({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: `command.${operation.kind}`,
    entityType: 'ProcessingCommand',
    entityId: record.id,
    after: { input, status: response.status } as Prisma.InputJsonValue,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return response;
}
