import { Buffer } from 'node:buffer';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { generateExport } from './generators.js';
import type { Dataset } from './dataset.js';

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    compilation: {
      id: 'cmp_1',
      workspaceId: 'ws_1',
      name: 'Invoices',
      modality: 'INVOICE',
      columns: ['Source', 'Invoice Number', 'Supplier', 'Invoice Date', 'Total'],
      rowCount: 2,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as unknown as Dataset['compilation'],
    columns: ['Source', 'Invoice Number', 'Supplier', 'Invoice Date', 'Total'],
    rows: [
      {
        Source: 'DSX-2026-000001',
        'Invoice Number': 'INV-1',
        Supplier: 'Northwind, Ltd',
        'Invoice Date': '2026-01-04',
        Total: 610.5,
      },
      {
        Source: 'DSX-2026-000002',
        'Invoice Number': 'INV-2',
        Supplier: 'Line\nbreak "quoted"',
        'Invoice Date': '2026-01-05',
        Total: 0,
      },
    ],
    geometries: [],
    generatedAt: new Date('2026-02-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('export generators', () => {
  it('writes an XLSX workbook with typed cells and a metadata sheet', async () => {
    const result = await generateExport('XLSX', dataset());
    expect(result.extension).toBe('xlsx');
    expect(result.rowCount).toBe(2);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Dataset');
    expect(sheet).toBeDefined();
    expect(sheet?.getRow(1).getCell(2).value).toBe('Invoice Number');
    expect(sheet?.getRow(2).getCell(5).value).toBe(610.5);
    expect(sheet?.getRow(2).getCell(4).value).toBeInstanceOf(Date);
    expect(sheet?.getRow(2).getCell(4).numFmt).toBe('yyyy-mm-dd');
    expect(workbook.getWorksheet('Metadata')).toBeDefined();
  });

  it('escapes quotes, commas and newlines in CSV', async () => {
    const result = await generateExport('CSV', dataset());
    const text = result.buffer.toString('utf8');
    expect(text).toContain('\uFEFF');
    expect(text).toContain('"Northwind, Ltd"');
    expect(text).toContain('"Line\nbreak ""quoted"""');
    expect(text.split('\r\n')[0]).toContain('Invoice Number');
  });

  it('exports JSON with records and metadata', async () => {
    const result = await generateExport('JSON', dataset());
    const parsed = JSON.parse(result.buffer.toString('utf8')) as {
      recordCount: number;
      records: Record<string, unknown>[];
    };
    expect(parsed.recordCount).toBe(2);
    expect(parsed.records[0]?.['Invoice Number']).toBe('INV-1');
  });

  it('produces a plain-text report', async () => {
    const result = await generateExport('TXT', dataset());
    const text = result.buffer.toString('utf8');
    expect(text).toContain('DataSynx — Invoices');
    expect(text).toContain('Invoice Number: INV-1');
  });

  it('produces a PDF document', async () => {
    const result = await generateExport('PDF', dataset());
    expect(result.contentType).toBe('application/pdf');
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('produces a DOCX document', async () => {
    const result = await generateExport('DOCX', dataset());
    expect(result.extension).toBe('docx');
    expect(result.buffer.subarray(0, 2)).toEqual(Buffer.from('PK'));
  });

  it('produces a valid GeoJSON FeatureCollection for spatial data', async () => {
    const spatial = dataset({
      geometries: [
        {
          properties: { Source: 'DSX-2026-000003', Object: 'Building #1' },
          geometry: { type: 'Point', coordinates: [24.7536, 59.437] },
        },
      ],
    });
    const result = await generateExport('GEOJSON', spatial);
    const parsed = JSON.parse(result.buffer.toString('utf8')) as {
      type: string;
      features: { type: string; geometry: { type: string } }[];
    };
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features[0]?.geometry.type).toBe('Point');
    expect(result.rowCount).toBe(1);
  });

  it('refuses GeoJSON when the compilation has no geometry rather than inventing one', async () => {
    await expect(generateExport('GEOJSON', dataset())).rejects.toThrow(/no spatial geometry/i);
  });
});
