import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useParams, useSearchParams } from "react-router-dom";
import { approvalWords, isRealPhoneRun, provedWords, runLabel, stoppedStep, testStrip } from "../copy/provenance.js";
import { recordedCaptures, useLoad, usePack } from "../model/client.js";
import { flowNodes, type FlowNode } from "../model/flow.js";
import type { ConsoleEmail, LoadDetail, TimelineItem } from "../model/model.js";
import { clock, clockOn, placeName, usd } from "../format.js";
import { AgentFlow } from "../ui/AgentFlow.js";
import { Page } from "../ui/AppShell.js";
import { ChannelBadge, ProvenanceBadge, Stamp } from "../ui/badges.js";
import { ConversationView, failoverMarkers } from "../ui/ConversationView.js";
import { DockClockBand } from "../ui/DockClockBand.js";
import { Drawer, Json } from "../ui/Drawer.js";
import { EmailBody } from "../ui/EmailView.js";
import { EmptyState } from "../ui/EmptyState.js";
import { EvidencePanel } from "../ui/EvidencePanel.js";
import { Timeline } from "../ui/Timeline.js";
import { WhatIfPanel } from "../ui/WhatIfPanel.js";

const TABS = [
  ["timeline", "Timeline"],
  ["conversation", "Conversation"],
  ["emails", "Emails"],
  ["agent", "Agent"],
  ["evidence", "Evidence"],
  ["whatif", "What if"],
] as const;

export type LoadTab = (typeof TABS)[number][0];

// Replay playback over a load's timeline: one record every 1.2 s.
export function usePlayback(load: LoadDetail | null | undefined) {
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
  };
  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current);
  }, []);
  const toggle = () => {
    if (!load) return;
    if (timer.current) return stop();
    setStep(0);
    setPlaying(true);
    timer.current = window.setInterval(() => {
      setStep((s) => {
        const next = (s ?? 0) + 1;
        if (next >= load.timeline.length) {
          stop();
          return null;
        }
        return next;
      });
    }, 1200);
  };
  const cursor = load && step !== null ? (load.timeline[step]?.at ?? null) : null;
  return { step, cursor, playing, toggle };
}

const STATUS_WORDS: Record<string, string> = { waiting_for_arrival: "Waiting", at_dock: "At dock", paperwork: "Paperwork", sealing: "Sealing", awaiting_approval: "Approval", filing: "Filing", claim_filed: "Filed", held: "Held", not_billable: "Not owed", needs_human: "Review", closed: "Closed" };

export function LoadHeader({ load }: { load: LoadDetail }) {
  // Owed but never filed (no approval came): say so beside the amount.
  const unfiled = !load.claim && stoppedStep(load, "claim") ? "Not filed: no approval" : null;
  return (
    <div className="loadhead">
      <div>
        <div className="page-head" style={{ margin: 0 }}>
          <h1>{placeName(load.summary.facility)}</h1>
        </div>
        <div className="meta">
          <span className="mono">{load.summary.id}</span>
          <ChannelBadge channel={load.summary.channel} />
          {isRealPhoneRun(load) && <span className="runchip">{runLabel(load)}</span>}
        </div>
      </div>
      <div className="owed">
        <Stamp verdict={load.verdict?.verdict ?? null} />
        {load.verdict ? <div className="num">{usd(load.verdict.amountUsd)}</div> : <div className="small" style={{ marginTop: 10 }}>not sealed yet</div>}
        {unfiled && <div className="unfiled">{unfiled}</div>}
      </div>
    </div>
  );
}

export function LoadDetailRoute() {
  const { id, tab: tabParam } = useParams();
  const [search] = useSearchParams();
  const tab = tabParam ?? search.get("tab") ?? "timeline";
  const q = useLoad(id);
  const load = q.data?.data;
  const play = usePlayback(load);
  const [record, setRecord] = useState<TimelineItem | null>(null);
  const [email, setEmail] = useState<ConsoleEmail | null>(null);
  const [node, setNode] = useState<FlowNode | null>(null);
  const [party, setParty] = useState<"driver" | "dispatcher">("driver");
  const captures = useMemo(() => (id ? recordedCaptures(id) : []), [id]);
  const stageParam = search.get("stage");
  const [capture, setCapture] = useState<number | null>(() => {
    const i = stageParam ? captures.findIndex((c) => c.status === stageParam) : -1;
    return i >= 0 && i < captures.length - 1 ? i : null;
  });
  const shown = capture !== null ? captures[capture]?.detail : undefined;
  const pack = usePack(load);
  const tabsRef = useRef<HTMLElement | null>(null);
  const [tabsMore, setTabsMore] = useState(false);
  const [tabsLess, setTabsLess] = useState(false);
  const checkTabs = () => {
    const el = tabsRef.current;
    if (!el) return;
    setTabsMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    setTabsLess(el.scrollLeft > 4);
  };
  // On a narrow screen the active tab may sit past the edge: bring it into the strip.
  useEffect(() => {
    const el = tabsRef.current;
    const active = el?.querySelector<HTMLElement>("a.active");
    if (el && active && (active.offsetLeft + active.offsetWidth > el.scrollLeft + el.clientWidth || active.offsetLeft < el.scrollLeft)) el.scrollLeft = active.offsetLeft - 16;
    checkTabs();
  }, [tab, Boolean(load)]);
  if (!load)
    return (
      <Page crumbs={[{ to: "/loads", label: "Loads" }, { label: id ?? "" }]}>
        <EmptyState title={q.isLoading ? "Loading" : "Load not found"} />
      </Page>
    );
  const upTo = play.cursor ? Date.parse(play.cursor) : undefined;
  const hasDispatcher = load.messages.some((m) => m.party === "dispatcher");
  return (
    <Page
      crumbs={[{ to: "/loads", label: "Loads" }, { label: load.summary.id }]}
      badges={q.data && <ProvenanceBadge kind={q.data.source} />}
      strip={testStrip(load)}
    >
      <LoadHeader load={shown ?? load} />
      {captures.length > 0 && (tab === "timeline" || tab === "conversation") && (
        <div className="progress" role="group" aria-label="Recorded progress">
          {captures.map((c, i) => {
            const current = capture ?? captures.length - 1;
            const state = i < current ? "done" : i === current ? "current" : "next";
            return (
              <button key={c.status} className={state} aria-pressed={capture === i} aria-current={i === current ? "step" : undefined} onClick={() => setCapture(i === captures.length - 1 ? null : i)} title={`As recorded at ${clock(c.asOf, load.timeZone)}`}>
                {STATUS_WORDS[c.status] ?? c.status.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      )}
      <nav className="tabs" aria-label="Load sections" ref={tabsRef} data-more={tabsMore || undefined} data-less={tabsLess || undefined} onScroll={checkTabs}>
        {TABS.map(([k, label]) => (
          <NavLink key={k} to={`/loads/${load.summary.id}/${k}`} className={() => (tab === k ? "active" : "")}>
            {label}
          </NavLink>
        ))}
      </nav>
      {tab === "timeline" && (
        <>
          <DockClockBand load={shown ?? load} cursor={shown ? null : play.cursor} playing={play.playing} {...(shown ? {} : { onPlay: play.toggle })} />
          <div className="card" style={{ marginTop: 16 }}>
            <Timeline items={(shown ?? load).timeline} timeZone={load.timeZone} {...(upTo !== undefined ? { upTo } : {})} {...(play.step !== null ? { current: play.step } : {})} onOpen={setRecord} />
          </div>
        </>
      )}
      {tab === "conversation" && (
        <div className="grid-2">
          <div>
            {hasDispatcher && (
              <div className="segctl" role="group" aria-label="Whose phone" style={{ marginBottom: 12 }}>
                <button aria-pressed={party === "driver"} onClick={() => setParty("driver")}>Driver</button>
                <button aria-pressed={party === "dispatcher"} onClick={() => setParty("dispatcher")}>Dispatcher</button>
              </div>
            )}
            <ConversationView messages={(shown ?? load).messages} timeZone={load.timeZone} party={party} markers={failoverMarkers((shown ?? load).timeline)} />
          </div>
          <div className="card">
            <div className="card-head"><h2>Proof</h2></div>
            <div className="card-body">
              <p><b>{provedWords(load).short}.</b> {provedWords(load).long}</p>
              <p style={{ marginTop: 10 }}><b>{approvalWords(load).short}.</b> {approvalWords(load).long}</p>
            </div>
          </div>
        </div>
      )}
      {tab === "emails" && (
        <div className="card">
          {load.emails.length === 0 ? (
            <EmptyState title="No emails" />
          ) : (
            load.emails.map((e) => (
              <button className="mailrow" key={e.id} onClick={() => setEmail(e)}>
                <span className="k">{e.purpose === "dispatch_escalation" ? "Escalation" : e.purpose}</span>
                <span className="s">{e.subject}</span>
                <span className="small">{clockOn(e.sentAt, load.timeZone, load.emails[0]?.sentAt ?? e.sentAt)} ∙ {e.status === "not_sent" ? "not sent (test)" : e.status}</span>
              </button>
            ))
          )}
        </div>
      )}
      {tab === "agent" && (
        <div className="card">
          <div className="card-head">
            <h2>Workflow</h2>
            <span className="small">from records ∙ * policy inferred</span>
          </div>
          <div className="card-body">
            <AgentFlow nodes={flowNodes(load)} timeZone={load.timeZone} onOpen={setNode} />
          </div>
        </div>
      )}
      {tab === "evidence" && (pack.data ? <EvidencePanel pack={pack.data} timeZone={load.timeZone} photos={load.photos} /> : <EmptyState title={load.packSummary ? "Loading the pack" : "Not sealed yet"} />)}
      {tab === "whatif" && <WhatIfPanel load={load} />}
      {record && (
        <Drawer title={record.title} onClose={() => setRecord(null)}>
          <p className="small">{clock(record.at, load.timeZone)} ∙ {record.services.join(" → ")}</p>
          {record.detail && <p style={{ marginTop: 10 }}>{record.detail}</p>}
          {record.synthetic && <p className="small" style={{ marginTop: 10 }}>A replayed test message, not a phone.</p>}
          {record.record && <div style={{ marginTop: 14 }}><Json value={record.record} /></div>}
        </Drawer>
      )}
      {email && (
        <Drawer title={email.purpose === "claim" ? "Claim email" : email.purpose === "notice" ? "Notice email" : "Escalation"} onClose={() => setEmail(null)}>
          <EmailBody load={load} email={email} />
        </Drawer>
      )}
      {node && (
        <Drawer title={node.title} onClose={() => setNode(null)}>
          <p className="small">{node.tone === "skipped" ? "Never ran" : clockOn(node.at, load.timeZone, load.timeline[0]?.at ?? node.at)} ∙ {node.services.join(" ∙ ")}</p>
          {typeof (node.raw as { detail?: unknown } | undefined)?.detail === "string" && <p style={{ marginTop: 10 }}>{(node.raw as { detail: string }).detail}</p>}
          {/* A stopped workflow step has only its reason; its raw label names the step, not the outcome. */}
          {!(node.raw && typeof node.raw === "object" && "state" in node.raw) && <div style={{ marginTop: 14 }}><Json value={node.raw} /></div>}
        </Drawer>
      )}
    </Page>
  );
}
