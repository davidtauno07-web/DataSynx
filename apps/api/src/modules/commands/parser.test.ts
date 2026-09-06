import { describe, expect, it } from 'vitest';
import { operationSchema, parseCommand } from './parser.js';

describe('parseCommand', () => {
  it('parses column projections', () => {
    expect(parseCommand('Extract supplier and total from every invoice')).toEqual({
      kind: 'show_columns',
      columns: ['supplier', 'total'],
    });
  });

  it('parses filters', () => {
    expect(parseCommand('Show only vehicles moving north')).toEqual({
      kind: 'filter',
      field: 'Type',
      operator: 'contains',
      value: 'vehicles moving north',
    });
    expect(parseCommand('Show vehicles where Speed > 12')).toEqual({
      kind: 'filter',
      field: 'Speed',
      operator: 'gt',
      value: '12',
    });
  });

  it('treats a listed "show only" clause as a column projection', () => {
    expect(parseCommand('Show only supplier and total')).toEqual({
      kind: 'show_columns',
      columns: ['supplier', 'total'],
    });
  });

  it('parses row removal and restoration as reversible dataset operations', () => {
    expect(parseCommand('Remove vehicle #17 from the results')).toEqual({
      kind: 'remove_rows',
      rowKeys: ['vehicle #17'],
    });
    expect(parseCommand('Restore vehicle #17')).toEqual({ kind: 'restore_rows', rowKeys: ['vehicle #17'] });
  });

  it('parses reprocessing targets', () => {
    expect(parseCommand('Reprocess DSX-2026-000004')).toEqual({ kind: 'reprocess', target: 'DSX-2026-000004' });
  });

  it('parses a deterministic distance measurement', () => {
    expect(parseCommand('Calculate the distance between 59.437,24.753 and 59.441,24.760')).toEqual({
      kind: 'measure_distance',
      from: [59.437, 24.753],
      to: [59.441, 24.76],
    });
  });

  it('summarises rather than guessing', () => {
    expect(parseCommand('Total of Amount')).toEqual({ kind: 'summarise', field: 'Amount' });
  });

  it('reports unsupported commands instead of inventing an operation', () => {
    const op = parseCommand('drop table users; rm -rf /');
    expect(op.kind).toBe('unsupported');
  });

  it('only ever produces whitelisted operations', () => {
    for (const input of [
      'Show the speed of every vehicle',
      'Remove DSX-2026-000004',
      'nonsense input here',
      'Reprocess vehicle #12',
    ]) {
      expect(operationSchema.safeParse(parseCommand(input)).success).toBe(true);
    }
  });
});
