import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Alert, Empty, Panel } from '../components/Panel';
import { api } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import type { FileRecord, ProcessingJob } from '../lib/types';
import { EmailConnector } from './import/EmailConnector';
import { ManualUpload } from './import/ManualUpload';
import { VoiceRecorder } from './import/VoiceRecorder';

interface FilesResponse {
  total: number;
  files: (FileRecord & { _count?: { items: number } })[];
}

export function ImportPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const files = useQuery({
    queryKey: ['files', 'unprocessed'],
    queryFn: () => api.get<FilesResponse>('/imports/files?unprocessed=true&pageSize=100'),
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['files'] });
  }, [queryClient]);

  const createJob = useMutation({
    mutationFn: (fileIds: string[]) =>
      api.post<{ job: ProcessingJob }>('/processing/jobs', { name: `Batch of ${fileIds.length}`, fileIds }),
    onSuccess: (res) => {
      setSelected(new Set());
      refresh();
      navigate(`/processing?job=${res.job.id}`);
    },
    onError: (err: Error) => setError(err.message),
  });

  const list = files.data?.files ?? [];
  const allSelected = list.length > 0 && selected.size === list.length;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Import</h1>
        <span className="muted">Voice, email and manual upload feed one ingestion pipeline.</span>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="grid-3">
        <VoiceRecorder onImported={refresh} />
        <EmailConnector onImported={refresh} />
        <ManualUpload onImported={refresh} />
      </div>

      <Panel
        title="Imported, not yet processed"
        actions={
          <div className="tabs">
            <button
              onClick={() => setSelected(allSelected ? new Set() : new Set(list.map((file) => file.id)))}
              disabled={list.length === 0}
            >
              {allSelected ? 'Clear selection' : 'Select all'}
            </button>
            <button
              className="primary"
              disabled={selected.size === 0 || createJob.isPending}
              onClick={() => createJob.mutate([...selected])}
            >
              {createJob.isPending ? 'Queueing…' : `Process ${selected.size} item(s)`}
            </button>
          </div>
        }
      >
        {files.isLoading ? (
          <Empty>Loading imports…</Empty>
        ) : files.isError ? (
          <Alert>{(files.error as Error).message}</Alert>
        ) : list.length === 0 ? (
          <Empty>Nothing waiting. Import files above to get started.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Reference</th>
                  <th>File</th>
                  <th>Modality</th>
                  <th>Size</th>
                  <th>Scan</th>
                  <th>Imported</th>
                </tr>
              </thead>
              <tbody>
                {list.map((file) => (
                  <tr key={file.id}>
                    <td>
                      <input
                        type="checkbox"
                        style={{ width: 16 }}
                        checked={selected.has(file.id)}
                        aria-label={`Select ${file.originalName}`}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(file.id)) next.delete(file.id);
                            else next.add(file.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="mono">{file.reference}</td>
                    <td>
                      {file.originalName}
                      {file.duplicateOfId && <div className="pill warn">Possible duplicate</div>}
                    </td>
                    <td>
                      <span className="pill">{file.modality}</span>
                    </td>
                    <td className="mono">{formatBytes(file.sizeBytes)}</td>
                    <td className="mono muted">{file.scanStatus}</td>
                    <td className="mono muted">{formatDateTime(file.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
