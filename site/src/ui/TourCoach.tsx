import { IconClose } from "./icons.js";

// TourCoach: one short coach card per judges' step; deep links do the showing.
export function TourCoach({ step, total, title, line, onBack, onNext, onClose }: { step: number; total: number; title: string; line: string; onBack?: () => void; onNext?: () => void; onClose: () => void }) {
  return (
    <aside className="coach" aria-live="polite" aria-label="Judges tour">
      <div className="n">STEP {step} / {total}</div>
      <b>{title}</b>
      <p>{line}</p>
      <div className="row">
        <button className="btn ghost small" onClick={onClose} aria-label="Close the tour"><IconClose /></button>
        {onBack && <button className="btn ghost small" onClick={onBack}>Back</button>}
        {onNext && <button className="btn primary small" onClick={onNext}>Next</button>}
      </div>
    </aside>
  );
}
