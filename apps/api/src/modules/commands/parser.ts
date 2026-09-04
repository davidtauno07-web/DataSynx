import { z } from 'zod';

/**
 * Commands are always translated into one of these structured, whitelisted
 * operations. Free text is never executed, and no operation can touch original
 * files or another workspace.
 */
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('filter'), field: z.string(), operator: z.enum(['eq', 'neq', 'contains', 'gt', 'lt']), value: z.string() }),
  z.object({ kind: z.literal('show_columns'), columns: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('remove_rows'), rowKeys: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('restore_rows'), rowKeys: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('reprocess'), target: z.string() }),
  z.object({ kind: z.literal('summarise'), field: z.string().optional() }),
  z.object({
    kind: z.literal('measure_distance'),
    from: z.tuple([z.number(), z.number()]),
    to: z.tuple([z.number(), z.number()]),
  }),
  z.object({ kind: z.literal('unsupported'), reason: z.string() }),
]);

export type Operation = z.infer<typeof operationSchema>;

const COORD = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/g;

/**
 * Deterministic intent parser. An LLM is deliberately not in this path: the
 * command surface must be predictable and auditable. Unrecognised input is
 * reported as unsupported rather than guessed at.
 */
export function parseCommand(input: string): Operation {
  const text = input.trim();
  const lower = text.toLowerCase();

  const remove = /^(remove|exclude|delete)\s+(?:row\s+)?(.+?)\s*(?:from (?:the )?results?)?$/i.exec(text);
  if (remove?.[2] && /^(remove|exclude|delete)/i.test(text)) {
    const keys = remove[2]
      .split(/\s*(?:,| and )\s*/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length > 0) return { kind: 'remove_rows', rowKeys: keys };
  }

  const restore = /^(restore|re-?include|undo removal of)\s+(.+)$/i.exec(text);
  if (restore?.[2]) {
    return { kind: 'restore_rows', rowKeys: restore[2].split(/\s*(?:,| and )\s*/).filter(Boolean) };
  }

  const reprocess = /^(reprocess|re-?run|retry)\s+(.+)$/i.exec(text);
  if (reprocess?.[2]) return { kind: 'reprocess', target: reprocess[2].trim() };

  const distance = [...text.matchAll(COORD)];
  if (/distance/.test(lower) && distance.length >= 2) {
    const a = distance[0];
    const b = distance[1];
    if (a?.[1] && a[2] && b?.[1] && b[2]) {
      return {
        kind: 'measure_distance',
        from: [Number(a[1]), Number(a[2])],
        to: [Number(b[1]), Number(b[2])],
      };
    }
  }

  const showOnly = /^show\s+only\s+(.+)$/i.exec(text);
  if (showOnly?.[1]) {
    const clause = showOnly[1];
    const eq = /^(.+?)\s+(?:=|is|equals)\s+(.+)$/i.exec(clause);
    if (eq?.[1] && eq[2]) return { kind: 'filter', field: eq[1].trim(), operator: 'eq', value: eq[2].trim() };
    return { kind: 'filter', field: 'Type', operator: 'contains', value: clause.trim() };
  }

  const where = /^(?:show|list|filter)\s+.*\bwhere\s+(.+?)\s*(>|<|=|contains)\s*(.+)$/i.exec(text);
  if (where?.[1] && where[2] && where[3]) {
    const operator = where[2] === '>' ? 'gt' : where[2] === '<' ? 'lt' : where[2] === '=' ? 'eq' : 'contains';
    return { kind: 'filter', field: where[1].trim(), operator, value: where[3].trim() };
  }

  const show = /^(?:show|extract|display)\s+(?:me\s+)?(?:the\s+)?(.+?)\s+(?:of|for|from)\s+(?:every|all|each)\b.*$/i.exec(text);
  if (show?.[1]) {
    const columns = show[1]
      .split(/\s*(?:,| and )\s*/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (columns.length > 0) return { kind: 'show_columns', columns };
  }

  if (/^(summar|total|sum|count|average|mean)/i.test(text)) {
    const field = /(?:of|for)\s+(.+)$/i.exec(text)?.[1]?.trim();
    return { kind: 'summarise', field };
  }

  return {
    kind: 'unsupported',
    reason:
      'Command not recognised. Try: "show only vehicles moving north", "remove DSX-2026-000004#vehicle-17", "reprocess DSX-2026-000004", "calculate the distance between 59.437,24.753 and 59.441,24.760".',
  };
}
