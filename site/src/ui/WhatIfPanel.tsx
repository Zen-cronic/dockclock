import { useState } from "react";
import { BOL_TOLERANCE_MINUTES, RELEASE_PIN_WINDOW_MINUTES, releasePinGapMinutes, type LoadEvidence } from "@dockclock/clause-engine";
import { baseline, clauseSpec, REASON_WORDS, run } from "../engine.js";
import { clock, duration, usd } from "../format.js";
import type { LoadDetail } from "../model/model.js";
import { Mark, ProvenanceBadge, Verdict } from "./badges.js";

// 24 -> "1 day", 168 -> "7 days", 36 -> "36 h".
export function hoursWords(h: number): string {
  if (h % 24 !== 0) return `${h} h`;
  return h === 24 ? "1 day" : `${h / 24} days`;
}

interface WhatIf {
  id: string;
  label: string;
  hint: string;
  applies: boolean;
  apply: (e: LoadEvidence) => LoadEvidence;
}

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const iso = (ms: number) => new Date(ms).toISOString();

// A release inside free time and after the arrival, even on a 5-minute clause: up to 10 min early,
// never more than half the free time. The paper's out-time sits just before it.
export function earlyRelease(d: LoadDetail): { out: string; paperOut: string } | null {
  const free = d.clock.freeTimeEndsAt;
  if (!free) return null;
  const f = Date.parse(free);
  const a = d.clock.arrivedAt ? Date.parse(d.clock.arrivedAt) : f - 20 * 60_000;
  const lead = Math.min(10 * 60_000, Math.max(60_000, (f - a) / 2));
  return { out: iso(f - lead), paperOut: iso(f - lead - Math.min(2 * 60_000, lead / 5)) };
}

// Moves the Released tap to `at` and the release pin with it, keeping the recorded gap (held inside
// the confirm window), so the early release is decided on free time alone.
export function moveRelease(e: LoadEvidence, at: string): LoadEvidence {
  if (!e.released) return e;
  const out: LoadEvidence = { ...e, released: { ...e.released, at } };
  if (!e.releasePinAt) return out;
  const gap = releasePinGapMinutes(e.released.at, e.releasePinAt);
  const kept = Math.max(-RELEASE_PIN_WINDOW_MINUTES, Math.min(RELEASE_PIN_WINDOW_MINUTES, gap));
  return { ...out, releasePinAt: iso(Date.parse(at) + kept * 60_000) };
}

// A pin this long after the Released tap is past the confirm window.
const PIN_LATE_MINUTES = RELEASE_PIN_WINDOW_MINUTES + 2;

export function whatIfs(d: LoadDetail): WhatIf[] {
  const spec = clauseSpec(d.clause.id);
  const early = earlyRelease(d);
  const late = d.clock.freeTimeEndsAt ? iso(Date.parse(d.clock.freeTimeEndsAt) + 2 * 60_000) : null;
  const tz = d.timeZone;
  return [
    {
      id: "early",
      label: "Driver left before free time ended",
      hint: early ? `out at ${clock(early.out, tz)}` : "",
      applies: Boolean(early),
      apply: (e) => (early ? { ...moveRelease(e, early.out), bol: e.bol ? { ...e.bol, checkOut: early.paperOut } : e.bol } : e),
    },
    {
      id: "late",
      label: "Driver arrived 20 min late",
      hint: "after the appointment",
      applies: spec.requireOnTimeArrival,
      apply: (e) => {
        const t = Date.parse(e.appointmentAt) + 20 * 60_000;
        return { ...e, arrived: e.arrived ? { ...e.arrived, at: iso(t) } : e.arrived, bol: e.bol ? { ...e.bol, checkIn: iso(t + 2 * 60_000) } : e.bol };
      },
    },
    {
      id: "pinLate",
      label: `Pin ${PIN_LATE_MINUTES} min after Released`,
      hint: `limit ${RELEASE_PIN_WINDOW_MINUTES} min`,
      applies: Boolean(d.verdict?.engineInput.releasePinAt),
      apply: (e) => (e.released ? { ...e, releasePinAt: iso(Date.parse(e.released.at) + PIN_LATE_MINUTES * 60_000) } : e),
    },
    { id: "unsigned", label: "Receiver didn't sign the paper", hint: "no signed bill of lading", applies: true, apply: (e) => ({ ...e, bol: e.bol ? { ...e.bol, signed: false } : e.bol }) },
    { id: "conflict", label: "Paper out-time 40 min after the Released tap", hint: "paper and phone disagree", applies: true, apply: (e) => ({ ...e, bol: e.bol && e.released ? { ...e.bol, checkOut: iso(Date.parse(e.released.at) + 40 * 60_000) } : e.bol }) },
    {
      id: "noticeLate",
      label: "Notice sent after free time ended",
      hint: late ? `sent ${clock(late, tz)}` : "",
      applies: spec.noticeLeadMinutes !== null && Boolean(late),
      apply: (e) => ({ ...e, noticeSentAt: late ?? e.noticeSentAt }),
    },
    { id: "window", label: `Claim filed ${hoursWords(spec.claimWindowHours + 24)} after release`, hint: `contract allows ${hoursWords(spec.claimWindowHours)}`, applies: true, apply: (e) => ({ ...e, evaluatedAt: e.released ? iso(Date.parse(e.released.at) + (spec.claimWindowHours + 24) * 3_600_000) : e.evaluatedAt }) },
  ];
}

export function recordedInput(d: LoadDetail): LoadEvidence | null {
  const i = d.verdict?.engineInput;
  // Inputs that do not reproduce the sealed decision are never re-run (the API marks them).
  if (!i || d.verdict?.whatIfAvailable === false) return null;
  return { loadId: d.summary.id, clauseId: d.clause.id, facility: d.snapshot?.load.facility.id ?? d.summary.facility, appointmentAt: i.appointmentAt, arrived: i.arrived, released: i.released, ...(i.releasePinAt ? { releasePinAt: i.releasePinAt } : {}), bol: i.bol, status214: i.status214, noticeSentAt: i.noticeSentAt, shipperConfirmed: i.shipperConfirmed, evaluatedAt: i.evaluatedAt };
}

const RULES: Array<[string, (d: LoadDetail) => string, string[]]> = [
  ["Free time", (d) => duration(d.clause.freeTimeMinutes), ["WITHIN_FREE_TIME"]],
  ["On time", (d) => (d.clause.requireOnTimeArrival ? "required" : "not required"), ["LATE_ARRIVAL"]],
  ["Signed paper", (d) => (d.clause.acceptedRecords.includes("signed_bol_times") ? "both times" : "not required"), ["NO_STATEMENT_OF_RECORD"]],
  ["Paper vs phone", () => `within ${BOL_TOLERANCE_MINUTES} min`, ["BOL_TIMESTAMP_CONFLICT", "PIN_OUTSIDE_GEOFENCE", "RELEASE_PIN_LATE"]],
  ["Notice", (d) => (d.clause.noticeLeadMinutes === null ? "not required" : "before free time ends"), ["NOTICE_MISSING", "NOTICE_LATE"]],
  ["Claim window", (d) => hoursWords(d.clause.claimWindowHours), ["CLAIM_WINDOW_EXPIRED"]],
];

type Result = ReturnType<typeof run>;

// Recorded vs computed. Until a fact changes, the computed side waits instead of repeating the amount.
export function Outcome({ recorded, computed }: { recorded: Result; computed: Result | null }) {
  return (
    <div className="compare">
      <div className="card">
        <ProvenanceBadge kind="replay" label="Recorded" />
        <div style={{ marginTop: 14 }}>
          <Verdict verdict={recorded.verdict} amountUsd={recorded.amountUsd} large />
        </div>
      </div>
      <div className={`card${computed ? "" : " waiting"}`} aria-live="polite">
        <ProvenanceBadge kind="computed" />
        {computed ? (
          <>
            <div style={{ marginTop: 14 }}>
              <Verdict verdict={computed.verdict} amountUsd={computed.amountUsd} large />
            </div>
          </>
        ) : (
          <p className="wait">Flip a switch to see what the contract decides.</p>
        )}
      </div>
    </div>
  );
}

// When the rebuilt inputs disagree with the pack: the sealed evaluation, and no What-if.
function SealedOnly({ load }: { load: LoadDetail }) {
  const v = load.verdict!;
  return (
    <div className="compare">
      <div className="card">
        <ProvenanceBadge kind="recorded" label="Sealed" />
        <div style={{ marginTop: 14 }}>
          <Verdict verdict={v.verdict} amountUsd={v.amountUsd} large />
        </div>
        <p className="small" style={{ marginTop: 10 }}>{v.whatIfNote ?? "What-if is off for this load."}</p>
      </div>
    </div>
  );
}

// WhatIfPanel: the workflow's own clause engine, re-run in the browser with one fact changed.
export function WhatIfPanel({ load, initial }: { load: LoadDetail; initial?: string[] }) {
  const [on, setOn] = useState<Set<string>>(new Set(initial ?? []));
  if (load.verdict?.whatIfAvailable === false) return <SealedOnly load={load} />;
  const base = recordedInput(load);
  if (!base) return <p className="small">No engine inputs recorded for this load.</p>;
  // Only the facts this contract can turn on; a rule it doesn't have stays in the list on the right.
  const all = whatIfs(load).filter((w) => w.applies);
  let changed = base;
  for (const w of all) if (on.has(w.id)) changed = w.apply(changed);
  const recorded = run(base);
  const computed = run(changed);
  const ask = baseline(changed);
  const reasons = computed.reasons.filter((r) => r !== "CAP_APPLIED");
  const any = on.size > 0;
  const toggle = (id: string, v: boolean) => {
    const next = new Set(on);
    if (v) next.add(id);
    else next.delete(id);
    setOn(next);
  };
  return (
    <div className="whatif">
      <p className="whatif-lede">Change a fact. The contract's rules run again in your browser.</p>
      <div className="whatif-sw">
        {all.map((w) => (
          <label className="switch" key={w.id}>
            <input type="checkbox" role="switch" checked={on.has(w.id)} onChange={(e) => toggle(w.id, e.target.checked)} />
            {w.label}
            <span className="hint">{w.hint}</span>
          </label>
        ))}
      </div>
      <div className="whatif-out">
        <Outcome recorded={recorded} computed={any ? computed : null} />
        {any && reasons.length > 0 && <p className="whatif-why"><Mark ok={false} />{sentence(REASON_WORDS[reasons[0]!])}.</p>}
      </div>
      <div className="whatif-rules">
        <div className="card">
          <ul className="rules">
            {RULES.map(([name, value, codes]) => {
              const failed = any && codes.some((c) => reasons.includes(c as never));
              return (
                <li key={name} className={failed ? "failed" : ""}>
                  <span className="mk"><Mark ok={!failed} /></span>
                  <b>{name}</b>
                  <span>{value(load)}{failed ? <span className="vh"> failed</span> : null}</span>
                </li>
              );
            })}
          </ul>
        </div>
        <p className="small" style={{ marginTop: 10 }}>Billing every stop over 2 hours would ask {ask.filed ? usd(ask.amountUsd) : "$0.00"}{ask.filed && computed.verdict !== "BILLABLE" ? ", and the contract can refuse it" : ""}.</p>
      </div>
    </div>
  );
}

// The judges path's short version: a few named facts, the two stamps and the reason. No rule table.
export function QuickWhatIf({ load, ids }: { load: LoadDetail; ids: string[] }) {
  const [on, setOn] = useState<Set<string>>(new Set());
  if (load.verdict?.whatIfAvailable === false) return <SealedOnly load={load} />;
  const base = recordedInput(load);
  const shown = whatIfs(load).filter((w) => w.applies && ids.includes(w.id));
  if (!base || shown.length === 0) return <p className="small">No engine inputs recorded for this load.</p>;
  let changed = base;
  for (const w of shown) if (on.has(w.id)) changed = w.apply(changed);
  const computed = run(changed);
  const reasons = computed.reasons.filter((r) => r !== "CAP_APPLIED");
  const toggle = (id: string, v: boolean) => {
    const next = new Set(on);
    if (v) next.add(id);
    else next.delete(id);
    setOn(next);
  };
  return (
    <>
      <div className="quick-sw">
        {shown.map((w) => (
          <label className="switch" key={w.id}>
            <input type="checkbox" role="switch" checked={on.has(w.id)} onChange={(e) => toggle(w.id, e.target.checked)} />
            {w.label}
            <span className="hint">{w.hint}</span>
          </label>
        ))}
      </div>
      <Outcome recorded={run(base)} computed={on.size ? computed : null} />
      {on.size > 0 && reasons.length > 0 && <p className="whatif-why"><Mark ok={false} />{sentence(REASON_WORDS[reasons[0]!])}.</p>}
    </>
  );
}
