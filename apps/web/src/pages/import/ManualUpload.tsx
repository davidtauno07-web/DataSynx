import { useRef, useState, type DragEvent } from 'react';
import { Alert, Panel } from '../../components/Panel';
import { formatBytes } from '../../lib/format';

interface UploadedFile {
  id: string;
  reference: string;
  originalName: string;
  modality: string;
  sizeBytes: number;
  duplicateOf?: string | null;
}

interface Props {
  onImported: () => void;
}

export function ManualUpload({ onImported }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [queued, setQueued] = useState<File[]>([]);
  const [accepted, setAccepted] = useState<UploadedFile[]>([]);
  const [rejected, setRejected] = useState<{ originalName: string; error: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setQueued((current) => [...current, ...Array.from(list)]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function upload() {
    if (queued.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of queued) form.append('files', file);
      form.append('label', `${queued.length} file(s)`);
      const res = await fetch('/api/imports/upload', { method: 'POST', body: form, credentials: 'include' });
      const payload = (await res.json().catch(() => ({}))) as {
        message?: string;
        files?: UploadedFile[];
        rejected?: { originalName: string; error: string }[];
      };
      if (!res.ok) throw new Error(payload.message ?? `Upload failed (${res.status})`);
      setAccepted(payload.files ?? []);
      setRejected(payload.rejected ?? []);
      setQueued([]);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Manual Upload">
      {error && <Alert>{error}</Alert>}
      <div
        className={`dropzone${dragging ? ' active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop files here — PDF, DOCX, TXT, CSV, XLSX, images, audio, video.</p>
        <button onClick={() => inputRef.current?.click()}>Choose files</button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          aria-label="Choose files to upload"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {queued.length > 0 && (
        <>
          <ul className="list" style={{ marginTop: 16 }}>
            {queued.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                <span>{file.name}</span>
                <span className="muted mono">{formatBytes(file.size)}</span>
                <span className="row-actions">
                  <button onClick={() => setQueued((c) => c.filter((_, i) => i !== index))}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
          <div className="inline" style={{ marginTop: 16 }}>
            <button className="primary" onClick={upload} disabled={busy}>
              {busy ? `Uploading ${queued.length}…` : `Upload ${queued.length} file(s)`}
            </button>
            <button onClick={() => setQueued([])} disabled={busy}>
              Clear
            </button>
          </div>
        </>
      )}

      {accepted.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="uppercase muted">Imported</h3>
          <ul className="list">
            {accepted.map((file) => (
              <li key={file.id}>
                <span className="mono">{file.reference}</span>
                <span>{file.originalName}</span>
                <span className="pill">{file.modality}</span>
                {file.duplicateOf && <span className="pill warn">Possible duplicate of {file.duplicateOf}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rejected.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="uppercase muted">Rejected</h3>
          <ul className="list">
            {rejected.map((file, index) => (
              <li key={index}>
                <span>{file.originalName}</span>
                <span className="muted">{file.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
