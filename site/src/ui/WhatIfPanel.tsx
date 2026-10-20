import { useState } from "react";
import type { LoadEvidence } from "@dockclock/clause-engine";
import { baseline, clauseSpec, REASON_WORDS, run } from "../engine.js";
import { clock, duration, usd } from "../format.js";
import type { LoadDetail } from "../model/model.js";
import { ProvenanceBadge, Stamp } from "./badges.js";

interface WhatIf {
  id: string;
  label: string;
  hint: string;
  applies: boolean;
  apply: (e: LoadEvidence) => LoadEvidence;
}

const iso = (ms: number) => new Date(ms).toISOString();

function whatIfs(d: LoadDetail): WhatIf[] {
  const spec = clauseSpec(d.clause.id);
  const free = d.clock.freeTimeEndsAt;
  const tz = d.timeZone;
  return [
    {
      id: "early",
      label: "Left before free time ended",
      hint: free ? `out ${clock(iso(Date.parse(free) - 10 * 60_000), tz)}` : "",
      applies: Boolean(free),
      apply: (e) => ({ ...e, released: e.released && free ? { ...e.released, at: iso(Date.parse(free) - 10 * 60_000) } : e.released, bol: e.bol && free ? { ...e.bol, checkOut: iso(Date.parse(free) - 12 * 60_000) } : e.bol }),
    },
    {
      id: "late",
      label: "Arrived 20 min late",
      hint: spec.requireOnTimeArrival ? "after the appointment" : "not required here",
      applies: spec.requireOnTimeArrival,
      apply: (e) => {
        const t = Date.parse(e.appointmentAt) + 20 * 60_000;
        return { ...e, arrived: e.arrived ? { ...e.arrived, at: iso(t) } : e.arrived, bol: e.bol ? { ...e.bol, checkIn: iso(t + 2 * 60_000) } : e.bol };
      },
    },
    { id: "unsigned", label: "Receiver didn't sign", hint: "no signed record", applies: true, apply: (e) => ({ ...e, bol: e.bol ? { ...e.bol, signed: false } : e.bol }) },
    { id: "conflict", label: "Paper out-time 40 min off", hint: "paper vs phone", applies: true, apply: (e) => ({ ...e, bol: e.bol && e.released ? { ...e.bol, checkOut: iso(Date.parse(e.released.at) + 40 * 60_000) } : e.bol }) },
    { id: "notice", label: "No detention notice", hint: spec.noticeLeadMinutes === null ? "not required here" : "never emailed", applies: spec.noticeLeadMinutes !== null, apply: (e) => ({ ...e, noticeSentAt: null }) },
    { id: "window", label: "Filed 8 days late", hint: `window ${spec.claimWindowHours % 24 === 0 ? `${spec.claimWindowHours / 24} days` : `${spec.claimWindowHours} h`}`, applies: true, apply: (e) => ({ ...e, evaluatedAt: e.released ? iso(Date.parse(e.released.at) + (spec.claimWindowHours + 24) * 3_600_000) : e.evaluatedAt }) },
  ];
}

export function recordedInput(d: LoadDetail): LoadEvidence | null {
  const i = d.verdict?.engineInput;
  if (!i) return null;
  return { loadId: d.summary.id, clauseId: d.clause.id, facility: d.snapshot?.load.facility.id ?? d.summary.facility, appointmentAt: i.appointmentAt, arrived: i.arrived, released: i.released, bol: i.bol, status214: i.status214, noticeSentAt: i.noticeSentAt, shipperConfirmed: i.shipperConfirmed, evaluatedAt: i.evaluatedAt };
}

const RULES: Array<[string, (d: LoadDetail) => string, string[]]> = [
  ["Free time", (d) => duration(d.clause.freeTimeMinutes), ["WITHIN_FREE_TIME"]],
  ["On time", (d) => (d.clause.requireOnTimeArrival ? "required" : "not required"), ["LATE_ARRIVAL"]],
  ["Signed paper", (d) => (d.clause.acceptedRecords.includes("signed_bol_times") ? "both times" : "not required"), ["NO_STATEMENT_OF_RECORD"]],
  ["Paper vs phone", () => "within 15 min", ["BOL_TIMESTAMP_CONFLICT", "PIN_OUTSIDE_GEOFENCE"]],
  ["Notice", (d) => (d.clause.noticeLeadMinutes === null ? "not required" : "before free time ends"), ["NOTICE_MISSING", "NOTICE_LATE"]],
  ["Claim window", (d) => `${d.clause.claimWindowHours / 24} days`, ["CLAIM_WINDOW_EXPIRED"]],
];

// WhatIfPanel: the workflow's own clause engine, re-run in the browser with one fact changed.
export function WhatIfPanel({ load, initial }: { load: LoadDetail; initial?: string[] }) {
  const [on, setOn] = useState<Set<string>>(new Set(initial ?? []));
  const base = recordedInput(load);
  if (!base) return <p className="small">No engine inputs recorded for this load.</p>;
  const all = whatIfs(load);
  let changed = base;
  for (const w of all) if (w.applies && on.has(w.id)) changed = w.apply(changed);
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
    <div className="grid-2">
      <div>
        {all.map((w) => (
          <label className={`switch ${w.applies ? "" : "off"}`} key={w.id}>
            <input type="checkbox" role="switch" checked={on.has(w.id)} disabled={!w.applies} onChange={(e) => toggle(w.id, e.target.checked)} />
            {w.label}
            <span className="hint">{w.hint}</span>
          </label>
        ))}
      </div>
      <div>
        <div className="compare">
          <div className="card">
            <ProvenanceBadge kind="replay" label="Recorded" />
            <div style={{ marginTop: 14 }}>
              <Stamp verdict={recorded.verdict} />
            </div>
            <div className="num">{usd(recorded.amountUsd)}</div>
          </div>
          <div className="card" aria-live="polite">
            <ProvenanceBadge kind="computed" />
            <div style={{ marginTop: 14 }}>
              <Stamp verdict={computed.verdict} />
            </div>
            <div className="num">{usd(computed.amountUsd)}</div>
          </div>
        </div>
        <div className="card" style={{ marginTop: 12 }}>
          <ul className="rules">
            {RULES.map(([name, value, codes]) => {
              const failed = any && codes.some((c) => reasons.includes(c as never));
              return (
                <li key={name} className={failed ? "failed" : ""}>
                  <span className="mk" aria-hidden="true">{failed ? "✕" : "✓"}</span>
                  <b>{name}</b>
                  <span>{value(load)}{failed ? <span className="vh"> failed</span> : null}</span>
                </li>
              );
            })}
          </ul>
        </div>
        {any && reasons.length > 0 && <p className="small" style={{ marginTop: 10 }}>{REASON_WORDS[reasons[0]!]}.</p>}
        <p className="small" style={{ marginTop: 6 }}>2-hour rule would ask {ask.filed ? usd(ask.amountUsd) : "$0.00"}{ask.filed && computed.verdict !== "BILLABLE" ? " (refusable)" : ""}.</p>
      </div>
    </div>
  );
}
