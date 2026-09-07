import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DEFAULT_ARCHIVE_LIMITS, expandArchive, isArchiveName, safeArchivePath } from './archive.js';

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('safeArchivePath', () => {
  it('keeps ordinary nested paths', () => {
    expect(safeArchivePath('invoices/march/01.pdf')).toBe('invoices/march/01.pdf');
    expect(safeArchivePath('.\\docs\\a.txt')).toBe('docs/a.txt');
  });

  it('rejects traversal, absolute and control-character paths', () => {
    expect(safeArchivePath('../../etc/passwd')).toBeNull();
    expect(safeArchivePath('docs/../../escape.txt')).toBeNull();
    expect(safeArchivePath('/etc/passwd')).toBeNull();
    expect(safeArchivePath('C:/Windows/system.ini')).toBeNull();
    expect(safeArchivePath('bad\u0000name.txt')).toBeNull();
  });
});

describe('expandArchive', () => {
  it('extracts members with their path inside the archive', async () => {
    const buffer = await zipOf({
      'invoices/one.txt': 'first invoice',
      'notes.txt': 'plain note',
    });
    const { members, skipped } = await expandArchive(buffer);
    expect(members.map((m) => m.archivePath).sort()).toEqual(['invoices/one.txt', 'notes.txt']);
    expect(members.find((m) => m.fileName === 'one.txt')?.buffer.toString()).toBe('first invoice');
    expect(skipped).toHaveLength(0);
  });

  it('skips zip-slip entries instead of writing outside the archive', async () => {
    const buffer = await zipOf({ '../evil.txt': 'nope', 'good.txt': 'yes' });
    const { members, skipped } = await expandArchive(buffer);
    expect(members.map((m) => m.archivePath)).toEqual(['good.txt']);
    expect(skipped[0]?.reason).toMatch(/unsafe path/i);
  });

  it('does not expand nested archives', async () => {
    const inner = await zipOf({ 'inner.txt': 'inner' });
    const buffer = await zipOf({ 'nested.zip': inner, 'outer.txt': 'outer' });
    const { members, skipped } = await expandArchive(buffer);
    expect(members.map((m) => m.archivePath)).toEqual(['outer.txt']);
    expect(skipped.map((s) => s.archivePath)).toEqual(['nested.zip']);
  });

  it('refuses an archive with too many entries', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) entries[`f${i}.txt`] = 'x';
    const buffer = await zipOf(entries);
    await expect(
      expandArchive(buffer, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 10 }),
    ).rejects.toThrow(/more than 10 files/);
  });

  it('refuses a zip bomb by total expanded size', async () => {
    const buffer = await zipOf({ 'big.txt': 'A'.repeat(200_000) });
    await expect(
      expandArchive(buffer, { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 50_000 }),
    ).rejects.toThrow(/allowed total size/);
  });

  it('refuses an implausible compression ratio', async () => {
    const buffer = await zipOf({ 'bomb.txt': 'A'.repeat(4 * 1024 * 1024) });
    await expect(
      expandArchive(buffer, { ...DEFAULT_ARCHIVE_LIMITS, maxCompressionRatio: 10 }),
    ).rejects.toThrow(/compression ratio/);
  });

  it('rejects a corrupt archive', async () => {
    await expect(expandArchive(Buffer.from('not a zip file'))).rejects.toThrow();
  });
});

describe('isArchiveName', () => {
  it('recognises zip files only', () => {
    expect(isArchiveName('batch.ZIP')).toBe(true);
    expect(isArchiveName('report.pdf')).toBe(false);
  });
});
