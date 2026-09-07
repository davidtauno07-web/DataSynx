import { useState } from 'react';
import { formatValue, humanLabel } from '../lib/format';
import type { Measurement, ProcessingResult } from '../lib/types';
import { StatusPill } from './StatusPill';

type Tab = 'human' | 'json';

function MeasurementTable({ measurements }: { measurements: Measurement[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Subject</th>
          <th>Parameter</th>
          <th>Value</th>
          <th>Status</th>
          <th>Method</th>
        </tr>
      </thead>
      <tbody>
        {measurements.map((m, index) => (
          <tr key={`${m.subject}-${m.parameter}-${index}`}>
            <td>{m.subject}</td>
            <td>{humanLabel(m.parameter)}</td>
            <td className="mono">
              {m.value === null ? <span className="muted">Unavailable</span> : `${m.value}${m.unit ? ` ${m.unit}` : ''}`}
            </td>
            <td>
              <StatusPill status={m.status} />
              {m.reason && <div className="muted mono">{m.reason}</div>}
            </td>
            <td className="muted mono">{m.method ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Section({ label, value }: { label: string; value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const objects = value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
    if (objects.length === value.length) {
      const columns = Array.from(new Set(objects.flatMap((o) => Object.keys(o))));
      return (
        <div style={{ marginTop: 16 }}>
          <h3 className="uppercase muted">{humanLabel(label)}</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{humanLabel(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {objects.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c}>{formatValue(row[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    return (
      <div style={{ marginTop: 16 }}>
        <h3 className="uppercase muted">{humanLabel(label)}</h3>
        <ul className="list">
          {value.map((v, i) => (
            <li key={i}>{formatValue(v)}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <div style={{ marginTop: 16 }}>
        <h3 className="uppercase muted">{humanLabel(label)}</h3>
        <dl className="kv">
          {entries.map(([k, v]) => (
            <FieldRow key={k} label={k} value={v} />
          ))}
        </dl>
      </div>
    );
  }
  return null;
}

function FieldRow({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <dt>{humanLabel(label)}</dt>
      <dd>{formatValue(value)}</dd>
    </>
  );
}

/** Human-readable rendering is the default; raw JSON is available on demand. */
export function ResultView({ result }: { result: ProcessingResult }) {
  const [tab, setTab] = useState<Tab>('human');
  const summary = (result.data ?? {}) as Record<string, unknown>;
  const scalars = Object.entries(summary).filter(([, v]) => typeof v !== 'object' || v === null);
  const nested = Object.entries(summary).filter(([, v]) => typeof v === 'object' && v !== null);

  return (
    <div>
      <div className="inline" style={{ marginBottom: 16 }}>
        <span className="pill">{result.engine}</span>
        <span className="mono muted">v{result.engineVersion}</span>
        {result.demo && <span className="pill warn">Demo result — not real processing</span>}
        {result.confidence !== null && <span className="mono muted">confidence {result.confidence.toFixed(2)}</span>}
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'human'} onClick={() => setTab('human')}>
            Human view
          </button>
          <button role="tab" aria-selected={tab === 'json'} onClick={() => setTab('json')}>
            JSON
          </button>
        </div>
      </div>

      {result.warnings.length > 0 && (
        <div className="alert" role="status">
          <ul className="list" style={{ margin: 0 }}>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'json' ? (
        <pre className="scroll">{JSON.stringify({ ...result.data, measurements: result.measurements }, null, 2)}</pre>
      ) : (
        <>
          {scalars.length > 0 && (
            <dl className="kv">
              {scalars.map(([k, v]) => (
                <FieldRow key={k} label={k} value={v} />
              ))}
            </dl>
          )}
          {nested.map(([k, v]) => (
            <Section key={k} label={k} value={v} />
          ))}
          {result.measurements.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 className="uppercase muted">Measurements</h3>
              <MeasurementTable measurements={result.measurements} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
