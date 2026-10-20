import { clock } from "../format.js";
import type { TimelineItem } from "../model/model.js";

// Timeline: one row per record, title only; the record opens in a drawer.
export function Timeline({ items, timeZone, upTo, current, onOpen }: { items: TimelineItem[]; timeZone: string; upTo?: number; current?: number; onOpen: (t: TimelineItem) => void }) {
  let group = "";
  return (
    <ol className="tl">
      {items.flatMap((t, i) => {
        const g = t.synthetic ? "Driver · replayed" : "Workflow · agent · email";
        const rows = [];
        if (g !== group) {
          rows.push(<li className="grp" key={`g-${i}`}>{g}</li>);
          group = g;
        }
        rows.push(
          <li key={t.id}>
            <button className={upTo !== undefined && Date.parse(t.at) > upTo ? "future" : ""} aria-current={current === i ? "step" : undefined} onClick={() => onOpen(t)}>
              <span className="ts">{clock(t.at, timeZone)}</span>
              <span className={`dot ${t.tone}`} aria-hidden="true" />
              <span className="t">{t.title}</span>
              <span className="tags">{t.tone === "refused" && t.outcome ? <span className="tag refused">{t.outcome}</span> : <span className="tag">{t.services[0] ?? ""}</span>}</span>
            </button>
          </li>,
        );
        return rows;
      })}
    </ol>
  );
}
