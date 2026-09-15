import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { sanitizeFilename, validateUpload } from './validation.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20), Buffer.from('\n%%EOF\n')]);

describe('sanitizeFilename', () => {
  it('strips directory traversal and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFilename('bad\u0000name.pdf')).toBe('bad_name.pdf');
  });
});

describe('validateUpload', () => {
  it('accepts a file whose signature matches its extension', async () => {
    const result = await validateUpload({
      originalname: 'photo.png',
      mimetype: 'image/png',
      size: PNG.length,
      buffer: PNG,
    });
    expect(result.extension).toBe('png');
    expect(result.detectedMime).toBe('image/png');
  });

  it('accepts text-like files that have no magic bytes', async () => {
    const buffer = Buffer.from('a,b\n1,2\n', 'utf8');
    const result = await validateUpload({
      originalname: 'rows.csv',
      mimetype: 'text/csv',
      size: buffer.length,
      buffer,
    });
    expect(result.extension).toBe('csv');
    expect(result.detectedMime).toBeNull();
  });

  it('rejects a PNG disguised as a PDF', async () => {
    await expect(
      validateUpload({ originalname: 'invoice.pdf', mimetype: 'application/pdf', size: PNG.length, buffer: PNG }),
    ).rejects.toThrow(/does not match/i);
  });

  it('rejects unsupported extensions and empty files', async () => {
    await expect(
      validateUpload({ originalname: 'payload.exe', mimetype: 'application/x-msdownload', size: 4, buffer: PDF }),
    ).rejects.toThrow(/not supported/i);
    await expect(
      validateUpload({ originalname: 'empty.pdf', mimetype: 'application/pdf', size: 0, buffer: Buffer.alloc(0) }),
    ).rejects.toThrow(/empty/i);
    await expect(
      validateUpload({ originalname: 'noext', mimetype: 'application/pdf', size: PDF.length, buffer: PDF }),
    ).rejects.toThrow(/extension/i);
  });
});
