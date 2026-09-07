import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Empty, Panel } from '../components/Panel';
import { StatusPill } from '../components/StatusPill';
import { api } from '../lib/api';
import { useProcessingEvents } from '../lib/events';
import { formatBytes, formatDateTime, formatValue, humanLabel } from '../lib/format';
import type { Compilation, CompilationRecord, ExportFormat, ExportJob } from '../lib/types';

const FORMATS: ExportFormat[] = ['XLSX', 'CSV', 'PDF', 'JSON', 'GEOJSON', 'TXT', 'DOCX'];

export function ExportPage() {
  const queryClient = useQueryClient();
  const [compilationId, setCompilationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);

  const compilations = useQuery({
    queryKey: ['compilations'],
    queryFn: () => api.get<{ compilations: Compilation[] }>('/exports/compilations'),
  });

  useEffect(() => {
    const first = compilations.data?.compilations[0];
    if (first && !compilationId) setCompilationId(first.id);
  }, [compilations.data, compilationId]);

  const records = useQuery({
    queryKey: ['compilation-records', compilationId],
    queryFn: () =>
      api.get<{ records: CompilationRecord[]; total: number }>(`/exports/compilations/${compilationId}/records?pageSize=50`),
    enabled: Boolean(compilationId),
  });

  const exports = useQuery({
    queryKey: ['exports'],
    queryFn: () => api.get<{ exports: ExportJob[] }>('/exports'),
    refetchInterval: 5000,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['exports'] });
    void queryClient.invalidateQueries({ queryKey: ['compilations'] });
    void queryClient.invalidateQueries({ queryKey: ['compilation-records'] });
  }, [queryClient]);

  useProcessingEvents(useCallback(() => invalidate(), [invalidate]));

  const createExport = useMutation({
    mutationFn: (format: ExportFormat) =>
      api.post('/exports', {
        compilationId,
        format,
        ...(hiddenColumns.length > 0 ? { options: { columns: visibleColumns } } : {}),
      }),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  async function download(job: ExportJob) {
    setError(null);
    try {
      const res = await api.get<{ url: string }>(`/exports/${job.id}/download`);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  const selected = compilations.data?.compilations.find((c) => c.id === compilationId) ?? null;
  const rows = records.data?.records ?? [];
  const columns = selected?.columns ?? [];
  const visibleColumns = columns.filter((column) => !hiddenColumns.includes(column));

  function toggleColumn(column: string) {
    setHiddenColumns((current) =>
      current.includes(column) ? current.filter((c) => c !== column) : [...current, column],
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Export</h1>
        <span className="muted">Exports are generated from the persisted compilation — the AI pipeline is not rerun.</span>
      </div>

      {error && <Alert>{error}</Alert>}

      <Panel
        title="Compiled dataset"
        actions={
          compilations.data && compilations.data.compilations.length > 0 ? (
            <select
              aria-label="Compilation"
              value={compilationId ?? ''}
              style={{ maxWidth: 360 }}
              onChange={(e) => setCompilationId(e.target.value)}
            >
              {compilations.data.compilations.map((compilation) => (
                <option key={compilation.id} value={compilation.id}>
                  {compilation.name} · {compilation.modality} · {compilation.recordCount} rows
                </option>
              ))}
            </select>
          ) : undefined
        }
      >
        {compilations.isLoading ? (
          <Empty>Loading compilations…</Empty>
        ) : !selected ? (
          <Empty>No compiled data yet. Process some imports first.</Empty>
        ) : rows.length === 0 ? (
          <Empty>This compilation has no rows yet.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  {visibleColumns.map((column) => (
                    <th key={column}>{humanLabel(column)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((record) => (
                  <tr key={record.id} style={record.removed ? { opacity: 0.4 } : undefined}>
                    <td className="mono">{record.rowKey}</td>
                    {visibleColumns.map((column) => (
                      <td key={column}>{formatValue(record.data[column])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Generate export">
        <div className="inline">
          {FORMATS.map((format) => (
            <button
              key={format}
              onClick={() => createExport.mutate(format)}
              disabled={!compilationId || createExport.isPending}
            >
              {format}
            </button>
          ))}
        </div>
        {columns.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p className="muted">Columns to include</p>
            <div className="inline" style={{ flexWrap: 'wrap' }}>
              {columns.map((column) => (
                <label key={column} className="inline" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={!hiddenColumns.includes(column)}
                    onChange={() => toggleColumn(column)}
                  />
                  {humanLabel(column)}
                </label>
              ))}
            </div>
          </div>
        )}
        <p className="muted mono" style={{ marginTop: 12 }}>
          Large exports run in a background worker; the file appears below when it is ready.
        </p>
      </Panel>

      <Panel title="Exports">
        {exports.isLoading ? (
          <Empty>Loading exports…</Empty>
        ) : (exports.data?.exports.length ?? 0) === 0 ? (
          <Empty>No exports generated yet.</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Dataset</th>
                  <th>Format</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {exports.data?.exports.map((job) => (
                  <tr key={job.id}>
                    <td className="mono">{job.reference}</td>
                    <td>{job.compilation?.name ?? '—'}</td>
                    <td>{job.format}</td>
                    <td>
                      <StatusPill status={job.status} />
                      {job.error && <div className="muted mono">{job.error}</div>}
                    </td>
                    <td className="mono">{job.rowCount ?? '—'}</td>
                    <td className="mono">{formatBytes(job.sizeBytes)}</td>
                    <td className="mono muted">{formatDateTime(job.createdAt)}</td>
                    <td>
                      <button onClick={() => download(job)} disabled={job.status !== 'COMPLETED'}>
                        Download
                      </button>
                    </td>
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
