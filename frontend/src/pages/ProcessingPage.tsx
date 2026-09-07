import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Alert, Empty, Panel } from '../components/Panel';
import { CorrectionPanel } from '../components/CorrectionPanel';
import { ResultView } from '../components/ResultView';
import { SourcePreview } from '../components/SourcePreview';
import { StatusPill } from '../components/StatusPill';
import { api } from '../lib/api';
import { useProcessingEvents } from '../lib/events';
import type { ItemStatus, ProcessingItem, ProcessingJob, ProcessingResult } from '../lib/types';

interface CurrentResponse {
  job: ProcessingJob;
  item: (ProcessingItem & { results?: ProcessingResult[] }) | null;
  result: ProcessingResult | null;
}

interface CommandResponse {
  operation: { kind: string };
  status: string;
  message: string;
  data?: unknown;
}

const STAGES: { key: string; label: string; reached: ItemStatus[] }[] = [
  { key: 'recognised', label: 'File recognised', reached: ['PREPROCESSING', 'PROCESSING', 'STRUCTURING', 'COMPILED', 'COMPLETED'] },
  { key: 'extracted', label: 'Data extracted', reached: ['STRUCTURING', 'COMPILED', 'COMPLETED'] },
  { key: 'structured', label: 'Data structured', reached: ['COMPILED', 'COMPLETED'] },
  { key: 'compiled', label: 'Added to compilation', reached: ['COMPLETED'] },
];

export function ProcessingPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [commandInput, setCommandInput] = useState('');
  const [commandResult, setCommandResult] = useState<CommandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<{ jobs: ProcessingJob[] }>('/processing/jobs?pageSize=20'),
  });

  const jobId = params.get('job') ?? jobs.data?.jobs[0]?.id ?? null;

  const current = useQuery({
    queryKey: ['job-current', jobId],
    queryFn: () => api.get<CurrentResponse>(`/processing/jobs/${jobId}/current`),
    enabled: Boolean(jobId),
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['job-current'] });
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
  }, [queryClient]);

  useProcessingEvents(useCallback(() => invalidate(), [invalidate]));

  // Polling backstop: the live view stays correct even if SSE is interrupted.
  useEffect(() => {
    const job = current.data?.job;
    if (!job || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return;
    const timer = window.setInterval(invalidate, 3000);
    return () => window.clearInterval(timer);
  }, [current.data?.job, invalidate]);

  const command = useMutation({
    mutationFn: (input: string) => api.post<CommandResponse>('/processing/commands', { input, jobId: jobId ?? undefined }),
    onSuccess: (res) => {
      setCommandResult(res);
      setCommandInput('');
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const retry = useMutation({
    mutationFn: () => api.post<{ retried: number }>(`/processing/jobs/${jobId}/retry`),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/processing/jobs/${jobId}/cancel`),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  const job = current.data?.job ?? null;
  const item = current.data?.item ?? null;
  const result = current.data?.result ?? null;

  const progress = useMemo(() => {
    if (!job || job.totalItems === 0) return 0;
    return Math.round(((job.doneItems + job.failedItems) / job.totalItems) * 100);
  }, [job]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Processing</h1>
        {jobs.data && jobs.data.jobs.length > 0 && (
          <select
            value={jobId ?? ''}
            aria-label="Processing job"
            style={{ maxWidth: 380 }}
            onChange={(e) => setParams({ job: e.target.value })}
          >
            {jobs.data.jobs.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.reference} · {entry.name} · {entry.status}
              </option>
            ))}
          </select>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (commandInput.trim()) command.mutate(commandInput.trim());
        }}
        className="inline"
      >
        <input
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          placeholder="Ask DataSynx to process, calculate, filter, or reprocess..."
          aria-label="Processing command"
        />
        <button className="primary" type="submit" disabled={command.isPending || !commandInput.trim()}>
          {command.isPending ? 'Running…' : 'Run'}
        </button>
      </form>

      {error && <Alert>{error}</Alert>}
      {commandResult && (
        <Alert kind="info">
          <div className="inline">
            <span className="pill">{commandResult.operation.kind}</span>
            <span>{commandResult.message}</span>
          </div>
          {commandResult.data !== undefined && commandResult.data !== null && (
            <pre className="scroll" style={{ marginTop: 8 }}>
              {JSON.stringify(commandResult.data, null, 2)}
            </pre>
          )}
        </Alert>
      )}

      {!jobId ? (
        <Empty>No processing jobs yet. Import files and queue a batch from the Import page.</Empty>
      ) : (
        <>
          <Panel
            title="Batch"
            actions={
              <div className="tabs">
                <button onClick={() => retry.mutate()} disabled={!job || job.failedItems === 0 || retry.isPending}>
                  Retry failed ({job?.failedItems ?? 0})
                </button>
                <button
                  onClick={() => cancel.mutate()}
                  disabled={!job || ['COMPLETED', 'CANCELLED', 'FAILED'].includes(job.status)}
                >
                  Cancel
                </button>
              </div>
            }
          >
            {job ? (
              <div className="stack">
                <div className="inline">
                  <span className="mono">{job.reference}</span>
                  <StatusPill status={job.status} />
                  <strong className="mono">
                    {job.doneItems + job.failedItems} / {job.totalItems}
                  </strong>
                  <span className="muted">
                    {job.doneItems} completed · {job.failedItems} failed
                  </span>
                </div>
                <div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{ width: `${progress}%` }} />
                </div>
              </div>
            ) : (
              <Empty>Loading job…</Empty>
            )}
          </Panel>

          <div className="split">
            <Panel title="Original / Live Source">
              {item && (
                <div className="inline" style={{ marginBottom: 12 }}>
                  <span className="mono">{item.file.reference}</span>
                  <span>{item.file.originalName}</span>
                  <span className="pill">{item.file.modality}</span>
                  <StatusPill status={item.status} />
                </div>
              )}
              <SourcePreview file={item?.file ?? null} />
            </Panel>

            <Panel title="Processed Data">
              {!item ? (
                <Empty>Waiting for the first item…</Empty>
              ) : item.status === 'FAILED' ? (
                <Alert>
                  Item failed after {item.attempts} attempt(s): {item.error ?? 'unknown error'}. Successful results in
                  this batch are unaffected — use “Retry failed”.
                </Alert>
              ) : result ? (
                <>
                  <ResultView result={result} />
                  <CorrectionPanel result={result} />
                </>
              ) : (
                <div className="stack">
                  <p className="muted">Processing {item.file.originalName}…</p>
                  <ul className="checks">
                    {STAGES.map((stage) => (
                      <li key={stage.key} data-done={stage.reached.includes(item.status)}>
                        {stage.reached.includes(item.status) ? '✓' : '·'} {stage.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
