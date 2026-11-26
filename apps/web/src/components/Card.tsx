import type { ReactNode } from 'react';

export function Card({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value ?? '—'}</div>
    </div>
  );
}
