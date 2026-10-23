import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { acceptsAnyLocation, approvalWords, isRealPhoneRun, testStrip } from "../copy/provenance.js";
import { FEATURED_LOAD, FEATURED_RCS_LOAD, useLoad, usePack } from "../model/client.js";
import type { LoadDetail } from "../model/model.js";
import { clock, duration, placeName, usd } from "../format.js";
import { Page } from "../ui/AppShell.js";
import { Mark, ProvenanceBadge, StatusPill } from "../ui/badges.js";
import { ConversationView, failoverMarkers } from "../ui/ConversationView.js";
import { IconAgent, IconCheck, IconChevron, IconClock, IconClose, IconDoc, IconEmail, IconLock, IconPin, IconRcs, IconWhatsApp } from "../ui/icons.js";
import { DockClockBand } from "../ui/DockClockBand.js";
import { EmptyState } from "../ui/EmptyState.js";
import { useSignatureCheck } from "../ui/EvidencePanel.js";
import { hoursWords, QuickWhatIf } from "../ui/WhatIfPanel.js";

// Each step answers one reason a broker denies detention, with one proof card and the service that
// carried it. "signed" was a step before the notice step existed; old links land on Break.
export const JUDGE_STEPS = ["start", "proved", "notice", "filed", "break", "change", "phone"] as const;
type Step = (typeof JUDGE_STEPS)[number];
const LABELS: Record<Step, string> = { start: "Load", proved: "Proved", notice: "Notice", filed: "Filed", break: "Break", change: "Change", phone: "Phone" };
const ALIASES: Record<string, Step> = { signed: "break" };
// A recorded test run where WhatsApp failed and the driver was moved to RCS.
const FAILOVER_LOAD = "SMOKE-RCS-mvh338l2";

type PackLike = { evaluation?: { amountUsd?: number } };
const raiseAmount = (p: PackLike): PackLike => ({ ...p, evaluation: { ...p.evaluation, amountUsd: 9999 } });
const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

type Chip = "whatsapp" | "rcs" | "ses" | "scheduler" | "agentcore" | "kms" | "engine";
const CHIPS: Record<Chip, [ReactNode, string]> = {
  whatsapp: [<IconWhatsApp />, "WhatsApp"],
  rcs: [<IconRcs />, "RCS"],
  ses: [<IconEmail />, "Amazon SES"],
  scheduler: [<IconClock />, "EventBridge Scheduler"],
  agentcore: [<IconAgent />, "Bedrock AgentCore"],
  kms: [<IconLock />, "AWS KMS"],
  engine: [<IconDoc />, "Clause engine, in your browser"],
};

// The services that carried this step's proof.
function Carried({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null;
  return (
    <ul className="carried" aria-label="Carried by">
      <li className="lbl" aria-hidden="true">Carried by</li>
      {chips.map((c) => (
        <li key={c}>{CHIPS[c][0]}{CHIPS[c][1]}</li>
      ))}
    </ul>
  );
}

function SignatureCard({ load, broken }: { load: LoadDetail; broken?: boolean }) {
  const pack = usePack(load);
  const check = useSignatureCheck(pack.data ?? null, broken ? (raiseAmount as never) : undefined);
  const s = check.status;
  return (
    <div className="card verifycard">
      <div className={`vres ${s === "valid" ? "good" : s === "invalid" ? "bad" : ""}`} aria-live="polite">
        <span className="ic">{s === "valid" ? <IconCheck /> : s === "invalid" ? <IconClose /> : "…"}</span>
        <div>
          <b>{s === "valid" ? "Signature valid" : s === "invalid" ? "Signature broken" : s === "error" ? "Couldn't check" : "Checking"}</b>
          <span className="small">KMS ∙ in your browser</span>
        </div>
      </div>
      {broken && <ul className="diffs"><li>amount {usd(load.verdict?.amountUsd ?? 0)} → {usd(9999)}</li></ul>}
      <p className="small mono" style={{ marginTop: 12 }}>{(check.digest ?? load.packSummary?.digestSha256 ?? "").slice(0, 32)}…</p>
    </div>
  );
}

// The fields the signature covers, on the canary copy: what a judge is checking.
function SignedFields({ load }: { load: LoadDetail }) {
  const c = load.clock;
  return (
    <div className="printout signedslip">
      <div className="kv">
        <span>Load</span><b>{load.summary.id}</b>
        {c.arrivedAt && (<><span>Arrived</span><b>{clock(c.arrivedAt, load.timeZone)}</b></>)}
        {c.releasedAt && (<><span>Released</span><b>{clock(c.releasedAt, load.timeZone)}</b></>)}
        <span>Amount</span><b>{usd(load.verdict?.amountUsd ?? 0)}</b>
      </div>
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
        <span className="hint">to $9,999.00</span>
      </label>
      <SignatureCard load={load} broken={on} />
    </>
  );
}

function PhotoTile({ photo }: { photo: LoadDetail["photos"][number] }) {
  return (
    <figure className="phototile">
      {photo.url ? <img src={photo.url} alt="Bill of lading photo" /> : <div className="nophoto">no image</div>}
      <figcaption>
        <span className="small">{photo.badge}</span>
        {photo.legible === false && <span className="small">not legible ∙ retake asked</span>}
        {photo.matchesPack != null && <span className={photo.matchesPack ? "ok-text" : "bad-text"}><Mark ok={photo.matchesPack} />{photo.matchesPack ? "sha256 matches the pack" : "sha256 differs"}</span>}
      </figcaption>
    </figure>
  );
}

// The two location pins. On the judge-demo yard any location counts, so a pin there proves the
// server time only, and the card says so instead of "in yard".
function PinProof({ load }: { load: LoadDetail }) {
  const any = acceptsAnyLocation(load);
  const pins = load.messages.filter((m) => m.direction === "in" && m.kind === "location");
  if (!pins.length) return null;
  return (
    <div className="pinproof">
      {pins.slice(0, 2).map((p, i) => (
        <div key={p.id}>
          <IconPin />
          <b>{i === 0 ? "In" : "Out"} {clock(p.at, load.timeZone)}</b>
          <span className="small">{any ? "any location" : p.location?.insideGeofence === false ? "outside" : "in yard"}</span>
        </div>
      ))}
    </div>
  );
}

function Facts({ load }: { load: LoadDetail }) {
  return (
    <dl className="facts">
      <div><dt>Facility</dt><dd>{placeName(load.summary.facility)}</dd></div>
      <div><dt>Owed by</dt><dd>{load.summary.counterparty}</dd></div>
      <div><dt>Contract</dt><dd>{duration(load.clause.freeTimeMinutes)} free ∙ {usd(load.clause.ratePerHourUsd)}/h</dd></div>
      <div className="money"><dt>This claim</dt><dd>{load.verdict ? usd(load.verdict.amountUsd) : "not sealed yet"}</dd></div>
    </dl>
  );
}

// Sent before free time ended, on a two-point line. Green when it was in time, red when late.
function NoticeCard({ load }: { load: LoadDetail }) {
  const n = load.emails.find((e) => e.purpose === "notice");
  const free = load.clock.freeTimeEndsAt;
  if (!n) return <EmptyState title={load.clause.noticeLeadMinutes === null ? "This contract needs no notice" : "No notice email on this load"} />;
  const tz = load.timeZone;
  const early = free ? minutesBetween(n.sentAt, free) : null;
  const sentPt = <div className={`pt ${early != null && early < 0 ? "late" : "sent"}`}><i /><b>{clock(n.sentAt, tz)}</b><span>Notice sent</span></div>;
  const freePt = free ? <div className="pt free"><i /><b>{clock(free, tz)}</b><span>Free time ends</span></div> : null;
  const gap = early == null ? null : early >= 0 ? `${early < 1 ? "under 1 min" : duration(early)} early` : `${duration(-early)} late`;
  return (
    <div className="card mailcard">
      <div className="mailhead"><IconEmail /><b>Detention notice</b><StatusPill status={n.status === "delivered" ? "delivered" : n.status === "bounced" ? "failed" : "sent"} /></div>
      <p className="subj">{n.subject}</p>
      <p className="small">To {n.to} ∙ {n.toNote}</p>
      {freePt && (
        <div className="twopt">
          {early != null && early < 0 ? freePt : sentPt}
          <div className="seg"><span>{gap}</span></div>
          {early != null && early < 0 ? sentPt : freePt}
        </div>
      )}
      <p className="small mono">SES: {n.status}{n.deliveredAt ? ` ${clock(n.deliveredAt, tz)}` : ""}</p>
    </div>
  );
}

// The approval, then the claim email it released.
function ClaimCard({ load }: { load: LoadDetail }) {
  const c = load.emails.find((e) => e.purpose === "claim");
  const tz = load.timeZone;
  const words = approvalWords(load);
  if (!c || !load.claim) return <EmptyState title="No claim filed" />;
  const tapped = load.approval?.decision === "approve" && load.approval.decidedAt;
  const secs = load.claim.secondsAfterApproval;
  return (
    <div className="card mailcard">
      <div className="tap">
        <Mark ok />
        <b>{words.short.split(" ∙ ")[0]}</b>
        {tapped && <span className="mono small">{clock(load.approval!.decidedAt!, tz)}</span>}
      </div>
      <div className="mailhead"><IconEmail /><b>Claim email</b><StatusPill status={c.status === "delivered" ? "delivered" : c.status === "bounced" ? "failed" : "sent"} /></div>
      <dl className="kv-list">
        <dt>To</dt><dd>{c.to}</dd>
        <dt>Amount</dt><dd>{usd(load.claim.amountUsd)}</dd>
        <dt>Attached</dt><dd>{c.attachments.map((a) => <span key={a.name} className="att">{a.name}</span>)}</dd>
        <dt>Sent</dt><dd>{clock(c.sentAt, tz)}{c.deliveredAt ? ` ∙ delivered ${clock(c.deliveredAt, tz)}` : ""}</dd>
      </dl>
      {secs != null && <p className="after">Sent {Math.round(secs)} seconds after {tapped ? "the tap" : "the test approval"}</p>}
      <p className="small">{c.toNote}</p>
    </div>
  );
}

export function Judges() {
  const { step: stepParam } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const lane = params.get("lane") === "rcs" ? "rcs" : "whatsapp";
  const rcsLoad = FEATURED_RCS_LOAD;
  const loadId = lane === "rcs" ? rcsLoad : (params.get("load") ?? FEATURED_LOAD);
  const q = useLoad(loadId);
  const load = q.data?.data;
  const asked = ALIASES[stepParam ?? ""] ?? stepParam ?? "";
  const step: Step = (JUDGE_STEPS as readonly string[]).includes(asked) ? (asked as Step) : "start";
  const i = JUDGE_STEPS.indexOf(step);
  const go = (s: Step) => nav(`/judges/${s}${params.toString() ? `?${params}` : ""}`);
  const setLane = (l: "whatsapp" | "rcs") => {
    const next = new URLSearchParams(params);
    if (l === "rcs") next.set("lane", "rcs");
    else next.delete("lane");
    setParams(next, { replace: true });
  };

  let kicker = "";
  let title = "";
  let say = "";
  let chips: Chip[] = [];
  let visual: ReactNode = null;
  let extra: ReactNode = null;
  let link: [string, string] | null = null;
  if (load) {
    const id = load.summary.id;
    const channel = load.summary.channel === "rcs" ? "RCS" : "WhatsApp";
    switch (step) {
      case "start":
        kicker = "ATRI 2024 ∙ 40 drivers × $5,103.95";
        title = "$204,000 a year, unpaid";
        say = "Detention a 40-driver carrier never collects. Follow one claim.";
        visual = <DockClockBand load={load} legend={false} />;
        extra = <Facts load={load} />;
        break;
      case "proved": {
        kicker = "Denial 1 of 5";
        title = "“You weren't there that long”";
        say = isRealPhoneRun(load) ? `Both pins carry ${channel}'s server time.` : `Replayed test pins, through the live ${channel} pipeline.`;
        chips = lane === "rcs" ? ["rcs"] : ["whatsapp", "rcs"];
        const photo = load.photos.find((p) => p.url);
        extra = (
          <>
            <PinProof load={load} />
            {photo && <PhotoTile photo={photo} />}
            <Link className="failchip" to={`/loads/${FAILOVER_LOAD}/conversation`}><ProvenanceBadge kind="test" label="Test run" />WhatsApp failed, rerouted to RCS<IconChevron className="go" /></Link>
          </>
        );
        visual = <ConversationView messages={load.messages} timeZone={load.timeZone} party="driver" markers={failoverMarkers(load.timeline)} anyLocation={acceptsAnyLocation(load)} />;
        link = [`/loads/${id}/conversation`, "Chat"];
        break;
      }
      case "notice": {
        kicker = "Denial 2 of 5";
        title = "“You never gave notice”";
        const n = load.emails.find((e) => e.purpose === "notice");
        const free = load.clock.freeTimeEndsAt;
        say = !n
          ? load.clause.noticeLeadMinutes === null ? "This contract doesn't ask for one." : "No notice was sent on this load."
          : free && Date.parse(n.sentAt) <= Date.parse(free) ? "DockClock emailed the shipper before free time ran out." : "The notice went out after free time ended.";
        chips = n ? ["ses", "scheduler"] : [];
        visual = <NoticeCard load={load} />;
        link = n ? [`/loads/${id}/emails`, "Emails"] : null;
        break;
      }
      case "filed": {
        kicker = "Denial 3 of 5";
        title = "“You filed too late”";
        const sent = load.claim?.sentAt;
        const out = load.clock.releasedAt;
        say = sent && out
          ? `Filed ${duration(minutesBetween(out, sent))} after release. The contract allows ${hoursWords(load.clause.claimWindowHours)}.`
          : `${approvalWords(load).short}. Nothing was filed.`;
        chips = sent ? [...(load.approval?.decision === "approve" ? (["whatsapp"] as Chip[]) : []), "ses", "agentcore"] : [];
        visual = <ClaimCard load={load} />;
        link = [`/loads/${id}/agent`, "Agent run"];
        break;
      }
      case "break":
        kicker = "Denial 4 of 5";
        title = "“The evidence was edited”";
        say = "Sealed with AWS KMS. Change the amount and your browser's check fails.";
        chips = ["kms"];
        visual = (
          <>
            <BreakIt load={load} />
            <SignedFields load={load} />
          </>
        );
        link = [`/loads/${id}/evidence`, "Evidence"];
        break;
      case "change":
        kicker = "Denial 5 of 5";
        title = "“It isn't owed”";
        say = "Sometimes that's true. Flip a fact and the same rules agree.";
        chips = ["engine"];
        visual = <QuickWhatIf load={load} ids={["early", "noticeLate", "window"]} />;
        link = [`/loads/${id}/whatif`, "All facts"];
        break;
      case "phone":
        title = "Try it on your phone";
        say = "Text DEMO on WhatsApp. Number on our Devpost page.";
        chips = ["whatsapp"];
        visual = (
          <div className="dockband">
            <div className="lbl">Text this</div>
            <div className="led" style={{ fontSize: 96, marginTop: 6 }}>DEMO</div>
            <p className="small" style={{ color: "var(--nav-dim)", marginTop: 10 }}>RCS: recorded only (test agent).</p>
          </div>
        );
        break;
    }
  }

  return (
    <Page crumbs={[{ label: "Judges path" }]} badges={q.data && <ProvenanceBadge kind={q.data.source} />} strip={load ? testStrip(load) : null}>
      <div className="judge">
        <div className="steps-m" aria-hidden="true">
          <span className="mono">{i + 1} / {JUDGE_STEPS.length}</span>
          <span className="segs">{JUDGE_STEPS.map((s, n) => <i key={s} className={n < i ? "done" : n === i ? "current" : ""} />)}</span>
        </div>
        <nav className="steps" aria-label="Steps">
          {JUDGE_STEPS.map((s, n) => (
            <Link key={s} to={`/judges/${s}${params.toString() ? `?${params}` : ""}`} className={`${s === step ? "active" : ""} ${n < i ? "done" : ""}`} aria-current={s === step ? "step" : undefined} aria-label={LABELS[s]} title={LABELS[s]}>
              <span className="n" aria-hidden="true">{n < i ? <IconCheck /> : ""}</span>
              <span>{LABELS[s]}</span>
            </Link>
          ))}
        </nav>
        <div className="stage">
          <div>
            {step === "proved" && (
              <div className="segctl lane" role="group" aria-label="Driver's channel" style={{ marginBottom: 18 }}>
                <button aria-pressed={lane === "whatsapp"} onClick={() => setLane("whatsapp")}><IconWhatsApp />WhatsApp</button>
                <button aria-pressed={lane === "rcs"} onClick={() => setLane("rcs")}><IconRcs />RCS (drivers without WhatsApp)</button>
              </div>
            )}
            {!load ? (
              <EmptyState title={lane === "rcs" && !rcsLoad ? "No RCS recording yet" : q.isLoading ? "Loading" : "This load isn't in this data set"} />
            ) : (
              <>
                {kicker && <p className="kicker">{kicker}</p>}
                <h1>{title}</h1>
                <p className="say">{say}</p>
                <Carried chips={chips} />
                {extra && <div className="extra">{extra}</div>}
                <div className="acts">
                  {i > 0 && <button className="btn" onClick={() => go(JUDGE_STEPS[i - 1]!)}>Back</button>}
                  {i < JUDGE_STEPS.length - 1 && <button className="btn primary" onClick={() => go(JUDGE_STEPS[i + 1]!)}>{i === 0 ? "Start" : "Next"}</button>}
                  {link && <Link className="btn" to={link[0]}>{link[1]}<IconChevron className="go" /></Link>}
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
