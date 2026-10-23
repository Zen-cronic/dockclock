// Filtering and ordering for the message monitor. Pure, so the tests can pin the order down.
import type { Channel, FeedRow, MessageStatus } from "./model.js";

export const STATUS_FILTERS: Array<[string, (s: MessageStatus) => boolean]> = [
  ["All", () => true],
  ["Delivered", (s) => s === "delivered" || s === "read"],
  ["Received", (s) => s === "received"],
  ["Failed", (s) => s === "failed" || s === "failover"],
  ["Not sent", (s) => s === "not_sent"],
];

// "newest" is the default and is left out of the URL; "oldest" and "load" are written as ?sort=.
export type FeedSort = "newest" | "oldest" | "load";
export const FEED_SORTS: Array<[FeedSort, string]> = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["load", "By load"],
];

export function parseSort(v: string | null): FeedSort {
  return v === "oldest" || v === "load" ? v : "newest";
}

export function filterFeed(rows: FeedRow[], channel: Channel | null, status: string): FeedRow[] {
  const test = STATUS_FILTERS.find(([n]) => n === status)?.[1] ?? (() => true);
  return rows.filter((m) => (!channel || m.channel === channel) && test(m.status));
}

const t = (iso: string) => Date.parse(iso) || 0;

// Date modes are one chronological list. "By load" groups rows under each load id in name
// order, newest message first inside each load.
export function orderFeed(rows: FeedRow[], sort: FeedSort): FeedRow[] {
  const out = [...rows];
  if (sort === "load") return out.sort((a, b) => a.loadId.localeCompare(b.loadId) || t(b.at) - t(a.at) || a.id.localeCompare(b.id));
  const dir = sort === "oldest" ? 1 : -1;
  return out.sort((a, b) => dir * (t(a.at) - t(b.at)) || a.loadId.localeCompare(b.loadId) || a.id.localeCompare(b.id));
}
