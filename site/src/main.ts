import "./styles.css";
import example from "../replay/example.json";
import type { LoadEvidence } from "@dockclock/clause-engine";
import { baseline, clauseSpec, headline, recordedEvidence, REASON_WORDS, run } from "./engine.js";
import { clock, dateLong, duration, escapeHtml as h, hmm, minutesBetween, usd, zoneName } from "./format.js";
import type { ChatMessage, Provenance, ReplaySnapshot, TimelineEvent } from "./snapshot.js";
import { verifyPack } from "./verify.js";

type Tab = "replay" | "verify" | "whatif";

const PROVENANCE_WORDS: Record<Provenance, string> = {
  recorded: "Read from DockClock's stored records.",
  rendered_from_template: "Rebuilt from the same template the sender uses. The sent text itself was not stored for this load.",
  synthetic_input: "A replayed test message, not a phone.",
  derived: "Computed from recorded values.",
};

const STEP_MS = 1500;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  tab: "replay" as Tab,
  step: Number.POSITIVE_INFINITY, // index into the timeline; Infinity = the whole load
  playing: false,
  timer: 0 as number | 0,
  party: "driver" as "driver" | "dispatcher",
  cursor: null as string | null, // band cursor during the intro sweep
  tamper: { amount: false, release: false, photo: false },
  whatif: new Set<string>(),
  publicKeyPem: null as string | null,
};

let snap: ReplaySnapshot;
const app = document.getElementById("app")!;

async function load(): Promise<ReplaySnapshot> {
  const name = new URLSearchParams(location.search).get("replay");
  if (name && /^[A-Za-z0-9._-]+$/.test(name)) {
    const res = await fetch(`replay/${name}.json`);
    if (res.ok) return (await res.json()) as ReplaySnapshot;
  }
  return example as unknown as ReplaySnapshot;
}

// Formatting helpers bound to the facility's zone

const tz = () => snap.load.facility.timeZone;
const at = (iso: string) => clock(iso, tz());
const zone = () => zoneName(snap.load.appointmentAt, tz());

// The band's time range: first record to last record.
function range(): [number, number] {
  const times = snap.timeline.map((e) => Date.parse(e.at));
  if (snap.clock.arrivedAt) times.push(Date.parse(snap.clock.arrivedAt));
  return [Math.min(...times), Math.max(...times)];
}
function pct(iso: string): number {
  const [a, b] = range();
  return b === a ? 0 : ((Date.parse(iso) - a) / (b - a)) * 100;
}

function cursorTime(): string | null {
  if (state.cursor) return state.cursor;
  if (!Number.isFinite(state.step)) return null;
  return snap.timeline[state.step]?.at ?? null;
}

function visibleUntil(): number {
  const c = cursorTime();
  return c ? Date.parse(c) : Number.POSITIVE_INFINITY;
}

// Dock clock band

function band(): string {
  const c = snap.clock;
  const limit = visibleUntil();
  const until = (iso: string | null) => (iso ? Math.min(Date.parse(iso), limit) : limit);
  const atDock = c.arrivedAt ? Math.max(0, (until(c.releasedAt) - Date.parse(c.arrivedAt)) / 60_000) : 0;
  const billable = c.freeTimeEndsAt ? Math.max(0, (until(c.releasedAt) - Date.parse(c.freeTimeEndsAt)) / 60_000) : 0;
  const freeMin = snap.clause.freeTimeMinutes;
  const segs: string[] = [];
  const width = (from: string, to: string) => {
    const end = Math.min(Date.parse(to), limit);
    return Math.max(0, pct(new Date(end).toISOString()) - pct(from));
  };
  if (c.arrivedAt && c.clockStartAt && Date.parse(c.arrivedAt) < Date.parse(c.clockStartAt)) segs.push(`<div class="seg early" style="left:${pct(c.arrivedAt)}%;width:${width(c.arrivedAt, c.clockStartAt)}%"></div>`);
  if (c.clockStartAt && c.freeTimeEndsAt) segs.push(`<div class="seg free" style="left:${pct(c.clockStartAt)}%;width:${width(c.clockStartAt, c.freeTimeEndsAt)}%"></div>`);
  if (c.freeTimeEndsAt && c.releasedAt && Date.parse(c.releasedAt) > Date.parse(c.freeTimeEndsAt)) segs.push(`<div class="seg bill" style="left:${pct(c.freeTimeEndsAt)}%;width:${width(c.freeTimeEndsAt, c.releasedAt)}%"></div>`);
  const cur = cursorTime();
  if (cur) segs.push(`<div class="seg cursor" style="left:${pct(cur)}%"></div>`);
  const marks: string[] = [];
  if (c.arrivedAt) marks.push(`<div class="mark start" style="left:${pct(c.arrivedAt)}%"><b>${at(c.arrivedAt)}</b>Arrived</div>`);
  if (c.freeTimeEndsAt) marks.push(`<div class="mark hide-m" style="left:${pct(c.freeTimeEndsAt)}%"><b>${at(c.freeTimeEndsAt)}</b>Free time ends</div>`);
  if (c.releasedAt) marks.push(`<div class="mark ${pct(c.releasedAt) > 82 ? "end" : ""}" style="left:${pct(c.releasedAt)}%"><b>${at(c.releasedAt)}</b>Released</div>`);
  const labels: string[] = [];
  if (c.clockStartAt) labels.push(`<div class="seglabel" style="left:${pct(c.clockStartAt)}%">FREE ${hmm(freeMin)}</div>`);
  if (c.freeTimeEndsAt && c.releasedAt && Date.parse(c.releasedAt) > Date.parse(c.freeTimeEndsAt) && limit >= Date.parse(c.freeTimeEndsAt) + 5 * 60_000)
    labels.push(`<div class="seglabel on-amber" style="left:${pct(c.freeTimeEndsAt)}%">BILLABLE ${hmm(billable)}</div>`);
  const pins = snap.timeline
    .filter((e) => e.tone !== "neutral")
    .map((e) => `<div class="pin ${e.tone} ${Date.parse(e.at) > limit ? "future" : ""}" style="left:${pct(e.at)}%" title="${h(at(e.at))} ${h(e.title)}"></div>`);
  const last = snap.timeline[snap.timeline.length - 1];
  const claim = snap.claim;
  const endLabel = claim?.sentAt
    ? `<div class="pinlabel right" style="left:100%"><b>${at(claim.sentAt)}</b> sealed, approved, claim emailed</div>`
    : last
      ? `<div class="pinlabel right" style="left:100%"><b>${at(last.at)}</b> ${h(last.title)}</div>`
      : "";
  const refused = snap.timeline.filter((e) => e.tone === "refused").length;
  const refusedLabel = refused ? `<div class="pinlabel hide-m" style="left:${pct(snap.timeline.find((e) => e.tone === "refused")!.at)}%"><span style="color:var(--red)">●</span> ${refused} bad taps refused</div>` : "";
  const playing = state.playing;
  return `
  <section class="band" aria-label="Dock clock">
    <div class="clockface">
      <div class="label">At the dock</div>
      <div class="v" id="clockv">${hmm(atDock)}<small>h:mm</small></div>
      <div class="s">${hmm(freeMin)} free · <b>${hmm(billable)} billable</b></div>
    </div>
    <div class="track" role="img" aria-label="Arrived ${c.arrivedAt ? at(c.arrivedAt) : ""}, free time ends ${c.freeTimeEndsAt ? at(c.freeTimeEndsAt) : ""}, released ${c.releasedAt ? at(c.releasedAt) : ""} ${zone()}.">
      ${marks.join("")}
      <div class="bar">${segs.join("")}</div>
      ${labels.join("")}
      ${pins.join("")}
      ${refusedLabel}
      ${endLabel}
    </div>
    <div class="player">
      <div class="row"><button class="btn solid playbtn" data-act="play">${playing ? `<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="1" width="3.5" height="12" fill="currentColor"/><rect x="8.5" y="1" width="3.5" height="12" fill="currentColor"/></svg>Pause` : `<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1 L13 7 L3 13 Z" fill="currentColor"/></svg>Play the replay`}</button></div>
      <label class="vh" for="scrub">Replay position</label>
      <input id="scrub" type="range" min="0" max="${snap.timeline.length - 1}" step="1" value="${Number.isFinite(state.step) ? state.step : snap.timeline.length - 1}">
      <span class="speed">${Number.isFinite(state.step) ? `Record ${state.step + 1} of ${snap.timeline.length}` : "About 25 s"} · times in ${zone()}</span>
    </div>
  </section>`;
}

// Phone frame

function bubble(m: ChatMessage, fresh: boolean): string {
  const out = m.direction === "out";
  const unsent = m.status === "not_sent";
  const tags: string[] = [];
  if (m.provenance === "synthetic_input") tags.push("test message");
  else if (unsent) tags.push("not sent · test driver");
  else if (m.templateName) tags.push(`template · ${m.templateName.replace("dockclock_", "")}`);
  else tags.push(out ? "sent" : "received");
  let inner = h(m.body);
  if (m.kind === "location" && m.location) inner = `<div class="loc"><i aria-hidden="true">⌖</i><span>Location shared<br>${h(m.location.note)}</span></div>`;
  if (m.kind === "location_request") inner += `<div class="btns"><div>Send location</div></div>`;
  if (m.kind === "flow" && m.flowCta) inner += `<div class="btns"><div>${h(m.flowCta)}</div></div>`;
  if (m.kind === "flow_reply" && m.flowReply) {
    const f = m.flowReply;
    inner = `Bill of lading form<div class="kv"><span>In</span><b>${h(f.inTime ?? "—")}</b><span>Out</span><b>${h(f.outTime ?? "—")}</b><span>Signed</span><b>${f.receiverSigned ? "yes" : "no"}</b><span>Delay</span><b>${h(f.delayReason ?? "—")}</b><span>Photo</span><b>${f.photoStored ? "stored, hashed" : "not stored"}</b></div>`;
  }
  if (m.buttons && m.kind !== "buttons") inner += `<div class="btns">${m.buttons.map((b) => `<div class="${b.tapped ? "tapped" : ""}">${h(b.title)}</div>`).join("")}</div>`;
  if (m.buttons && m.kind === "buttons" && out) inner += `<div class="btns">${m.buttons.map((b) => `<div class="${b.tapped ? "tapped" : ""}">${h(b.title)}</div>`).join("")}</div>`;
  const ticks = m.status === "read" ? " ✓✓" : m.status === "delivered" ? " ✓✓" : m.status === "sent" ? " ✓" : "";
  return `<div class="msg ${out ? "" : "in"} ${unsent ? "unsent" : ""} ${fresh ? "enter" : ""}" title="${h(PROVENANCE_WORDS[m.provenance])}"><span class="src">${h(tags.join(" · "))}</span>${inner}<span class="meta">${at(m.at)}${ticks}</span></div>`;
}

let shownMessages = new Set<string>();
function phone(): string {
  const limit = visibleUntil();
  const msgs = snap.messages.filter((m) => m.party === state.party && Date.parse(m.at) <= limit);
  const fresh = new Set(msgs.map((m) => m.id).filter((id) => !shownMessages.has(id)));
  const animate = state.playing && !reduceMotion;
  shownMessages = new Set([...shownMessages, ...msgs.map((m) => m.id)]);
  const day = dateLong(snap.load.appointmentAt, tz());
  const hasDispatcher = snap.messages.some((m) => m.party === "dispatcher");
  return `
  <div class="phonewrap">
    <div class="colh"><span class="label">On WhatsApp</span>
      ${hasDispatcher ? `<span class="seg-ctl" role="group" aria-label="Whose phone"><button data-party="driver" aria-pressed="${state.party === "driver"}">Driver</button><button data-party="dispatcher" aria-pressed="${state.party === "dispatcher"}">Dispatcher</button></span>` : ""}
    </div>
    <div class="phone"><div class="screen">
      <div class="wahead"><img src="./avatar.svg" alt=""><div><b>DockClock (test sender)</b><span>${state.party === "driver" ? "The driver's chat" : "The dispatcher's chat"}</span></div></div>
      <div class="chat" id="chat"><span class="daychip">${h(day)}</span>${msgs.map((m) => bubble(m, animate && fresh.has(m.id))).join("") || `<p class="small" style="text-align:center;margin-top:40px">No messages yet</p>`}</div>
    </div></div>
    <p class="phonenote">Drawn from DockClock's message records, not a screenshot. Dashed bubbles were never sent: the driver in this run was a test number.</p>
  </div>`;
}

// Timeline

function timeline(): string {
  const limit = visibleUntil();
  const current = Number.isFinite(state.step) ? state.step : -1;
  let lastGroup = "";
  const rows: string[] = [];
  snap.timeline.forEach((e, i) => {
    const group = e.provenance === "synthetic_input" ? "Driver messages (replayed test messages)" : "The workflow, the dispatcher and the AI agent";
    const route = e.services.join(" → ");
    if (group !== lastGroup) {
      const routes = [...new Set(snap.timeline.filter((x) => (x.provenance === "synthetic_input") === (e.provenance === "synthetic_input")).map((x) => x.services.join(" → ")))];
      rows.push(`<li class="grp"><span>${h(group)}</span>${routes.length === 1 ? `<span class="chip svc">${h(routes[0] ?? "")}</span>` : ""}</li>`);
      lastGroup = group;
    }
    const sharedRoute = [...new Set(snap.timeline.filter((x) => (x.provenance === "synthetic_input") === (e.provenance === "synthetic_input")).map((x) => x.services.join(" → ")))].length === 1;
    const future = Date.parse(e.at) > limit;
    const outcome = e.tone === "refused" && e.outcome ? `<span class="chip outcome">${h(e.outcome)}</span>` : "";
    const svc = !sharedRoute && route ? `<span class="chip svc">${h(route)}</span>` : "";
    const chips = outcome || svc ? `<span class="chips">${outcome}${svc}</span>` : "";
    rows.push(`<li><button class="row ${future ? "future" : ""}" data-ev="${i}" ${i === current ? 'aria-current="step"' : ""}>
      <span class="ts">${at(e.at)}</span><span class="dot ${e.tone}" aria-hidden="true"></span>
      <span><span class="t">${h(e.title)}</span>${e.detail ? `<span class="d" style="display:block">${h(e.detail)}</span>` : ""}${chips}</span>
    </button></li>`);
  });
  const legend = `<span class="legend"><i class="dot money"></i>money <i class="dot agent"></i>AI agent <i class="dot ok"></i>approved <i class="dot refused"></i>refused</span>`;
  return `<div><div class="colh"><span class="label">Everything that happened</span><span class="aside">times ${zone()} · click a row for its record</span></div>
    <div class="panel"><div class="tlhead">${legend}</div><ol class="tl">${rows.join("")}</ol></div></div>`;
}

// Verdict, mailbox, agent

function verdictCard(): string {
  const v = snap.verdict;
  const c = snap.clause;
  const stamp = v.verdict === "BILLABLE" ? "OWED" : v.verdict === "NOT_BILLABLE" ? "NOT OWED" : "NEEDS A PERSON";
  const anchor = c.freeTimeAnchor === "appointment" ? "from the appointment (or arrival, if later)" : "from arrival";
  const billMin = snap.clock.billableMinutes;
  return `<div class="panel verdict">
    <div class="colh" style="margin-bottom:4px"><span class="label">${stamp === "OWED" ? "Why it is owed" : "Why it is not owed"}</span><span class="aside">decided by plain code, no AI</span></div>
    <dl class="terms" style="border-top:0;margin-top:6px;padding-top:0">
      <dt>Owed by</dt><dd>${h(snap.load.counterparty.name)}</dd>
      <dt>Free time</dt><dd>${duration(c.freeTimeMinutes)} ${anchor}</dd>
      <dt>Rate</dt><dd>${usd(c.ratePerHourUsd)} an hour${c.capUsdPerOccurrence !== null ? `, up to ${usd(c.capUsdPerOccurrence)}` : ""}</dd>
      <dt>On time</dt><dd>${c.requireOnTimeArrival ? "The truck must arrive by the appointment" : "Not required"}</dd>
      <dt>Notice</dt><dd>${c.noticeLeadMinutes === null ? "Not required by this contract" : `Email before free time ends`}</dd>
      <dt>Proof</dt><dd>${c.acceptedRecords.includes("signed_bol_times") ? "Signed bill of lading with in and out times" : "Location records"}</dd>
    </dl>
    <div class="math">${duration(billMin)} past free time × ${usd(c.ratePerHourUsd)}/h<br><span class="eq">= ${usd(v.amountUsd)} owed</span></div>
    <p class="small" style="margin-top:10px">${h(c.basis)}</p>
  </div>`;
}

function mailCard(): string {
  const e = snap.emails.find((x) => x.purpose === "claim") ?? snap.emails[0];
  if (!e) return "";
  return `<div class="panel mail">
    <div class="hd"><span>The claim email · ${h(e.to.note)}</span><span class="mono">Amazon SES</span></div>
    <div class="body">
      <div class="f"><span>From</span><b>${h(e.from)}</b><span>To</span><em>${h(e.to.name)}</em><span>Sent</span><em>${at(e.sentAt)} ${zone()}${snap.claim?.secondsAfterApproval != null ? ` · ${Math.round(snap.claim.secondsAfterApproval)} s after Approve` : ""}</em><span>Subject</span><b>${h(e.subject)}</b></div>
      ${e.body ? `<div class="fade" id="mailfade"><pre id="mailbody">${h(e.body)}</pre></div><button class="linkish" data-act="mail">Show the whole email</button>` : `<p class="note">${h(e.bodyNote ?? "The body was not stored for this load.")}</p>`}
      <div class="files">${e.attachments.map((a) => `<span class="file" title="${h(a.note ?? "")}">📎 ${h(a.name)}</span>`).join("")}</div>
    </div>
  </div>`;
}

function agentCard(): string {
  const r = snap.agentRuns[0];
  if (!r) return "";
  const rows: string[] = [`<li><span class="k">Task</span><span>File the claim only if the sealed verdict is billable and dispatch approved it</span><span></span></li>`];
  for (const t of r.toolCalls) {
    rows.push(`<li><span class="k">Tool</span><code>${h(t.name)}</code><span class="${t.result?.ok === false ? "no" : "ok"}">${t.result?.ok === false ? "failed" : "ran"}</span></li>`);
    if (t.cedar) rows.push(`<li><span class="k">Policy</span><span>${h(t.cedar.policy)}${t.cedar.decisionSource === "inferred" ? `<span class="inferred">Inferred: the tool ran through the policy gateway in enforce mode.</span>` : ""}</span><span class="${t.cedar.decision === "permit" ? "ok" : "no"}">${t.cedar.decision}</span></li>`);
  }
  if (r.guard)
    rows.push(`<li><span class="k">Guard</span><span>Amount ${usd(r.guard.amountCentsSent / 100)} and pack digest <code>${h(r.guard.digestSent.slice(0, 12))}…</code> equal the sealed ones</span><span class="${r.guard.match ? "ok" : "no"}">${r.guard.match ? "match" : "refused"}</span></li>`);
  return `<div class="panel agentcard">
    <div class="colh" style="margin:0"><span class="label">How the AI agent filed it</span><span class="aside">${h(r.model)}</span></div>
    <ul class="trace">${rows.join("")}</ul>
    <p class="small" style="margin-top:10px">The model writes the email. It cannot pick the amount: the email tool refuses anything but the sealed amount and digest.</p>
  </div>`;
}

// Hero: the 30-second answer

function hero(): string {
  const v = snap.verdict;
  const c = snap.clock;
  const wait = c.arrivedAt && c.releasedAt ? duration(minutesBetween(c.arrivedAt, c.releasedAt)) : "";
  const claim = snap.claim;
  const signedDigest = snap.pack.digestSha256.slice(0, 8);
  return `
  <section class="hero">
    <div>
      <div class="eyebrow"><span class="badge replay">Replay</span><span>A recorded load · ${h(dateLong(snap.load.appointmentAt, tz()))} · ${h(snap.load.facility.name)}</span></div>
      <h1>The contract owed <span class="owed">${usd(v.amountUsd)}</span>. DockClock proved it, signed it and emailed the claim.</h1>
      <p class="lede">A truck waited ${wait} at a loading dock, ${duration(c.billableMinutes)} past the free time in its contract. Below is every record that turned that wait into a claim.</p>
      <p class="define"><b>Detention</b>: pay a shipper owes for keeping a truck past the contract's free time. <b>Bill of lading</b>: the shipping paper the receiver signs, with in and out times.</p>
    </div>
    <aside class="slip" aria-label="The claim">
      <div class="sliphd"><span class="label">The claim</span><span class="small">${claim?.sentAt ? `emailed ${at(claim.sentAt)} ${zone()}` : "not filed"}</span></div>
      <div class="slipmain"><span class="stamp land">${v.verdict === "BILLABLE" ? "OWED" : v.verdict === "NOT_BILLABLE" ? "NOT OWED" : "NEEDS A PERSON"}</span><span class="amount">${usd(v.amountUsd)}</span></div>
      <dl class="sliprows">
        <dt>Owed by</dt><dd>${h(snap.load.counterparty.name)}</dd>
        <dt>Approved</dt><dd>${claim?.secondsAfterApproval != null ? `Dispatcher tapped Approve; the AI agent emailed it ${Math.round(claim.secondsAfterApproval)} s later` : "Waiting for dispatch"}</dd>
        <dt>Signature</dt><dd id="slipsig" aria-live="polite"><span class="small">checking in your browser…</span></dd>
      </dl>
      <button class="btn solid wide" data-tab="verify">Try to break the signature →</button>
    </aside>
  </section>
  <div class="proofs">
    <div class="proof"><span class="tick" aria-hidden="true">1</span><div><b>Proved</b><span>Arrival and release locations stamped by WhatsApp's servers. The signed bill of lading times are within 2 minutes of them.</span></div></div>
    <div class="proof"><span class="tick" aria-hidden="true">2</span><div><b>Signed</b><span>Sealed with an AWS KMS signature and locked in S3 for 30 days. Fingerprint <span class="mono">${h(signedDigest)}…</span></span></div></div>
    <div class="proof"><span class="tick" aria-hidden="true">3</span><div><b>Filed</b><span>Approved with one WhatsApp tap. An AI agent wrote and sent the email; code fixed the amount.</span></div></div>
    <p class="runline"><b>What was real:</b> ${h(snap.run.summary.replace(/^Test run: /, ""))} <button class="linkish" data-act="run">Details</button></p>
  </div>`;
}

async function slipSignature(): Promise<void> {
  const el = document.getElementById("slipsig");
  if (!el) return;
  try {
    if (!state.publicKeyPem) {
      const res = await fetch(snap.pack.publicKeyPath);
      if (!res.ok) throw new Error(String(res.status));
      state.publicKeyPem = await res.text();
    }
    const { valid } = await verifyPack(snap.pack.pack, snap.pack.signatureBase64, state.publicKeyPem);
    el.innerHTML = valid ? `<span class="ok">✓ valid</span> checked in your browser just now` : `<span class="no">✕ does not match</span>`;
  } catch {
    el.innerHTML = `<span class="small">could not check here; see tab 2</span>`;
  }
}

function replayTab(): string {
  return `${hero()}${band()}
  <div class="grid3">
    <div>${phone()}</div>
    <div class="mid">${timeline()}</div>
    <div class="right stack">${verdictCard()}${mailCard()}${agentCard()}</div>
  </div>`;
}

// Tab 2: verify the pack

// The fields of a sealed pack the printout reads (see packages/evidence/src/pack.ts).
interface Signal { name: string; ok: boolean; detail?: string }
interface PackShape {
  version?: number;
  loadId?: string;
  clauseId?: string;
  facility?: { name?: string };
  appointmentAt?: string;
  sealedAt?: string;
  events?: {
    arrived?: { serverAt?: string };
    released?: { serverAt?: string };
    bol?: { cameraOnly?: boolean; pageSha256s?: Array<string | null> } | null;
    notice?: unknown;
  };
  corroboration?: { confidence?: string; signals?: Signal[] };
  evaluation?: { verdict?: string; billableMinutes?: number; amountUsd?: number };
}

function tamperedPack(): PackShape {
  const pack = structuredClone(snap.pack.pack) as PackShape;
  if (state.tamper.amount && pack.evaluation) pack.evaluation.amountUsd = 9999;
  if (state.tamper.release && pack.events?.released?.serverAt) pack.events.released.serverAt = new Date(Date.parse(pack.events.released.serverAt) + 30 * 60_000).toISOString();
  if (state.tamper.photo && pack.corroboration?.signals) {
    for (const s of pack.corroboration.signals) if (!s.ok) s.ok = true;
    pack.corroboration.confidence = "high";
  }
  return pack;
}

function packRows(p: PackShape): string {
  const orig = snap.pack.pack as PackShape;
  const row = (label: string, value: string, was: string) => `<span>${h(label)}</span><b class="${value !== was ? "changed" : ""}">${h(value)}</b>`;
  const t = (iso: string | undefined) => (iso ? `${clock(iso, tz())} ${zoneName(iso, tz())}, ${dateLong(iso, tz())}` : "none");
  const signals = (x: PackShape) => (x.corroboration?.signals ?? []).filter((s) => s.ok).length + " of " + (x.corroboration?.signals ?? []).length;
  return `
    <div class="kv">
      ${row("load", p.loadId ?? "", orig.loadId ?? "")}
      ${row("facility", p.facility?.name ?? "", orig.facility?.name ?? "")}
      ${row("contract clause", p.clauseId ?? "", orig.clauseId ?? "")}
      ${row("appointment", t(p.appointmentAt), t(orig.appointmentAt))}
      ${row("arrived · server time", t(p.events?.arrived?.serverAt), t(orig.events?.arrived?.serverAt))}
      ${row("released · server time", t(p.events?.released?.serverAt), t(orig.events?.released?.serverAt))}
      ${row("bill of lading", p.events?.bol ? `camera-only ${p.events.bol.cameraOnly ? "yes" : "no"}, times corrected by driver` : "none", orig.events?.bol ? `camera-only ${orig.events.bol.cameraOnly ? "yes" : "no"}, times corrected by driver` : "none")}
      ${row("photo fingerprint", (p.events?.bol?.pageSha256s ?? []).filter(Boolean).length ? "stored" : "no photo stored", (orig.events?.bol?.pageSha256s ?? []).filter(Boolean).length ? "stored" : "no photo stored")}
      ${row("detention notice", p.events?.notice ? "sent" : "none (not required)", orig.events?.notice ? "sent" : "none (not required)")}
    </div><hr><div class="kv">
      ${row("checks passed", signals(p), signals(orig))}
      ${row("evidence confidence", p.corroboration?.confidence ?? "", orig.corroboration?.confidence ?? "")}
      ${row("verdict", p.evaluation?.verdict ?? "", orig.evaluation?.verdict ?? "")}
      ${row("minutes past free time", (p.evaluation?.billableMinutes ?? 0).toFixed(2), (orig.evaluation?.billableMinutes ?? 0).toFixed(2))}
      ${row("amount owed", usd(p.evaluation?.amountUsd ?? 0), usd(orig.evaluation?.amountUsd ?? 0))}
      ${row("sealed", t(p.sealedAt), t(orig.sealedAt))}
    </div><hr><div class="kv">
      <span>signature</span><b>${h(snap.pack.algorithm.replace("_", " ").replace("_", "-"))} by AWS KMS · ${h(snap.pack.signatureBase64.slice(0, 10))}…${h(snap.pack.signatureBase64.slice(-8))}</b>
      <span>stored</span><b>${h(snap.pack.storage)}</b>
      <span>locations in the pack</span><b>none, only whether each was inside the facility</b>
    </div>`;
}

function verifyTab(): string {
  const p = tamperedPack();
  const changed = state.tamper.amount || state.tamper.release || state.tamper.photo;
  return `
  <div class="grid2">
    <div>
      <div class="colh"><span class="label">The evidence pack, as signed</span><span class="aside"><span class="badge replay">Replay</span> sealed ${at(snap.pack.sealedAt)} ${zone()}</span></div>
      <div class="feed" id="feed">
        <h3>DockClock evidence pack</h3>
        <div class="sub">${h(snap.pack.packId)} · version ${h(String(p.version ?? 1))}${changed ? " · <span style=\"color:var(--red)\">edited in your browser</span>" : ""}</div>
        ${packRows(p)}
      </div>
    </div>
    <div class="stack">
      <div class="panel verify">
        <div class="colh" style="margin-bottom:10px"><span class="label">Check it yourself</span><span class="aside">runs in your browser</span></div>
        <ol class="steps">
          <li>Take the evidence pack shown here and the published public key <code>public-key.pem</code>.</li>
          <li>Rebuild the exact bytes that were signed (the pack's JSON, keys in order).</li>
          <li>Check the AWS KMS signature with your browser's built-in cryptography. No DockClock server is asked.</li>
        </ol>
        <div class="vres wait" id="vres" aria-live="polite"><div class="ic">…</div><div><b>Checking…</b><span>&nbsp;</span></div></div>
        <div class="label" style="margin-top:6px">Now try to change something</div>
        <label class="toggle"><input type="checkbox" role="switch" data-tamper="amount" ${state.tamper.amount ? "checked" : ""}><span><b>Raise the amount</b> to $9,999.00</span></label>
        <label class="toggle"><input type="checkbox" role="switch" data-tamper="release" ${state.tamper.release ? "checked" : ""}><span><b>Move the release</b> 30 minutes later</span></label>
        <label class="toggle"><input type="checkbox" role="switch" data-tamper="photo" ${state.tamper.photo ? "checked" : ""}><span><b>Hide the failed check</b> (no photo was stored)</span></label>
        <p class="note" style="margin-top:12px">The signature proves the recorded times, checks, clause and verdict have not changed since sealing. It cannot prove where a phone really was or what a photo shows.</p>
      </div>
      <div class="panel verify">
        <div class="label">Or check it in a terminal</div>
        <div class="terminal">npm run verify:pack -- docs/evidence/${h(snap.load.loadId)}.pack.json</div>
        <p class="small" style="margin-top:8px"><a href="./keys/public-key.pem" download>Download the public key</a> · <a href="#" data-act="download">Download this pack</a> · key fingerprint <span class="mono">${h(snap.pack.spkiSha256.slice(0, 16))}…</span></p>
      </div>
    </div>
  </div>`;
}

async function runVerify(): Promise<void> {
  const box = document.getElementById("vres");
  if (!box) return;
  try {
    if (!state.publicKeyPem) {
      const res = await fetch(snap.pack.publicKeyPath);
      if (!res.ok) throw new Error(`public key: HTTP ${res.status}`);
      state.publicKeyPem = await res.text();
    }
    const { valid, digest } = await verifyPack(tamperedPack(), snap.pack.signatureBase64, state.publicKeyPem);
    const changes = [state.tamper.amount && "amount", state.tamper.release && "release time", state.tamper.photo && "failed check"].filter(Boolean).join(", ");
    box.className = `vres ${valid ? "good" : "bad"}`;
    box.innerHTML = valid
      ? `<div class="ic">✓</div><div><b>Signature valid</b><span>This is the pack DockClock sealed. Fingerprint <span class="mono">${digest.slice(0, 16)}…</span> matches the one in the claim email.</span></div>`
      : `<div class="ic">✕</div><div><b>Signature does not match</b><span>The pack was changed after sealing (${h(changes)}). Its fingerprint is now <span class="mono">${digest.slice(0, 16)}…</span></span></div>`;
  } catch (error) {
    box.className = "vres wait";
    box.innerHTML = `<div class="ic">!</div><div><b>Could not run the check</b><span>${h((error as Error).message)}. Use the terminal command below instead.</span></div>`;
  }
}

// Tab 3: change one thing

interface WhatIf {
  id: string;
  label: string;
  detail: string;
  applies: boolean;
  why?: string;
  apply: (e: LoadEvidence) => LoadEvidence;
}

function whatIfs(): WhatIf[] {
  const spec = clauseSpec(snap.clause.id);
  const c = snap.clock;
  const free = c.freeTimeEndsAt;
  return [
    {
      id: "early",
      label: "The truck left before free time ended",
      detail: free ? `Released at ${at(new Date(Date.parse(free) - 10 * 60_000).toISOString())} instead of ${c.releasedAt ? at(c.releasedAt) : ""}` : "",
      applies: Boolean(free),
      apply: (e) => ({ ...e, released: e.released && free ? { ...e.released, at: new Date(Date.parse(free) - 10 * 60_000).toISOString() } : e.released, bol: e.bol && free ? { ...e.bol, checkOut: new Date(Date.parse(free) - 12 * 60_000).toISOString() } : e.bol }),
    },
    {
      id: "late",
      label: "The truck arrived 20 minutes late",
      detail: "After the appointment, so this contract owes nothing",
      applies: spec.requireOnTimeArrival,
      why: "This contract does not require an on-time arrival",
      apply: (e) => {
        const t = new Date(Date.parse(e.appointmentAt) + 20 * 60_000).toISOString();
        return { ...e, arrived: e.arrived ? { ...e.arrived, at: t } : e.arrived, bol: e.bol ? { ...e.bol, checkIn: new Date(Date.parse(t) + 2 * 60_000).toISOString() } : e.bol };
      },
    },
    {
      id: "unsigned",
      label: "The receiver did not sign the bill of lading",
      detail: "So there is no signed record of the times",
      applies: true,
      apply: (e) => ({ ...e, bol: e.bol ? { ...e.bol, signed: false } : e.bol }),
    },
    {
      id: "conflict",
      label: "The written out-time is 40 minutes off the release location",
      detail: "Paper and phone disagree, so a person must look",
      applies: true,
      apply: (e) => ({ ...e, bol: e.bol && e.released ? { ...e.bol, checkOut: new Date(Date.parse(e.released.at) + 40 * 60_000).toISOString() } : e.bol }),
    },
    {
      id: "notice",
      label: "No detention notice was emailed",
      detail: "Some contracts pay only if the shipper was warned in time",
      applies: spec.noticeLeadMinutes !== null,
      why: "This contract does not require a notice",
      apply: (e) => ({ ...e, noticeSentAt: null }),
    },
    {
      id: "window",
      label: "The claim was filed 8 days later",
      detail: `After the contract's ${spec.claimWindowHours % 24 === 0 ? `${spec.claimWindowHours / 24}-day` : `${spec.claimWindowHours}-hour`} claim window`,
      applies: true,
      apply: (e) => ({ ...e, evaluatedAt: e.released ? new Date(Date.parse(e.released.at) + (spec.claimWindowHours + 24) * 3_600_000).toISOString() : e.evaluatedAt }),
    },
  ];
}

function whatifTab(): string {
  const base = recordedEvidence(snap);
  const all = whatIfs();
  let changed = base;
  for (const w of all) if (w.applies && state.whatif.has(w.id)) changed = w.apply(changed);
  const recorded = run(base);
  const computed = run(changed);
  const ask = baseline(changed);
  const any = state.whatif.size > 0;
  const stampFor = (v: string) => (v === "BILLABLE" ? ["OWED", ""] : v === "NOT_BILLABLE" ? ["NOT OWED", "red"] : ["NEEDS A PERSON", "amber"]);
  const [rs, rc] = stampFor(recorded.verdict);
  const [cs, cc] = stampFor(computed.verdict);
  const reasons = computed.reasons.filter((r) => r !== "CAP_APPLIED");
  const hl = headline();
  return `
  <section class="hero" style="grid-template-columns:1fr">
    <div>
      <div class="eyebrow"><span class="badge computed">Computed</span><span>The real clause engine, running in your browser on this load's inputs. Nothing is sent and no load is created.</span></div>
      <h1 style="max-width:30ch">Change one fact. The contract decides again.</h1>
      <p class="lede">Claims are lost for reasons the contract spells out. Flip a switch and watch the same code the workflow runs give its verdict and its reason.</p>
    </div>
  </section>
  <div class="wi">
    <div>
      <div class="label" style="margin-bottom:4px">What if</div>
      ${all
        .map(
          (w) => `<label class="toggle ${w.applies ? "" : "disabled"}"><input type="checkbox" role="switch" data-whatif="${w.id}" ${state.whatif.has(w.id) ? "checked" : ""} ${w.applies ? "" : "disabled"}><span><b>${h(w.label)}</b><br><span class="small">${h(w.applies ? w.detail : (w.why ?? ""))}</span></span></label>`,
        )
        .join("")}
      ${any ? `<p style="margin-top:10px"><button class="linkish" data-act="reset-whatif">Back to what was recorded</button></p>` : ""}
    </div>
    <div>
      <div class="label" style="margin-bottom:8px">Verdict</div>
      <div class="compare">
        <div class="panel mini"><span class="badge replay">Recorded</span><div style="margin-top:12px"><span class="stamp ${rc}" style="font-size:16px">${rs}</span></div><div class="amount">${usd(recorded.amountUsd)}</div></div>
        <div class="panel mini" aria-live="polite"><span class="badge computed">Computed</span><div style="margin-top:12px"><span class="stamp ${cc} ${any ? "land" : ""}" style="font-size:16px">${cs}</span></div><div class="amount">${usd(computed.amountUsd)}</div></div>
      </div>
      ${
        any
          ? reasons.length
            ? `<div class="reason">${reasons.map((r) => `<div><code>${r}</code> · ${h(REASON_WORDS[r])}.</div>`).join("")}</div>`
            : `<div class="reason okay">Still owed: ${usd(computed.amountUsd)}.</div>`
          : `<div class="reason okay">As recorded: ${duration(recorded.billableMinutes)} past free time, so ${usd(recorded.amountUsd)} is owed.</div>`
      }
      <p class="note" style="margin-top:12px">The usual shortcut, "bill every stop over 2 hours", would ${ask.filed ? `ask for <b>${usd(ask.amountUsd)}</b> here` : "ask for nothing here"}${ask.filed && computed.verdict !== "BILLABLE" ? ", and the shipper could refuse every cent of it" : ""}.</p>
    </div>
  </div>
  <section class="panel score" aria-label="The same engine on 24 test loads">
    <div><div class="label">The contracts owe</div><div class="big">${usd(hl.owedUsd)}</div><p>across ${hl.loads} test loads</p></div>
    <div><div class="label">DockClock claims</div><div class="big amber">${usd(hl.dockclockClaimedUsd)}</div><p>${hl.filed} claims, ${hl.filedValid === hl.filed ? `all ${hl.filed}` : `${hl.filedValid} of ${hl.filed}`} valid, ${hl.falseHolds} owed claims held back</p></div>
    <div><div class="label">The 2-hour shortcut asks for</div><div class="big">${usd(hl.baselineAskUsd)}</div><p><b style="color:var(--red)">${usd(hl.baselineRefusableUsd)} (${hl.baselineRefusablePct}%)</b> of it the contract denies, overpays or cannot prove</p></div>
    <div class="foot"><span class="badge computed">Computed</span> Recomputed in your browser by the same engine from the ${hl.loads} hand-labelled test loads (fixture sha256 <span class="mono">${hl.fixtureSha256.slice(0, 8)}…</span>). We wrote the expected answers from each clause's text, so this is a consistency check, not field data.</div>
  </section>`;
}

// Shell

function topbar(): string {
  const tab = (id: Tab, n: number, label: string) => `<button class="tab" role="tab" id="tab-${id}" aria-selected="${state.tab === id}" aria-controls="panel" data-tab="${id}"><span class="n">${n}</span>${label}</button>`;
  return `<header class="top">
    <a class="brand" href="./" aria-label="DockClock judge desk"><img src="./logo-mark.svg" alt=""><b>DockClock</b><span>Judge desk</span></a>
    <nav class="tabs" role="tablist" aria-label="Sections">${tab("replay", 1, "Watch the load")}${tab("verify", 2, "Break the signature")}${tab("whatif", 3, "Change one fact")}</nav>
    <div class="spacer"></div>
    <button class="btn" data-act="phone">Try it on your phone</button>
  </header>`;
}

function footer(): string {
  return `<footer class="foot">
    <div><b>Why it matters.</b> US truckload carriers are paid on only 55% of the detention invoices they send, about $5,104 a driver a year left unpaid (ATRI, 2024, survey estimates). Claims fail on the details: no notice, a missing signature, a late filing. DockClock collects the proof on the driver's WhatsApp and files only what the contract owes.</div>
    <div><b>Every company here is fictional.</b> Loads, drivers and contracts are made up; contract terms are modelled on published shipper terms. Built on AWS End User Messaging (WhatsApp and RCS), Amazon SES, AWS Step Functions, AWS KMS, Amazon S3 and Amazon Bedrock AgentCore. Source and every claim's evidence: the repository's README and FACTS.md.</div>
  </footer>`;
}

function render(): void {
  const panel = state.tab === "replay" ? replayTab() : state.tab === "verify" ? verifyTab() : whatifTab();
  app.innerHTML = `${topbar()}<main id="panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${panel}</main>${footer()}<dialog class="drawer" id="drawer"></dialog>`;
  const chat = document.getElementById("chat");
  if (chat) chat.scrollTop = chat.scrollHeight;
  if (state.tab === "verify") void runVerify();
  if (state.tab === "replay") void slipSignature();
}

// Partial re-render during playback keeps the page from jumping.
function renderReplayParts(): void {
  if (state.tab !== "replay") return render();
  const grid = app.querySelector(".grid3");
  const bandEl = app.querySelector(".band");
  if (!grid || !bandEl) return render();
  bandEl.outerHTML = band();
  const [left, mid] = Array.from(grid.children) as HTMLElement[];
  left!.innerHTML = phone();
  mid!.innerHTML = timeline();
  const chat = document.getElementById("chat");
  if (chat) chat.scrollTop = chat.scrollHeight;
}

// Playback

function stop(): void {
  state.playing = false;
  if (state.timer) window.clearInterval(state.timer);
  state.timer = 0;
}

function goTo(step: number): void {
  state.step = Math.max(0, Math.min(snap.timeline.length - 1, step));
  const e = snap.timeline[state.step];
  const latest = snap.messages.filter((m) => e && Date.parse(m.at) <= Date.parse(e.at)).pop();
  if (latest) state.party = latest.party;
}

function play(): void {
  if (state.playing) {
    stop();
    renderReplayParts();
    return;
  }
  state.tab = "replay";
  state.cursor = null;
  if (!Number.isFinite(state.step) || state.step >= snap.timeline.length - 1) {
    shownMessages = new Set();
    goTo(0);
  }
  state.playing = true;
  render();
  state.timer = window.setInterval(() => {
    if (state.step >= snap.timeline.length - 1) {
      stop();
      state.step = Number.POSITIVE_INFINITY;
      renderReplayParts();
      return;
    }
    goTo(state.step + 1);
    renderReplayParts();
  }, STEP_MS);
}

// The opening sweep: the dock clock runs from arrival to the claim in about 2 seconds.
function intro(): void {
  if (reduceMotion || state.tab !== "replay") return;
  const [a, b] = range();
  const start = performance.now();
  const total = 2200;
  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / total);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    state.cursor = new Date(a + (b - a) * eased).toISOString();
    const bandEl = app.querySelector(".band");
    if (bandEl && !state.playing) bandEl.outerHTML = band();
    if (t < 1 && !state.playing) requestAnimationFrame(frame);
    else {
      state.cursor = null;
      if (!state.playing) {
        const el = app.querySelector(".band");
        if (el) el.outerHTML = band();
        const stamp = app.querySelector(".slip .stamp");
        stamp?.classList.add("land");
      }
    }
  };
  requestAnimationFrame(frame);
}

function openDrawer(title: string, html: string): void {
  const d = document.getElementById("drawer") as HTMLDialogElement | null;
  if (!d) return;
  d.innerHTML = `<div class="hd"><h2>${h(title)}</h2><button class="x" data-act="close" aria-label="Close">✕</button></div><div class="bd">${html}</div>`;
  d.showModal();
}

function eventDrawer(e: TimelineEvent): void {
  const msg = e.messageId ? snap.messages.find((m) => m.id === e.messageId) : undefined;
  const email = e.emailId ? snap.emails.find((m) => m.id === e.emailId) : undefined;
  const agentRun = e.agentRunId ? snap.agentRuns.find((r) => r.id === e.agentRunId) : undefined;
  const parts = [
    `<p class="note">${at(e.at)} ${zone()}, ${h(dateLong(e.at, tz()))}</p>`,
    e.detail ? `<p style="margin-top:8px">${h(e.detail)}</p>` : "",
    `<p class="small" style="margin-top:10px"><span class="badge ghost">${h(e.provenance.replace(/_/g, " "))}</span> ${h(PROVENANCE_WORDS[e.provenance])}</p>`,
    `<p class="small" style="margin-top:6px">Services: ${e.services.map(h).join(", ") || "none"}</p>`,
    e.record ? `<div class="label" style="margin-top:18px">The stored record</div><pre>${h(JSON.stringify(e.record, null, 2))}</pre>` : "",
    msg ? `<div class="label" style="margin-top:18px">The message</div><pre>${h(JSON.stringify(msg, null, 2))}</pre>` : "",
    agentRun ? `<div class="label" style="margin-top:18px">The agent run</div><pre>${h(JSON.stringify(agentRun, null, 2))}</pre>` : "",
    email ? `<div class="label" style="margin-top:18px">The email record</div><pre>${h(JSON.stringify({ ...email, body: email.body ? `${email.body.slice(0, 200)}…` : undefined }, null, 2))}</pre>` : "",
  ];
  openDrawer(e.title, parts.join(""));
}

// Events

app.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const el = t.closest<HTMLElement>("[data-act],[data-tab],[data-ev],[data-party]");
  if (!el) return;
  if (el.dataset.tab) {
    stop();
    state.tab = el.dataset.tab as Tab;
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  if (el.dataset.party) {
    state.party = el.dataset.party as "driver" | "dispatcher";
    renderReplayParts();
    return;
  }
  if (el.dataset.ev) {
    const e = snap.timeline[Number(el.dataset.ev)];
    if (e) eventDrawer(e);
    return;
  }
  switch (el.dataset.act) {
    case "play":
      play();
      break;
    case "close":
      (document.getElementById("drawer") as HTMLDialogElement | null)?.close();
      break;
    case "mail": {
      document.getElementById("mailbody")?.classList.toggle("open");
      document.getElementById("mailfade")?.classList.toggle("open");
      el.textContent = el.textContent?.startsWith("Show") ? "Show less" : "Show the whole email";
      break;
    }
    case "run":
      openDrawer("What was real in this load", `<ul>${snap.run.notes.map((n) => `<li>${h(n)}</li>`).join("")}</ul><p class="small" style="margin-top:14px">Load ${h(snap.load.loadId)}. The page never shows locations, phone numbers or account details.</p>`);
      break;
    case "phone":
      openDrawer(
        "Try it on your own phone",
        `<p>Send <b class="mono">DEMO</b> on WhatsApp to the DockClock number on the Devpost submission page (<b class="mono">DEMO ES</b> for Spanish, <b class="mono">DEMO FR</b> for French). It takes about 10 minutes, most of it a real 5-minute wait. You play both the driver and the dispatcher.</p>
         <ul><li>Tap Arrived and share your location. In the demo any location counts.</li><li>Wait past the 5 minutes of free time; the detention notice is emailed.</li><li>Tap Released, share your location again, and photograph a note with the times in the form.</li><li>Approve the claim. The AI agent files it and the chat tells you the amount and the pack's fingerprint.</li></ul>
         <p class="small" style="margin-top:12px">The demo clause is fictional (5 minutes free, $60 an hour, $30 cap). Claim and notice emails go to our test mailbox, never to you. Each number gets 5 demos a day.</p>`,
      );
      break;
    case "reset-whatif":
      state.whatif.clear();
      render();
      break;
    case "download": {
      ev.preventDefault();
      const blob = new Blob([JSON.stringify({ pack: snap.pack.pack, algorithm: snap.pack.algorithm, signatureBase64: snap.pack.signatureBase64 }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${snap.pack.packId}.pack.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      break;
    }
  }
});

app.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.dataset.tamper) {
    state.tamper[t.dataset.tamper as keyof typeof state.tamper] = t.checked;
    const feed = document.getElementById("feed");
    if (feed) {
      const keep = window.scrollY;
      render();
      window.scrollTo({ top: keep });
      (document.querySelector(`[data-tamper="${t.dataset.tamper}"]`) as HTMLElement | null)?.focus();
    }
  }
  if (t.dataset.whatif) {
    if (t.checked) state.whatif.add(t.dataset.whatif);
    else state.whatif.delete(t.dataset.whatif);
    const keep = window.scrollY;
    render();
    window.scrollTo({ top: keep });
    (document.querySelector(`[data-whatif="${t.dataset.whatif}"]`) as HTMLElement | null)?.focus();
  }
});

app.addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === "scrub") {
    stop();
    goTo(Number(t.value));
    renderReplayParts();
    document.getElementById("scrub")?.focus();
  }
});

document.addEventListener("keydown", (ev) => {
  if (state.tab !== "replay") return;
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "BUTTON" || el.tagName === "TEXTAREA" || el.closest("dialog[open]"))) return;
  if (ev.key === " ") {
    ev.preventDefault();
    play();
  } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    stop();
    goTo((Number.isFinite(state.step) ? state.step : snap.timeline.length - 1) + (ev.key === "ArrowRight" ? 1 : -1));
    renderReplayParts();
  }
});

// Start

const params = new URLSearchParams(location.search);
load().then((s) => {
  snap = s;
  const tab = params.get("tab");
  if (tab === "verify" || tab === "whatif") state.tab = tab;
  for (const k of (params.get("tamper") ?? "").split(",")) if (k in state.tamper) state.tamper[k as keyof typeof state.tamper] = true;
  for (const k of (params.get("whatif") ?? "").split(",").filter(Boolean)) state.whatif.add(k);
  const step = params.get("step");
  if (step !== null && /^\d+$/.test(step)) goTo(Number(step));
  else shownMessages = new Set(snap.messages.map((m) => m.id));
  render();
  if (!params.has("nointro") && step === null) intro();
});
