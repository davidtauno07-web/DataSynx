import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}

export function Panel({ title, actions, children, bodyClassName }: PanelProps) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="uppercase">{title}</h2>
        {actions}
      </header>
      <div className={bodyClassName ?? 'panel-body'}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Alert({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'info' }) {
  return (
    <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
