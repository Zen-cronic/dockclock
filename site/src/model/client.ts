// The console's data client. One place decides where data comes from:
//   live:    the read API at /api (polled on live views)
//   fixture: the API contract's fixture files, for development and screenshots
//   replay:  the sanitized replay snapshots bundled with the page; the fallback whenever /api fails
// Screens never fetch directly; they use the hooks below and show the returned `source` as a badge.
import { useQuery } from "@tanstack/react-query";
import type { ReplaySnapshot } from "../snapshot.js";
import { detailFromReplay, feedFromDetails, overviewFromDetails } from "./fromReplay.js";
import type { ConsoleMessage, LoadDetail, LoadSummary, Overview, Source } from "./model.js";

const replayModules = import.meta.glob<ReplaySnapshot>("../../replay/*.json", { eager: true, import: "default" });
const replays: ReplaySnapshot[] = Object.values(replayModules).sort((a, b) => (b.clock.arrivedAt ?? "").localeCompare(a.clock.arrivedAt ?? ""));

export const FEATURED_LOAD = "SMOKE-mvh1bmmu";
export const POLL_MS = 3000;

function replayDetails(): LoadDetail[] {
  return replays.map((s) => detailFromReplay(s, "replay"));
}

// Live API adapters are added once site/src/api.ts is published; until then every hook resolves
// from the bundled replays and reports source "replay".
async function fromSource<T>(replay: () => T): Promise<{ data: T; source: Source }> {
  return { data: replay(), source: "replay" };
}

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => fromSource<Overview>(() => overviewFromDetails(replayDetails(), "replay")),
    refetchInterval: POLL_MS,
  });
}

export function useLoads() {
  return useQuery({
    queryKey: ["loads"],
    queryFn: () => fromSource<LoadSummary[]>(() => replayDetails().map((d) => d.summary)),
    refetchInterval: POLL_MS,
  });
}

export function useLoad(id: string | undefined) {
  return useQuery({
    queryKey: ["load", id],
    enabled: Boolean(id),
    queryFn: () =>
      fromSource<LoadDetail | null>(() => replayDetails().find((d) => d.summary.id === id) ?? null),
    refetchInterval: POLL_MS,
  });
}

export function useMessages() {
  return useQuery({
    queryKey: ["messages"],
    queryFn: () => fromSource<ConsoleMessage[]>(() => feedFromDetails(replayDetails())),
    refetchInterval: POLL_MS,
  });
}

export function allReplayDetails(): LoadDetail[] {
  return replayDetails();
}
