import { describe, expect, it } from 'vitest';
import { routeModality, type FileSignature } from './modality.js';

const sig = (overrides: Partial<FileSignature>): FileSignature => ({
  originalName: 'file.bin',
  extension: 'bin',
  declaredMime: 'application/octet-stream',
  sizeBytes: 1024,
  ...overrides,
});

describe('routeModality', () => {
  it('routes invoices to the invoice pipeline by name', () => {
    expect(
      routeModality(sig({ originalName: 'Invoice_2026_004.pdf', extension: 'pdf', declaredMime: 'application/pdf' })),
    ).toBe('INVOICE');
  });

  it('routes ordinary PDFs to the document pipeline', () => {
    expect(
      routeModality(sig({ originalName: 'contract.pdf', extension: 'pdf', declaredMime: 'application/pdf' })),
    ).toBe('DOCUMENT');
  });

  it('routes video to CCTV and named drone footage to the drone pipeline', () => {
    expect(routeModality(sig({ originalName: 'cam3.mp4', extension: 'mp4', declaredMime: 'video/mp4' }))).toBe('CCTV');
    expect(routeModality(sig({ originalName: 'DJI_0031.mp4', extension: 'mp4', declaredMime: 'video/mp4' }))).toBe(
      'DRONE',
    );
  });

  it('routes audio and email by signature', () => {
    expect(routeModality(sig({ originalName: 'call.wav', extension: 'wav', declaredMime: 'audio/wav' }))).toBe('AUDIO');
    expect(
      routeModality(sig({ originalName: 'thread.eml', extension: 'eml', declaredMime: 'message/rfc822' })),
    ).toBe('EMAIL');
  });

  it('honours explicit import-surface hints over filename guessing', () => {
    expect(
      routeModality(sig({ originalName: 'invoice.webm', extension: 'webm', declaredMime: 'audio/webm', hint: 'voice' })),
    ).toBe('AUDIO');
    expect(routeModality(sig({ originalName: 'clip.mp4', extension: 'mp4', declaredMime: 'video/mp4', hint: 'drone' }))).toBe(
      'DRONE',
    );
  });

  it('does not guess a pipeline for unrecognised files', () => {
    expect(routeModality(sig({}))).toBe('UNKNOWN');
  });
});
