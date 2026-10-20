import { clock, hmm } from "../format.js";
import type { LoadDetail } from "../model/model.js";
import { IconPause, IconPlay } from "./icons.js";

// DockClockBand: the signature visual. A dock-door sign at night: a dot-matrix clock, free time as
// a dashed floor marking, billable time as a hazard stripe, every record pinned at its true time.
export function DockClockBand({ load, cursor, playing, onPlay, title, legend }: { load: LoadDetail; cursor?: string | null; playing?: boolean; onPlay?: () => void; title?: string; legend?: boolean }) {
  const c = load.clock;
  const tz = load.timeZone;
  const times = load.timeline.map((e) => Date.parse(e.at));
  if (c.arrivedAt) times.push(Date.parse(c.arrivedAt));
  // A load still at the dock: the clock runs to "as of", and the track ends there.
  const now = !c.releasedAt && load.asOf ? load.asOf : null;
  if (now) times.push(Date.parse(now));
  const start = Math.min(...times);
  const end = Math.max(...times);
  const pct = (iso: string) => (end === start ? 0 : ((Date.parse(iso) - start) / (end - start)) * 100);
  const limit = cursor ? Date.parse(cursor) : Number.POSITIVE_INFINITY;
  const upTo = (iso: string | null) => Math.min(Date.parse(iso ?? now ?? new Date(limit === Infinity ? Date.now() : limit).toISOString()), limit);
  const width = (from: string, to: string) => Math.max(0, pct(new Date(Math.min(Date.parse(to), limit)).toISOString()) - pct(from));
  const atDock = c.arrivedAt ? Math.max(0, (upTo(c.releasedAt) - Date.parse(c.arrivedAt)) / 60_000) : 0;
  const billable = c.freeTimeEndsAt ? Math.max(0, (upTo(c.releasedAt) - Date.parse(c.freeTimeEndsAt)) / 60_000) : 0;
  const early = c.arrivedAt && c.clockStartAt && Date.parse(c.arrivedAt) < Date.parse(c.clockStartAt);
  return (
    <section className="dockband" aria-label="Dock clock">
      <div className="row1">
        <div>
          <div className="lbl">{title ? `${title} ∙ at the dock` : "At the dock"}</div>
          <div className="led" aria-label={`${hmm(atDock)} hours and minutes at the dock`}>
            {hmm(atDock).split(":")[0]}
            <span className="colon">:</span>
            {hmm(atDock).split(":")[1]}
            <small>h:mm</small>
          </div>
        </div>
        <div className="split">
          <div>
            <div className="lbl">Free</div>
            <b>{hmm(load.clause.freeTimeMinutes)}</b>
          </div>
          <div className="bill">
            <div className="lbl">Billable</div>
            <b>{hmm(billable)}</b>
          </div>
          {onPlay && (
            <button className="playbtn" onClick={onPlay} aria-label={playing ? "Pause the replay" : "Play the replay"}>
              {playing ? <IconPause width={14} /> : <IconPlay width={14} />}
              {playing ? "Pause" : "Play"}
            </button>
          )}
        </div>
      </div>
      <div className="track">
        {c.arrivedAt && (
          <div className="mark start" style={{ left: `${pct(c.arrivedAt)}%` }}>
            {clock(c.arrivedAt, tz)}
            <span>in</span>
          </div>
        )}
        {c.releasedAt && (
          <div className={`mark ${pct(c.releasedAt) > 80 ? "end" : ""}`} style={{ left: `${pct(c.releasedAt)}%` }}>
            {clock(c.releasedAt, tz)}
            <span>out</span>
          </div>
        )}
        <div className="bar">
          {early && c.arrivedAt && c.clockStartAt && <div className="seg early" style={{ left: `${pct(c.arrivedAt)}%`, width: `${width(c.arrivedAt, c.clockStartAt)}%` }} />}
          {c.clockStartAt && c.freeTimeEndsAt && <div className="seg free" style={{ left: `${pct(c.clockStartAt)}%`, width: `${width(c.clockStartAt, c.freeTimeEndsAt)}%` }} />}
          {c.freeTimeEndsAt && (c.releasedAt ?? now) && Date.parse((c.releasedAt ?? now)!) > Date.parse(c.freeTimeEndsAt) && (
            <div className="seg bill" style={{ left: `${pct(c.freeTimeEndsAt)}%`, width: `${width(c.freeTimeEndsAt, (c.releasedAt ?? now)!)}%` }} />
          )}
          {now && <div className="seg cursor live" style={{ left: `${pct(now)}%` }} />}
          {cursor && <div className="seg cursor" style={{ left: `${pct(cursor)}%` }} />}
        </div>
        <div className="pins">
          {load.timeline
            .filter((e) => e.tone !== "neutral")
            .map((e) => (
              <span key={e.id} className={`pin ${e.tone} ${Date.parse(e.at) > limit ? "future" : ""}`} style={{ left: `${pct(e.at)}%` }} title={`${clock(e.at, tz)} ${e.title}`} />
            ))}
        </div>
      </div>
      {legend && (
        <div className="bandlegend" aria-hidden="true">
          <span><i className="pin refused" />refused</span>
          <span><i className="pin money" />money</span>
          <span><i className="pin agent" />agent</span>
          <span><i className="pin ok" />done</span>
        </div>
      )}
    </section>
  );
}
