import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { EventClip } from '../lib/types';
import { Empty } from './Panel';

const seconds = (value: number) => `${value.toFixed(1)}s`;

/**
 * Chronological contextual clips. Each clip is derived evidence cut from the
 * original footage; the original is never replaced by it.
 */
export function ClipStrip({
  clips,
  selected,
  onSelect,
}: {
  clips: EventClip[];
  selected: EventClip | null;
  onSelect: (clip: EventClip) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeId = selected?.id ?? null;
  // Only READY clips have stored footage; the rest are reported honestly.
  const selectedId = selected?.status === 'READY' ? activeId : null;

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!selectedId) return;
    let cancelled = false;
    api
      .get<{ url: string }>(`/processing/clips/${selectedId}/media`)
      .then((res) => {
        if (!cancelled) setUrl(res.url);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (clips.length === 0) return <Empty>No event clips for this selection.</Empty>;

  return (
    <div className="stack">
      {selected ? (
        selected.status !== 'READY' ? (
          <Empty>
            Clip footage unavailable{selected.unavailableReason ? `: ${selected.unavailableReason}` : ''}. The event
            itself is still recorded against the original source.
          </Empty>
        ) : error ? (
          <Empty>Clip unavailable: {error}</Empty>
        ) : url ? (
          <video key={selected.id} src={url} controls autoPlay style={{ width: '100%' }} />
        ) : (
          <Empty>Loading clip…</Empty>
        )
      ) : (
        <Empty>Select a clip to play it.</Empty>
      )}

      <ol className="clip-strip">
        {clips.map((clip) => (
          <li key={clip.id}>
            <button
              type="button"
              className={clip.id === activeId ? 'clip active' : 'clip'}
              aria-pressed={clip.id === activeId}
              onClick={() => onSelect(clip)}
            >
              <span className="mono">{clip.subject}</span>
              <span className="pill">{clip.kinds.join(', ') || 'EVENT'}</span>
              <span className="muted">
                {seconds(clip.startTime)}–{seconds(clip.endTime)} · event at {seconds(clip.eventTime)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
