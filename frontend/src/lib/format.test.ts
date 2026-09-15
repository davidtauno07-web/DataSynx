import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, formatDuration, formatValue, humanLabel } from './format';

describe('format helpers', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes('1048576')).toBe('1.0 MB');
    expect(formatBytes(null)).toBe('—');
  });

  it('formats durations as mm:ss', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65_000)).toBe('01:05');
  });

  it('humanises keys', () => {
    expect(humanLabel('invoice_number')).toBe('Invoice number');
    expect(humanLabel('dwellTimeSeconds')).toBe('Dwell Time Seconds');
  });

  it('formats values without inventing data', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue('')).toBe('—');
    expect(formatValue(false)).toBe('No');
    expect(formatValue(12.5)).toBe('12.5');
  });

  it('rejects invalid timestamps', () => {
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime(null)).toBe('—');
  });
});
