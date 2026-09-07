import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ResultView } from './ResultView';
import type { ProcessingResult } from '../lib/types';

const result: ProcessingResult = {
  id: 'result-1',
  engine: 'invoice',
  engineVersion: '1.0.0',
  version: 1,
  demo: false,
  confidence: 0.92,
  warnings: ['Tax could not be reconciled'],
  data: {
    invoiceNumber: 'INV-2026-004',
    supplier: 'Northwind Ltd',
    total: 610,
    lineItems: [{ description: 'Server rack', quantity: 2, unitPrice: 250 }],
  },
  measurements: [
    {
      subject: 'Vehicle #1',
      parameter: 'speed',
      value: null,
      unit: 'km/h',
      status: 'UNAVAILABLE',
      method: null,
      source: null,
      quality: null,
      confidence: null,
      reason: 'Camera calibration missing',
    },
  ],
};

describe('ResultView', () => {
  it('shows the human view by default', () => {
    render(<ResultView result={result} />);
    expect(screen.getByText('Invoice Number')).toBeInTheDocument();
    expect(screen.getByText('INV-2026-004')).toBeInTheDocument();
    expect(screen.queryByText(/"invoiceNumber"/)).not.toBeInTheDocument();
  });

  it('reports unavailable measurements honestly instead of a number', () => {
    render(<ResultView result={result} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Camera calibration missing')).toBeInTheDocument();
  });

  it('surfaces warnings', () => {
    render(<ResultView result={result} />);
    expect(screen.getByText('Tax could not be reconciled')).toBeInTheDocument();
  });

  it('exposes raw JSON as a secondary view', async () => {
    render(<ResultView result={result} />);
    await userEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(screen.getByText(/"invoiceNumber": "INV-2026-004"/)).toBeInTheDocument();
  });

  it('marks demo results', () => {
    render(<ResultView result={{ ...result, demo: true }} />);
    expect(screen.getByText(/Demo result/)).toBeInTheDocument();
  });
});
