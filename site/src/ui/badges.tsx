import type { Channel, MessageStatus, Source } from "../model/model.js";
import { IconCheck, IconClose, IconEmail, IconRcs, IconSms, IconWhatsApp } from "./icons.js";

// ProvenanceBadge: where the data on screen came from. Always visible, never a paragraph.
export function ProvenanceBadge({ kind, label, title }: { kind: Source | "computed" | "test" | "recorded"; label?: string; title?: string }) {
  const text = label ?? { live: "Live", fixture: "Recorded", replay: "Replay", computed: "Computed", test: "Test", recorded: "Recorded" }[kind];
  return (
    <span className={`badge ${kind}`} title={title ?? TITLES[kind]}>
      {kind === "live" && <i aria-hidden="true" />}
      {text}
    </span>
  );
}

// The page's data source. While the live API is failing, the recorded copy says so and that live
// is being retried.
export function SourceBadge({ data }: { data: { source: Source; fallback?: boolean } }) {
  if (!data.fallback) return <ProvenanceBadge kind={data.source} />;
  const base = data.source === "fixture" ? "Recorded" : data.source === "replay" ? "Replay" : "Live";
  return <ProvenanceBadge kind={data.source} label={`${base} ∙ reconnecting`} title="The live API did not answer. Showing recorded data and trying live again." />;
}

const TITLES: Record<string, string> = {
  live: "Read from the live API, refreshed every few seconds",
  fixture: "Responses recorded from the read API for these demo loads",
  replay: "A recorded load, replayed from its stored records",
  computed: "Computed in your browser; nothing is sent",
  test: "A test load: some inputs were replayed test messages",
  recorded: "A recorded run",
};

const CHANNEL_NAMES: Record<Channel, string> = { whatsapp: "WhatsApp", rcs: "RCS", email: "Email", sms: "SMS" };

export function channelName(c: Channel): string {
  return CHANNEL_NAMES[c];
}

export function ChannelIcon({ channel }: { channel: Channel }) {
  if (channel === "whatsapp") return <IconWhatsApp />;
  if (channel === "rcs") return <IconRcs />;
  if (channel === "email") return <IconEmail />;
  return <IconSms />;
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  return (
    <span className="chan">
      <ChannelIcon channel={channel} />
      <span className="cn">{CHANNEL_NAMES[channel]}</span>
    </span>
  );
}

const STATUS_WORDS: Record<MessageStatus, string> = {
  accepted: "accepted",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  failover: "failover",
  received: "received",
  not_sent: "not sent",
};

export function StatusPill({ status }: { status: MessageStatus }) {
  return (
    <span className={`pill ${status}`}>
      <i aria-hidden="true" />
      {STATUS_WORDS[status]}
    </span>
  );
}

export type VerdictValue = "BILLABLE" | "NOT_BILLABLE" | "NEEDS_HUMAN" | null;

const VERDICT_WORDS: Record<"BILLABLE" | "NOT_BILLABLE" | "NEEDS_HUMAN" | "OPEN", [string, string]> = {
  BILLABLE: ["Owed", "v-owed"],
  NOT_BILLABLE: ["Not owed", "v-notowed"],
  NEEDS_HUMAN: ["Review", "v-review"],
  OPEN: ["Open", "v-open"],
};

// Verdict: the contract's answer as a dock-door sign. A sign-black plate with a dock light (green
// owed, red not owed, an unlit ring for review, a dashed ring while open) and the word. With
// `amountUsd` an owed verdict carries the money on a safety-yellow panel, the one place yellow
// means money. The word is always text, so colour never carries the meaning alone.
export function Verdict({ verdict, amountUsd, large }: { verdict: VerdictValue; amountUsd?: number | null | undefined; large?: boolean }) {
  const [text, cls] = VERDICT_WORDS[verdict ?? "OPEN"];
  const money = verdict === "BILLABLE" && typeof amountUsd === "number";
  return (
    <span className={`verdict ${cls} ${large ? "lg" : ""}`}>
      <span className="plate">
        <i className="light" aria-hidden="true" />
        {text}
      </span>
      {money && <span className="amount">{`$${amountUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span>}
    </span>
  );
}

// Mark: the console's own pass/fail tick, drawn in the icon stroke instead of a font glyph.
export function Mark({ ok }: { ok: boolean }) {
  return <span className={`mark ${ok ? "ok" : "no"}`} aria-hidden="true">{ok ? <IconCheck /> : <IconClose />}</span>;
}
