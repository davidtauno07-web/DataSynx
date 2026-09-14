import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipStrip } from './ClipStrip';
import { api } from '../lib/api';
import type { EventClip } from '../lib/types';

const clip = (overrides: Partial<EventClip>): EventClip => ({
  id: 'clip-1',
  clipKey: 'person-001-01',
  subject: 'Person #001',
  objectType: 'person',
  sequence: 1,
  startTime: 4,
  endTime: 12,
  eventTime: 7,
  kinds: ['LINE_CROSSING'],
  reason: 'line crossing',
  sourceRef: 'DSX-2026-000004',
  status: 'READY',
  unavailableReason: null,
  storageKey: 'derived/clip-1.mp4',
  ...overrides,
});

const clips = [
  clip({}),
  clip({ id: 'clip-2', clipKey: 'person-001-02', sequence: 2, startTime: 30, endTime: 38, eventTime: 33 }),
];

describe('ClipStrip', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue({ url: 'https://storage.test/clip.mp4' });
  });

  it('lists clips chronologically with their event window', () => {
    render(<ClipStrip clips={clips} selected={clips[0] ?? null} onSelect={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain('4.0s–12.0s');
    expect(buttons[1]?.textContent).toContain('30.0s–38.0s');
  });

  it('loads the selected clip through a short-lived url', async () => {
    render(<ClipStrip clips={clips} selected={clips[0] ?? null} onSelect={vi.fn()} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/processing/clips/clip-1/media'));
  });

  it('selects a clip without touching the original source', async () => {
    const onSelect = vi.fn();
    render(<ClipStrip clips={clips} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getAllByRole('button')[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(clips[1]);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('reports missing footage instead of pretending a clip exists', () => {
    const missing = clip({ id: 'clip-3', status: 'UNAVAILABLE', storageKey: null, unavailableReason: 'ffmpeg failed' });
    render(<ClipStrip clips={[missing]} selected={missing} onSelect={vi.fn()} />);
    expect(screen.getByText(/Clip footage unavailable: ffmpeg failed/)).toBeInTheDocument();
  });
});
