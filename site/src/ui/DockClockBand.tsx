import { timeReadable } from "@dockclock/clause-engine";
import { releaseLine } from "../copy/provenance.js";
import { clock, hmm } from "../format.js";
import type { LoadDetail } from "../model/model.js";
import { IconPause, IconPlay } from "./icons.js";

// DockClockBand: the signature visual. A dock-door sign at night: a dot-matrix clock, free time as
// a dashed floor marking, billable time as a hazard stripe, every record pinned at its true time.
// Said under the band when a recorded time does not parse and the release line does not say so.
export const UNREADABLE_BAND_NOTE = "A recorded time could not be read, so it is left off the clock and a person reviews the load";

// The clock's recorded times, each drawn only when it parses.
const CLOCK_TIMES = ["arrivedAt", "releasedAt", "releasePinAt", "endedAt", "clockStartAt", "freeTimeEndsAt"] as const;

// The phases in which a truck can still be at the dock, so the clock may run to "as of".
const AT_DOCK_PHASES = new Set(["waiting_for_arrival", "at_dock"]);

export function DockClockBand({ load, cursor, playing, onPlay, title, legend, compact }: { load: LoadDetail; cursor?: string | null; playing?: boolean; onPlay?: () => void; title?: string; legend?: boolean; compact?: boolean }) {
  // A stored time that does not parse is left off the track (as if not recorded) and said in the
  // note, never drawn at NaN% or formatted (a RangeError would replace the whole console).
  const recorded = load.clock;
  const readable = Object.fromEntries(CLOCK_TIMES.map((k) => [k, timeReadable(recorded[k]) ? recorded[k] : null])) as Record<(typeof CLOCK_TIMES)[number], string | null>;
  const c = { ...recorded, ...readable };
  const unreadable = CLOCK_TIMES.some((k) => recorded[k] != null && c[k] === null);
  const tz = load.timeZone;
  const timeline = load.timeline.filter((e) => timeReadable(e.at));
  const times = timeline.map((e) => Date.parse(e.at));
  if (c.arrivedAt) times.push(Date.parse(c.arrivedAt));
  if (c.releasePinAt) times.push(Date.parse(c.releasePinAt));
  // When the clock stopped: the Released tap (an older load's pin), or the close of a load that
  // ended without a release. Nothing past it is billed.
  const stopAt = c.releasedAt ?? c.endedAt ?? null;
  const ended = !c.releasedAt && Boolean(c.endedAt);
  // A release or close that was recorded but does not parse: the truck has left, but when is not
  // known, so no stop is drawn, nothing is counted and the note says a person reviews the load.
  const stopUnreadable = !stopAt && (Boolean(recorded.releasedAt) || Boolean(recorded.endedAt));
  // A load still at the dock: the clock runs to "as of", and the track ends there. A load past the
  // dock (sealing, awaiting approval, closed) never runs to "as of".
  const atDockNow = !stopAt && !stopUnreadable && AT_DOCK_PHASES.has(load.summary.phase);
  const now = atDockNow && load.asOf && timeReadable(load.asOf) ? load.asOf : null;
  if (now) times.push(Date.parse(now));
  // Neither live nor stopped (an older closed record): the clock ends at its last record, never today.
  const lastRecord = timeline.map((e) => e.at).sort().at(-1) ?? c.arrivedAt;
  const clockEnd = stopAt ?? now ?? (stopUnreadable ? null : lastRecord);
  // While the truck is still at the dock, keep the end of free time on the track.
  if (now && c.freeTimeEndsAt) times.push(Date.parse(c.freeTimeEndsAt));
  if (c.arrivedAt) {
    const first = Math.min(...times);
    if (Date.parse(c.arrivedAt) - first > 0 && !stopAt) times.splice(0, times.length, ...times.filter((t) => t >= Date.parse(c.arrivedAt!)));
  }
  // With no readable time at all the track is empty rather than NaN.
  if (times.length === 0) times.push(0);
  let start = Math.min(...times);
  let end = Math.max(...times);
  // A sealed load's later records (a seal hours on, an approval that timed out days on) would
  // squeeze the dock stay into a sliver. Scale the track to the stay plus a margin and park
  // anything later in a short "later" stub at the right end.
  let lateFrom = Number.POSITIVE_INFINITY;
  if (c.arrivedAt && stopAt) {
    const a = Date.parse(c.arrivedAt);
    const r = Date.parse(stopAt);
    const pad = Math.max(10 * 60_000, (r - a) * 0.5);
    start = Math.max(start, a - pad);
    if (end > r + pad) {
      lateFrom = r + pad;
      end = Math.max(r, ...times.filter((t) => t <= lateFrom));
    }
  }
  const late = Number.isFinite(lateFrom);
  const span = late ? 84 : 100;
  const pct = (iso: string) => {
    const t = Date.parse(iso);
    if (t > lateFrom) return 94;
    if (t < start) return 0;
    return end === start ? 0 : Math.min(span, ((t - start) / (end - start)) * span);
  };
  // In and out a few percent apart would print over each other: one label then carries both.
  const merged = Boolean(c.arrivedAt && c.releasedAt && pct(c.releasedAt) - pct(c.arrivedAt) < 16);
  const limit = cursor && timeReadable(cursor) ? Date.parse(cursor) : Number.POSITIVE_INFINITY;
  const upTo = (iso: string | null) => Math.min(Date.parse(iso ?? new Date(limit === Infinity ? Date.now() : limit).toISOString()), limit);
  const width = (from: string, to: string) => Math.max(0, pct(new Date(Math.min(Date.parse(to), limit)).toISOString()) - pct(from));
  const atDock = c.arrivedAt && clockEnd ? Math.max(0, (upTo(clockEnd) - Date.parse(c.arrivedAt)) / 60_000) : 0;
  const billable = c.freeTimeEndsAt && clockEnd ? Math.max(0, (upTo(clockEnd) - Date.parse(c.freeTimeEndsAt)) / 60_000) : 0;
  const release = releaseLine(recorded, tz) ?? (unreadable ? UNREADABLE_BAND_NOTE : null);
  const early = c.arrivedAt && c.clockStartAt && Date.parse(c.arrivedAt) < Date.parse(c.clockStartAt);
  return (
    <section className={`dockband ${compact ? "compact" : ""}`} aria-label="Dock clock">
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
          {early && c.arrivedAt && c.clockStartAt && (
            <div className="early">
              <div className="lbl">Early</div>
              <b>{hmm((Date.parse(c.clockStartAt) - Date.parse(c.arrivedAt)) / 60_000)}</b>
            </div>
          )}
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
            {merged && c.releasedAt && (
              <>
                <span className="arrow">→</span>
                {clock(c.releasedAt, tz)}
                <span>out</span>
              </>
            )}
          </div>
        )}
        {c.releasedAt && (
          <div className={`mark ${merged ? "tick" : ""} ${pct(c.releasedAt) > 80 ? "end" : ""}`} style={{ left: `${pct(c.releasedAt)}%` }}>
            {!merged && (
              <>
                {clock(c.releasedAt, tz)}
                <span>out</span>
              </>
            )}
          </div>
        )}
        {ended && c.endedAt && (
          <div className={`mark ${pct(c.endedAt) > 80 ? "end" : ""}`} style={{ left: `${pct(c.endedAt)}%` }}>
            {clock(c.endedAt, tz)}
            <span>ended without a release</span>
          </div>
        )}
        {c.releasePinAt && <div className="mark tick" style={{ left: `${pct(c.releasePinAt)}%` }} title={`Release pin ${clock(c.releasePinAt, tz)}`} />}
        {late && (
          <div className="mark later" style={{ left: "94%" }}>
            <span>later</span>
          </div>
        )}
        <div className="bar">
          {early && c.arrivedAt && c.clockStartAt && <div className="seg early" style={{ left: `${pct(c.arrivedAt)}%`, width: `${width(c.arrivedAt, c.clockStartAt)}%` }} />}
          {c.clockStartAt && c.freeTimeEndsAt && <div className="seg free" style={{ left: `${pct(c.clockStartAt)}%`, width: `${width(c.clockStartAt, c.freeTimeEndsAt)}%` }} />}
          {c.freeTimeEndsAt && clockEnd && Date.parse(clockEnd) > Date.parse(c.freeTimeEndsAt) && (
            <div className="seg bill" style={{ left: `${pct(c.freeTimeEndsAt)}%`, width: `${width(c.freeTimeEndsAt, clockEnd)}%` }} />
          )}
          {now && <div className="seg cursor live" style={{ left: `${pct(now)}%` }} />}
          {late && <div className="brk" style={{ left: "88%" }} />}
          {cursor && Number.isFinite(limit) && <div className="seg cursor" style={{ left: `${pct(cursor)}%` }} />}
        </div>
        <div className="pins">
          {(() => {
            // Pins closer than about 1% of the track stack into rows instead of overlapping.
            const lastInRow: number[] = [];
            return timeline
              .filter((e) => e.tone !== "neutral")
              .map((e) => {
                const x = pct(e.at);
                let row = lastInRow.findIndex((r) => x - r >= 1.2);
                if (row < 0) row = lastInRow.length;
                lastInRow[row] = x;
                return <span key={e.id} className={`pin ${e.tone} ${Date.parse(e.at) > limit ? "future" : ""}`} style={{ left: `${x}%`, top: 52 + row * 11 }} title={`${clock(e.at, tz)} ${e.title}`} />;
              });
          })()}
        </div>
      </div>
      {release && !compact && <p className="small bandnote">{release}</p>}
      {(legend ?? true) && (
        <div className="bandlegend" aria-hidden="true">
          {(["refused", "money", "agent", "ok"] as const)
            .filter((t) => load.timeline.some((e) => e.tone === t))
            .map((t) => (
              <span key={t}><i className={`pin ${t}`} />{{ refused: "refused", money: "money", agent: "agent", ok: "done" }[t]}</span>
            ))}
        </div>
      )}
    </section>
  );
}
