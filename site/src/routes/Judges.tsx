import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { approvalWords, provedWords } from "../copy/provenance.js";
import { FEATURED_LOAD, useLoad, useLoads } from "../model/client.js";
import { flowNodes } from "../model/flow.js";
import type { LoadDetail } from "../model/model.js";
import { run } from "../engine.js";
import { duration, minutesBetween, usd } from "../format.js";
import { AgentFlow } from "../ui/AgentFlow.js";
import { Page } from "../ui/AppShell.js";
import { ProvenanceBadge, Stamp } from "../ui/badges.js";
import { ConversationView } from "../ui/ConversationView.js";
import { DockClockBand } from "../ui/DockClockBand.js";
import { EmptyState } from "../ui/EmptyState.js";
import { useSignatureCheck } from "../ui/EvidencePanel.js";
import { recordedInput } from "../ui/WhatIfPanel.js";

export const JUDGE_STEPS = ["start", "proved", "signed", "filed", "break", "change", "phone"] as const;
type Step = (typeof JUDGE_STEPS)[number];
const LABELS: Record<Step, string> = { start: "Load", proved: "Proved", signed: "Signed", filed: "Filed", break: "Break it", change: "Change a fact", phone: "Your phone" };

type PackLike = { evaluation?: { amountUsd?: number } };
const raiseAmount = (p: PackLike): PackLike => ({ ...p, evaluation: { ...p.evaluation, amountUsd: 9999 } });

function SignatureCard({ load, broken }: { load: LoadDetail; broken?: boolean }) {
  const check = useSignatureCheck(load.pack, broken ? (raiseAmount as never) : undefined);
  const s = check.status;
  return (
    <div className="card verifycard">
      <div className={`vres ${s === "valid" ? "good" : s === "invalid" ? "bad" : ""}`} aria-live="polite">
        <span className="ic">{s === "valid" ? "✓" : s === "invalid" ? "✕" : "…"}</span>
        <div>
          <b>{s === "valid" ? "Signature valid" : s === "invalid" ? "Signature broken" : s === "error" ? "Couldn't check" : "Checking"}</b>
          <span className="small">AWS KMS · checked in your browser</span>
        </div>
      </div>
      {broken && <ul className="diffs"><li>amount {usd(load.verdict?.amountUsd ?? 0)} → {usd(9999)}</li></ul>}
      <p className="small mono" style={{ marginTop: 12 }}>{(check.digest ?? load.pack?.digestSha256 ?? "").slice(0, 32)}…</p>
    </div>
  );
}

function BreakIt({ load }: { load: LoadDetail }) {
  const [on, setOn] = useState(false);
  return (
    <>
      <label className="switch" style={{ marginBottom: 12 }}>
        <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Raise the amount
        <span className="hint">→ $9,999.00</span>
      </label>
      <SignatureCard load={load} broken={on} />
    </>
  );
}

function ChangeIt({ load }: { load: LoadDetail }) {
  const [on, setOn] = useState(false);
  const base = recordedInput(load);
  if (!base || !load.clock.freeTimeEndsAt) return <EmptyState title="No engine inputs" />;
  const out = new Date(Date.parse(load.clock.freeTimeEndsAt) - 10 * 60_000).toISOString();
  const changed = on && base.released ? { ...base, released: { ...base.released, at: out }, bol: base.bol ? { ...base.bol, checkOut: new Date(Date.parse(out) - 2 * 60_000).toISOString() } : base.bol } : base;
  const before = run(base);
  const after = run(changed);
  return (
    <>
      <label className="switch" style={{ marginBottom: 12 }}>
        <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Left before free time ended
      </label>
      <div className="compare">
        <div className="card"><ProvenanceBadge kind="replay" label="Recorded" /><div style={{ marginTop: 14 }}><Stamp verdict={before.verdict} /></div><div className="num">{usd(before.amountUsd)}</div></div>
        <div className="card"><ProvenanceBadge kind="computed" /><div style={{ marginTop: 14 }}><Stamp verdict={after.verdict} /></div><div className="num">{usd(after.amountUsd)}</div></div>
      </div>
    </>
  );
}

export function Judges() {
  const { step: stepParam } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const lane = params.get("lane") === "rcs" ? "rcs" : "whatsapp";
  const loads = useLoads();
  const rcsLoad = loads.data?.data.find((l) => l.channel === "rcs" || l.failover)?.id;
  const loadId = lane === "rcs" ? rcsLoad : (params.get("load") ?? FEATURED_LOAD);
  const q = useLoad(loadId);
  const load = q.data?.data;
  const step: Step = (JUDGE_STEPS as readonly string[]).includes(stepParam ?? "") ? (stepParam as Step) : "start";
  const i = JUDGE_STEPS.indexOf(step);
  const go = (s: Step) => nav(`/judges/${s}${params.toString() ? `?${params}` : ""}`);
  const setLane = (l: "whatsapp" | "rcs") => {
    const next = new URLSearchParams(params);
    if (l === "rcs") next.set("lane", "rcs");
    else next.delete("lane");
    setParams(next, { replace: true });
  };

  let title = "";
  let say = "";
  let visual: ReactNode = null;
  let link: [string, string] | null = null;
  if (load) {
    const c = load.clock;
    const wait = c.arrivedAt && c.releasedAt ? duration(minutesBetween(c.arrivedAt, c.releasedAt)) : "";
    switch (step) {
      case "start":
        title = `Owed ${usd(load.verdict?.amountUsd ?? 0)}`;
        say = `A truck waited ${wait}. The contract pays for ${duration(c.billableMinutes)}.`;
        visual = <DockClockBand load={load} />;
        link = [`/loads/${load.summary.id}`, "Open the load"];
        break;
      case "proved":
        title = "Proved";
        say = `${provedWords(load).short}. Paper and locations agree.`;
        visual = <ConversationView messages={load.messages} timeZone={load.timeZone} party="driver" />;
        link = [`/loads/${load.summary.id}/conversation`, "Conversation"];
        break;
      case "signed":
        title = "Signed";
        say = "Sealed with AWS KMS. Your browser checks it now.";
        visual = <SignatureCard load={load} />;
        link = [`/loads/${load.summary.id}/evidence`, "Evidence"];
        break;
      case "filed":
        title = "Filed";
        say = `${approvalWords(load).short}. The agent can't change the amount.`;
        visual = <div className="card"><div className="card-body"><AgentFlow nodes={flowNodes(load)} timeZone={load.timeZone} /></div></div>;
        link = [`/loads/${load.summary.id}/agent`, "Agent run"];
        break;
      case "break":
        title = "Break the signature";
        say = "Raise the amount. The check fails.";
        visual = <BreakIt load={load} />;
        link = [`/loads/${load.summary.id}/evidence`, "All switches"];
        break;
      case "change":
        title = "Change one fact";
        say = "The same contract engine decides again.";
        visual = <ChangeIt load={load} />;
        link = [`/loads/${load.summary.id}/whatif`, "All facts"];
        break;
      case "phone":
        title = "Try it on your phone";
        say = "Text DEMO on WhatsApp to the number on our Devpost page. About 10 minutes.";
        visual = (
          <div className="dockband">
            <div className="lbl">Text this</div>
            <div className="led" style={{ fontSize: 96, marginTop: 6 }}>DEMO</div>
            <p className="small" style={{ color: "var(--nav-dim)", marginTop: 10 }}>RCS runs on a Google test agent: recorded only.</p>
          </div>
        );
        break;
    }
  }

  return (
    <Page crumbs={[{ label: "Judges path" }]} badges={q.data && <ProvenanceBadge kind={q.data.source} />}>
      <div className="judge">
        <nav className="steps" aria-label="Steps">
          {JUDGE_STEPS.map((s, n) => (
            <Link key={s} to={`/judges/${s}${params.toString() ? `?${params}` : ""}`} className={`${s === step ? "active" : ""} ${n < i ? "done" : ""}`} aria-current={s === step ? "step" : undefined}>
              <span className="n">{n < i ? "✓" : n + 1}</span>
              {LABELS[s]}
            </Link>
          ))}
        </nav>
        <div className="stage">
          <div>
            {step === "start" && (
              <div className="segctl lane" role="group" aria-label="Driver's channel" style={{ marginBottom: 18 }}>
                <button aria-pressed={lane === "whatsapp"} onClick={() => setLane("whatsapp")}>Driver on WhatsApp</button>
                <button aria-pressed={lane === "rcs"} onClick={() => setLane("rcs")}>Driver on RCS</button>
              </div>
            )}
            {!load ? (
              <EmptyState title={lane === "rcs" && !rcsLoad ? "No RCS recording yet" : "Loading"} />
            ) : (
              <>
                <h1>{title}</h1>
                <p className="say">{say}</p>
                <div className="acts">
                  {i > 0 && <button className="btn" onClick={() => go(JUDGE_STEPS[i - 1]!)}>Back</button>}
                  {i < JUDGE_STEPS.length - 1 && <button className="btn primary" onClick={() => go(JUDGE_STEPS[i + 1]!)}>{i === 0 ? "Start" : "Next"}</button>}
                  {link && <Link className="btn" to={link[0]}>{link[1]} ›</Link>}
                </div>
              </>
            )}
          </div>
          <div>{visual}</div>
        </div>
      </div>
    </Page>
  );
}
