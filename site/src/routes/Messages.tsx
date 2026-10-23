import { acceptsAnyLocation } from "../copy/provenance.js";
import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { hasRecordedDetail, useLoad, useLoads, useMessages } from "../model/client.js";
import { FEED_SORTS, STATUS_FILTERS, filterFeed, orderFeed, parseSort } from "../model/feedOrder.js";
import type { Channel, FeedRow } from "../model/model.js";
import { clock, dayLabel, dayShort } from "../format.js";
import { Page } from "../ui/AppShell.js";
import { ChannelBadge, ChannelIcon, ProvenanceBadge, StatusPill, channelName } from "../ui/badges.js";
import { ConversationView } from "../ui/ConversationView.js";
import { Drawer } from "../ui/Drawer.js";
import { EmailBody } from "../ui/EmailView.js";
import { EmptyState } from "../ui/EmptyState.js";

const PURPOSE: Record<string, string> = {
  tap_arrived: "Tapped Arrived",
  tap_released: "Tapped Released",
  location: "Shared location",
  arrival_pin: "Shared location",
  release_pin: "Shared location",
  flow_reply: "Bill of lading form",
  bol_flow: "Bill of lading form",
  dispatch_approval: "Approval request",
  approval_reply: "Approval reply",
  approve_tap: "Tapped Approve",
  notice: "Detention notice",
  claim: "Detention claim",
  dispatch_escalation: "Escalation",
  location_request: "Location request",
  checked_in: "Checked in",
  release_flow: "Bill of lading request",
  bol_received: "Bill of lading saved",
  outcome_billable: "Verdict to driver",
  outcome_filed: "Claim-filed message",
  dispatch_template: "Load dispatched",
  retake: "Clearer photo request",
  photo: "Bill of lading photo",
  offer_release: "Released button",
  location_arrived: "Arrival location request",
  location_released: "Release location request",
  dispatch_card: "Load dispatched",
  notice_sent: "Notice sent to driver",
  tell_bol_photo_received: "Photo saved",
  tell_bol_partial: "Paperwork incomplete",
  tell_tap_arrived_first: "Tap Arrived first",
  tell_bol_received: "Bill of lading saved",
};

export function purposeWords(m: { purpose: string }): string {
  return PURPOSE[m.purpose] ?? m.purpose.replace(/_/g, " ");
}

export function Messages() {
  const q = useMessages();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<FeedRow | null>(null);
  const loads = useLoads();
  const tzOf = (id: string) => loads.data?.data.find((l) => l.id === id)?.timeZone ?? "America/New_York";
  const channel = (params.get("channel") as Channel | null) ?? null;
  const status = params.get("status") ?? "All";
  const sort = parseSort(params.get("sort"));
  const grouped = sort === "load";
  const all = q.data?.data ?? [];
  const channels = useMemo(() => {
    const base: Channel[] = ["whatsapp", "rcs", "email"];
    return all.some((m) => m.channel === "sms") ? [...base, "sms" as Channel] : base;
  }, [all]);
  const rows = orderFeed(filterFeed(all, channel, status), sort);
  const now = new Date().toISOString();
  const cols = grouped ? 5 : 6;
  // By load: a load whose rows fall on one day names the day in its header; one that spans
  // days puts the date on every row.
  const days = new Map<string, Set<string>>();
  if (grouped) for (const m of rows) days.set(m.loadId, (days.get(m.loadId) ?? new Set()).add(dayShort(m.at, tzOf(m.loadId))));

  // Each choice is a history entry, so back and forward step through filters and sorts.
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };
  return (
    <Page crumbs={[{ label: "Messages" }]} badges={q.data && <ProvenanceBadge kind={q.data.source} />}>
      <div className="toolbar">
        <div className="segctl" role="group" aria-label="Channel">
          <button aria-pressed={!channel} onClick={() => set("channel", null)}>All</button>
          {channels.map((c) => (
            <button key={c} aria-pressed={channel === c} onClick={() => set("channel", c)}>
              <ChannelIcon channel={c} />
              {channelName(c)}
            </button>
          ))}
        </div>
        <div className="segctl" role="group" aria-label="Status">
          {STATUS_FILTERS.map(([n]) => (
            <button key={n} aria-pressed={status === n} onClick={() => set("status", n === "All" ? null : n)}>{n}</button>
          ))}
        </div>
        <div className="segctl sortctl" role="group" aria-label="Sort">
          {FEED_SORTS.map(([k, label]) => (
            <button key={k} aria-pressed={sort === k} onClick={() => set("sort", k === "newest" ? null : k)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <EmptyState title="No messages">Try another filter.</EmptyState>
        ) : (
          <table className={grouped ? "table msgs" : "table msgs flat"}>
            <thead>
              <tr>
                <th>Time</th>
                {!grouped && <th>Load</th>}
                <th>Channel</th>
                <th className="hide-m">Party</th>
                <th>What</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => {
                const prev = rows[i - 1];
                const tz = tzOf(m.loadId);
                // By load: a header per load. By date: a date row at each change of day.
                const head = grouped ? !prev || prev.loadId !== m.loadId : !prev || dayShort(prev.at, tzOf(prev.loadId)) !== dayShort(m.at, tz);
                const opens = q.data?.source !== "fixture" || hasRecordedDetail(m.loadId);
                return (
                  <Fragment key={m.id}>
                  {head && grouped && (
                    <tr className="group">
                      <td colSpan={cols}>
                        <Link to={`/loads/${m.loadId}`} onClick={(e) => e.stopPropagation()}>{m.loadId}</Link>
                        {days.get(m.loadId)?.size === 1 && <span className="gday">{dayLabel(m.at, tz, now)}</span>}
                      </td>
                    </tr>
                  )}
                  {head && !grouped && (
                    <tr className="group day">
                      <td colSpan={cols}>{dayLabel(m.at, tz, now)}</td>
                    </tr>
                  )}
                  <tr className={opens ? "" : "summary-only"} onClick={() => opens && setOpen(m)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(m)}>
                    <td className="ts">{grouped && (days.get(m.loadId)?.size ?? 0) > 1 ? `${dayShort(m.at, tz)}, ${clock(m.at, tz)}` : clock(m.at, tz)}</td>
                    {!grouped && (
                      <td className="ld">
                        {/* The chip marks where a load's run starts; rows that continue it name the load for screen readers only. */}
                        {head || prev?.loadId !== m.loadId ? (
                          <Link className="loadchip" to={`/loads/${m.loadId}`} onClick={(e) => e.stopPropagation()}>{m.loadId}</Link>
                        ) : (
                          <span className="sr-only">{m.loadId}</span>
                        )}
                      </td>
                    )}
                    <td className="ch"><ChannelBadge channel={m.channel} /></td>
                    <td className="hide-m">{m.direction === "in" ? "from " : "to "}{m.party}</td>
                    <td className="what">{purposeWords(m)}</td>
                    <td><StatusPill status={m.status} /></td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {open && (
        <Drawer title={purposeWords(open)} onClose={() => setOpen(null)}>
          <FeedDetail row={open} />
        </Drawer>
      )}
    </Page>
  );
}

function FeedDetail({ row }: { row: FeedRow }) {
  const q = useLoad(row.loadId);
  const d = q.data?.data;
  if (q.isLoading) return <p className="small">Loading…</p>;
  if (!d) return <p className="small">Load not found.</p>;
  if (row.isEmail) {
    const email = d.emails.find((e) => (e.id.split(":").pop() ?? e.id) === row.localId);
    return email ? <EmailBody load={d} email={email} /> : <p className="small">Email not found.</p>;
  }
  const msg = d.messages.find((m) => (m.id.split(":").pop() ?? m.id) === row.localId);
  return (
    <>
      <ConversationView messages={d.messages} timeZone={d.timeZone} party={msg?.party === "dispatcher" ? "dispatcher" : "driver"} upTo={Date.parse(row.at)} anyLocation={acceptsAnyLocation(d)} />
      <p style={{ marginTop: 14 }}>
        <Link className="btn small" to={`/loads/${d.summary.id}/conversation`}>Open load {d.summary.id}</Link>
      </p>
    </>
  );
}
