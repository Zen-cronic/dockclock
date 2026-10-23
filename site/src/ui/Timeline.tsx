import { clock, dayShort } from "../format.js";
import type { TimelineItem } from "../model/model.js";

const OUTCOMES: Record<string, string> = {
  REJECTED_OUT_OF_ORDER: "out of order",
  IGNORED_DUPLICATE_TAP: "duplicate tap",
  REJECTED_STALE_BUTTON: "old button",
  RESENT_OVER_RCS: "resent on RCS",
};

export function outcomeWords(code: string): string {
  return OUTCOMES[code] ?? code.toLowerCase().replace(/_/g, " ");
}

// Timeline: one row per record, title only; the record opens in a drawer.
export function Timeline({ items, timeZone, upTo, current, onOpen }: { items: TimelineItem[]; timeZone: string; upTo?: number; current?: number; onOpen: (t: TimelineItem) => void }) {
  // A record list that runs past one local day gets a date row at each change of day.
  const days = new Set(items.map((t) => dayShort(t.at, timeZone)));
  return (
    <ol className="tl">
      {items.flatMap((t, i) => {
        const rows = [];
        const day = dayShort(t.at, timeZone);
        if (days.size > 1 && (i === 0 || dayShort(items[i - 1]!.at, timeZone) !== day))
          rows.push(<li key={`day-${day}`} className="grp">{day}</li>);
        rows.push(
          <li key={t.id}>
            <button className={upTo !== undefined && Date.parse(t.at) > upTo ? "future" : ""} aria-current={current === i ? "step" : undefined} onClick={() => onOpen(t)}>
              <span className="ts">{clock(t.at, timeZone)}</span>
              <span className={`dot ${t.tone}`} aria-hidden="true" />
              <span className="t">
                {t.title}
                {t.tone === "refused" && t.outcome ? <span className="why"> ∙ {outcomeWords(t.outcome)}</span> : null}
              </span>
              <span className="src-tag">{t.synthetic ? "driver ∙ replayed" : ""}</span>
            </button>
          </li>,
        );
        return rows;
      })}
    </ol>
  );
}
