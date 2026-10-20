import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useLoad, useLoads, useMessages } from "../model/client.js";
import type { Channel, FeedRow, MessageStatus } from "../model/model.js";
import { clock } from "../format.js";
import { Page } from "../ui/AppShell.js";
import { ChannelBadge, ChannelIcon, ProvenanceBadge, StatusPill, channelName } from "../ui/badges.js";
import { ConversationView } from "../ui/ConversationView.js";
import { Drawer } from "../ui/Drawer.js";
import { EmailBody } from "../ui/EmailView.js";
import { EmptyState } from "../ui/EmptyState.js";

const STATUS_FILTERS: Array<[string, (s: MessageStatus) => boolean]> = [
  ["All", () => true],
  ["Delivered", (s) => s === "delivered" || s === "read"],
  ["Received", (s) => s === "received"],
  ["Failed", (s) => s === "failed" || s === "failover"],
  ["Not sent", (s) => s === "not_sent"],
];

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
  const all = q.data?.data ?? [];
  const channels = useMemo(() => {
    const base: Channel[] = ["whatsapp", "rcs", "email"];
    return all.some((m) => m.channel === "sms") ? [...base, "sms" as Channel] : base;
  }, [all]);
  const statusTest = STATUS_FILTERS.find(([n]) => n === status)?.[1] ?? (() => true);
  const rows = all.filter((m) => (!channel || m.channel === channel) && statusTest(m.status));
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
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
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <EmptyState title="No messages">Try another filter.</EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Channel</th>
                <th className="hide-m">Load</th>
                <th className="hide-m">Party</th>
                <th>What</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                return (
                  <tr key={m.id} onClick={() => setOpen(m)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(m)}>
                    <td className="ts">{clock(m.at, tzOf(m.loadId))}</td>
                    <td><ChannelBadge channel={m.channel} /></td>
                    <td className="id hide-m">{m.loadId}</td>
                    <td className="hide-m">{m.direction === "in" ? "from " : "to "}{m.party}</td>
                    <td className="what">{purposeWords(m)}{m.synthetic ? <span className="small hide-m"> · test</span> : null}</td>
                    <td><StatusPill status={m.status} /></td>
                  </tr>
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
      <ConversationView messages={d.messages} timeZone={d.timeZone} party={msg?.party === "dispatcher" ? "dispatcher" : "driver"} upTo={Date.parse(row.at)} />
      <p style={{ marginTop: 14 }}>
        <Link className="btn small" to={`/loads/${d.summary.id}/conversation`}>Open load {d.summary.id}</Link>
      </p>
    </>
  );
}
