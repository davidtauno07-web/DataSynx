import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FileRecord } from '../lib/types';
import { Empty } from './Panel';

/**
 * Renders the untouched original via a short-lived presigned URL. The original
 * object is never modified or replaced by the UI.
 */
export function SourcePreview({ file }: { file: FileRecord | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!file) return;
    let cancelled = false;
    api
      .get<{ url: string }>(`/imports/files/${file.id}/source`)
      .then((res) => {
        if (!cancelled) setUrl(res.url);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!file) return <Empty>No item is being processed right now.</Empty>;
  if (error) return <Empty>Original preview unavailable: {error}</Empty>;
  if (!url) return <Empty>Loading original…</Empty>;

  const mime = file.mimeType;
  if (mime.startsWith('image/')) return <img src={url} alt={file.originalName} style={{ maxWidth: '100%' }} />;
  if (mime.startsWith('video/')) return <video src={url} controls style={{ width: '100%' }} />;
  if (mime.startsWith('audio/')) return <audio src={url} controls style={{ width: '100%' }} />;
  if (mime === 'application/pdf') return <iframe src={url} title={file.originalName} style={{ width: '100%', height: 520, border: 0 }} />;

  return (
    <div className="stack">
      <p className="muted">
        {file.originalName} · {mime}
      </p>
      <a className="button" href={url} target="_blank" rel="noreferrer">
        Open original
      </a>
    </div>
  );
}
