import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CorrectionPanel } from './CorrectionPanel';
import { api } from '../lib/api';
import type { ProcessingResult } from '../lib/types';

const result: ProcessingResult = {
  id: 'result-1',
  engine: 'invoice',
  engineVersion: '1.0.0',
  version: 1,
  demo: false,
  confidence: null,
  warnings: [],
  data: { supplier: 'Nortwind', quantity: 3, paid: false },
  measurements: [],
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CorrectionPanel result={result} />
    </QueryClientProvider>,
  );
}

const posted = () => vi.mocked(api.post).mock.calls.at(-1)?.[1] as Record<string, unknown>;

describe('CorrectionPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue({ corrections: [], total: 0 });
    vi.spyOn(api, 'post').mockResolvedValue({});
  });

  it('sends a numeric field as a number, not a string', async () => {
    renderPanel();
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'quantity');
    await userEvent.type(screen.getByLabelText('Corrected value'), '4');
    await userEvent.click(screen.getByRole('button', { name: 'Submit correction' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(posted()).toMatchObject({ field: 'quantity', correctedValue: 4 });
  });

  it('sends a boolean field as a boolean', async () => {
    renderPanel();
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'paid');
    await userEvent.type(screen.getByLabelText('Corrected value'), 'yes');
    await userEvent.click(screen.getByRole('button', { name: 'Submit correction' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(posted()).toMatchObject({ field: 'paid', correctedValue: true });
  });

  it('keeps text fields as text', async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText('Corrected value'), 'Northwind');
    await userEvent.click(screen.getByRole('button', { name: 'Submit correction' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(posted()).toMatchObject({ field: 'supplier', correctedValue: 'Northwind' });
  });

  it('refuses an unparseable number instead of sending a string', async () => {
    renderPanel();
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'quantity');
    await userEvent.type(screen.getByLabelText('Corrected value'), 'four');
    await userEvent.click(screen.getByRole('button', { name: 'Submit correction' }));

    expect(await screen.findByText('Enter a number')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
