import type { ReactNode } from "react";

// EmptyState: one line and an optional hint. While something loads, the line is a dot-matrix
// readout, like the dock clock waiting for its first record.
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  if (/^loading/i.test(title))
    return (
      <div className="empty loading" role="status">
        <span className="led">{title}</span>
        <span className="ledots" aria-hidden="true"><i /><i /><i /></span>
        {children}
      </div>
    );
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}
