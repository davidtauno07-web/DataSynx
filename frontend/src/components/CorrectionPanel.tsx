import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatValue, humanLabel } from '../lib/format';
import type { Correction, ProcessingResult } from '../lib/types';

type ValueType = 'text' | 'number' | 'boolean' | 'null';

const typeOf = (value: unknown): ValueType => {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null || value === undefined) return 'null';
  return 'text';
};

/** Keeps the corrected value in the field's own type; training data stays typed. */
function coerce(raw: string, type: ValueType): { value: unknown } | { error: string } {
  if (type === 'null') return { value: null };
  if (type === 'boolean') {
    const normalised = raw.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalised)) return { value: true };
    if (['false', 'no', '0'].includes(normalised)) return { value: false };
    return { error: 'Enter true or false' };
  }
  if (type === 'number') {
    const parsed = Number(raw.trim().replace(',', '.'));
    if (raw.trim() === '' || Number.isNaN(parsed)) return { error: 'Enter a number' };
    return { value: parsed };
  }
  return { value: raw };
}

/**
 * Human corrections are supervision records: they are stored beside the result
 * and never overwrite what the pipeline produced.
 */
export function CorrectionPanel({ result }: { result: ProcessingResult }) {
  const queryClient = useQueryClient();
  const data = (result.data ?? {}) as Record<string, unknown>;
  const fields = Object.entries(data)
    .filter(([, value]) => typeof value !== 'object' || value === null)
    .map(([key]) => key);

  const [field, setField] = useState(fields[0] ?? '');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<ValueType | ''>('');
  const valueType: ValueType = override || typeOf(data[field]);

  const corrections = useQuery({
    queryKey: ['corrections', result.id],
    queryFn: () =>
      api.get<{ corrections: Correction[]; total: number }>(
        `/training/corrections?resultId=${result.id}`,
      ),
  });

  const submit = useMutation({
    mutationFn: () => {
      const coerced = coerce(value, valueType);
      if ('error' in coerced) return Promise.reject(new Error(coerced.error));
      return api.post('/training/corrections', {
        resultId: result.id,
        field,
        correctedValue: coerced.value,
        ...(note ? { note } : {}),
      });
    },
    onSuccess: () => {
      setValue('');
      setNote('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['corrections', result.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (fields.length === 0) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <h3 className="uppercase muted">Correct a field</h3>
      <p className="muted">
        Corrections are kept as training data. The original result stays exactly as produced.
      </p>
      {error && <div className="alert">{error}</div>}
      <div className="inline" style={{ flexWrap: 'wrap' }}>
        <select
          aria-label="Field"
          value={field}
          onChange={(e) => {
            setField(e.target.value);
            setOverride('');
          }}
        >
          {fields.map((name) => (
            <option key={name} value={name}>
              {humanLabel(name)}
            </option>
          ))}
        </select>
        <select
          aria-label="Value type"
          value={valueType}
          onChange={(e) => setOverride(e.target.value as ValueType)}
        >
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="boolean">True / false</option>
          <option value="null">Not present</option>
        </select>
        <input
          aria-label="Corrected value"
          placeholder={valueType === 'null' ? 'Recorded as not present' : 'Corrected value'}
          value={value}
          disabled={valueType === 'null'}
          inputMode={valueType === 'number' ? 'decimal' : 'text'}
          onChange={(e) => setValue(e.target.value)}
        />
        <input
          aria-label="Note"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          onClick={() => submit.mutate()}
          disabled={!field || (valueType !== 'null' && !value) || submit.isPending}
        >
          Submit correction
        </button>
      </div>

      {(corrections.data?.corrections.length ?? 0) > 0 && (
        <div className="scroll" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Original</th>
                <th>Corrected</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {corrections.data?.corrections.map((correction) => (
                <tr key={correction.id}>
                  <td>{humanLabel(correction.field)}</td>
                  <td className="mono muted">{formatValue(correction.originalValue)}</td>
                  <td className="mono">{formatValue(correction.correctedValue)}</td>
                  <td>{correction.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
