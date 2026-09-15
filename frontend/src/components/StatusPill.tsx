import type { ItemStatus } from '../lib/types';

const SOLID: ItemStatus[] = ['COMPLETED', 'COMPILED'];

export function StatusPill({ status }: { status: string }) {
  const solid = SOLID.includes(status as ItemStatus);
  const dashed = status === 'FAILED' || status === 'CANCELLED' || status === 'UNAVAILABLE';
  return <span className={`pill${solid ? ' solid' : ''}${dashed ? ' warn' : ''}`}>{status.replace(/_/g, ' ')}</span>;
}
