import type { ReactNode } from "react";

// KpiTile: one label, one number. The top rule carries the meaning colour, if any.
export function KpiTile({ label, value, unit, tone, note }: { label: string; value: ReactNode; unit?: string; tone?: "money" | "ok" | "bad"; note?: ReactNode }) {
  return (
    <div className={`card kpi ${tone ?? ""}`}>
      <div className="k">{label}</div>
      <div className="v">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}
