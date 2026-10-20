// The console's data client. One place decides where data comes from:
//   live:    the read API at /api, polled every 3 s on live views
//   fixture: the API contract's example responses in site/fixtures/api/ (development, screenshots)
//   replay:  the sanitized replay snapshots bundled with the page, the fallback whenever /api fails
// Pick with ?data=live|fixtures|replay (remembered for the session) or VITE_DATA; the default is
// live with replay fallback. Every hook returns { data, source } and screens show the source.
import { useQuery } from "@tanstack/react-query";
import type * as Api from "../api.js";
import type { ReplaySnapshot, SignedPackInfo } from "../snapshot.js";
import { detailFromApi, feedFromApi, overviewFromApi, summaryFromApi } from "./fromApi.js";
import { detailFromReplay, feedFromDetails, overviewFromDetails } from "./fromReplay.js";
import type { ConsoleEmail, FeedRow, LoadDetail, LoadSummary, Overview, Source } from "./model.js";
import { FEATURED } from "../featured.js";

const replayModules = import.meta.glob<ReplaySnapshot>("../../replay/*.json", { eager: true, import: "default" });
const replays: ReplaySnapshot[] = Object.values(replayModules).sort((a, b) => (b.clock.arrivedAt ?? "").localeCompare(a.clock.arrivedAt ?? ""));
const fixtureModules = import.meta.glob<unknown>("../../fixtures/api/**/*.json", { eager: true, import: "default" });
const fixturePhotos = import.meta.glob<string>("../../fixtures/api/photos/*", { eager: true, query: "?url", import: "default" });

export const FEATURED_LOAD = FEATURED.whatsapp;
export const FEATURED_RCS_LOAD = FEATURED.rcs;
export const POLL_MS = 3000;

type Mode = "live" | "fixtures" | "replay";

function mode(): Mode {
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("data");
  if (fromUrl === "live" || fromUrl === "fixtures" || fromUrl === "replay") {
    try {
      sessionStorage.setItem("dockclock.data", fromUrl);
    } catch {
      /* private mode: use it for this page only */
    }
    return fromUrl;
  }
  try {
    const kept = sessionStorage.getItem("dockclock.data");
    if (kept === "live" || kept === "fixtures" || kept === "replay") return kept;
  } catch {
    /* ignore */
  }
  const env = import.meta.env.VITE_DATA as string | undefined;
  return env === "fixtures" || env === "replay" ? env : "live";
}

// Fixture lookup by API path: tries the likely file layouts under site/fixtures/api/.
function fixtureFor(path: string): unknown {
  const [route = "", query = ""] = path.replace(/^\/api\//, "").split("?");
  const channel = new URLSearchParams(query).get("channel");
  // site/fixtures/api layout: overview, loads, messages[.channel], loads/<id>[.pack|.emails.<id>]
  const names = [
    channel ? `${route}.${channel}` : route,
    route.replace(/^loads\/([^/]+)\/(.+)$/, (_m, id: string, rest: string) => `loads/${id}.${rest.replace(/\//g, ".")}`),
  ];
  for (const [key, value] of Object.entries(fixtureModules)) {
    const rel = key.replace(/^.*fixtures\/api\//, "").replace(/\.json$/, "");
    if (names.includes(rel)) return value;
  }
  throw new Error(`no fixture for ${path}`);
}

// Whether a load's full record is available from the recorded responses (some loads are listed
// with a summary only).
export function hasRecordedDetail(loadId: string): boolean {
  return Object.keys(fixtureModules).some((k) => k.endsWith(`/loads/${loadId}.json`));
}

function fixturePhotoUrl(u: string): string {
  const name = u.split("/").pop() ?? u;
  const hit = Object.entries(fixturePhotos).find(([k]) => k.endsWith(`/${name}`));
  return hit ? hit[1] : u;
}

async function get<T>(path: string, m: Mode): Promise<Api.ApiResponse<T>> {
  let body: Api.ApiResponse<T> | Api.ApiError;
  if (m === "fixtures") body = fixtureFor(path) as Api.ApiResponse<T> | Api.ApiError;
  else {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) throw new Error(`${path}: HTTP ${res.status}`);
    body = (await res.json()) as Api.ApiResponse<T> | Api.ApiError;
  }
  if ("error" in body) throw new Error(body.error.message);
  if (body.schema !== "dockclock.api/1") throw new Error(`${path}: unexpected schema`);
  return body;
}

export interface Sourced<T> {
  data: T;
  source: Source;
  pollMs: number | null;
}

// Fetch from the chosen source. When /api is unreachable, fall back to the recorded API responses
// in site/fixtures/api (badged RECORDED), then to the bundled replays (badged REPLAY).
async function load<A, T>(path: string, fromApi: (r: Api.ApiResponse<A>, s: Source) => T, fromReplay: () => T): Promise<Sourced<T>> {
  const m = mode();
  const order: Mode[] = m === "live" ? ["live", "fixtures"] : m === "fixtures" ? ["fixtures"] : [];
  for (const source of order) {
    try {
      const r = await get<A>(path, source);
      const s: Source = source === "fixtures" ? "fixture" : "live";
      return { data: fromApi(r, s), source: s, pollMs: source === "live" ? r.pollMs : null };
    } catch (error) {
      // Say why in the console for whoever is debugging, then try the next source.
      console.warn(`DockClock: ${path} from ${source} unavailable (${(error as Error).message})`);
    }
  }
  return { data: fromReplay(), source: "replay", pollMs: null };
}

const replayDetails = (): LoadDetail[] => replays.map((s) => detailFromReplay(s, "replay"));
const livePoll = (q: { state: { data?: { source: Source } | undefined } }) => (q.state.data?.source === "live" ? POLL_MS : false);

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => load<Api.Overview, Overview>("/api/overview", (r, s) => overviewFromApi(r.data, s, r.generatedAt), () => overviewFromDetails(replayDetails(), "replay")),
    refetchInterval: livePoll,
  });
}

export type LoadRow = LoadSummary & { timeZone: string; runLabel?: string };

export function useLoads() {
  return useQuery({
    queryKey: ["loads"],
    queryFn: () =>
      load<Api.LoadsPage, LoadRow[]>(
        "/api/loads",
        (r, s) => r.data.loads.map((l) => ({ ...summaryFromApi(l, s), timeZone: l.facility.timeZone, runLabel: l.runLabel })),
        () => replayDetails().map((d) => ({ ...d.summary, timeZone: d.timeZone })),
      ),
    refetchInterval: livePoll,
  });
}

export function useLoad(id: string | undefined) {
  return useQuery({
    queryKey: ["load", id],
    enabled: Boolean(id),
    queryFn: () =>
      load<Api.LoadView, LoadDetail | null>(
        `/api/loads/${encodeURIComponent(id ?? "")}`,
        (r, s) => detailFromApi(r.data, s, s === "fixture" ? fixturePhotoUrl : (u) => u),
        () => replayDetails().find((d) => d.summary.id === id) ?? null,
      ),
    refetchInterval: (q) => (q.state.data?.source === "live" && q.state.data.pollMs ? POLL_MS : false),
  });
}

export function useMessages() {
  return useQuery({
    queryKey: ["messages"],
    queryFn: () => load<Api.MessageFeed, FeedRow[]>("/api/messages?limit=200", (r) => feedFromApi(r.data), () => feedFromDetails(replayDetails())),
    refetchInterval: livePoll,
  });
}

// The full signed pack: with the load for replays, from /api/loads/:id/pack otherwise.
export function usePack(load: LoadDetail | null | undefined) {
  return useQuery({
    queryKey: ["pack", load?.summary.id, load?.packSummary?.packId],
    enabled: Boolean(load?.packSummary),
    queryFn: async (): Promise<SignedPackInfo | null> => {
      if (!load) return null;
      if (load.pack) return load.pack;
      const r = await get<SignedPackInfo>(`/api/loads/${encodeURIComponent(load.summary.id)}/pack`, load.summary.source === "fixture" ? "fixtures" : "live");
      return r.data;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// An email's body: with the load for replays, from /api/loads/:id/emails/:emailId otherwise.
export function useEmailBody(load: LoadDetail | null | undefined, email: ConsoleEmail | null) {
  return useQuery({
    queryKey: ["email", email?.id],
    enabled: Boolean(load && email),
    queryFn: async (): Promise<{ body: string | null; note: string }> => {
      if (!load || !email) return { body: null, note: "" };
      if (email.body !== undefined || load.summary.source === "replay") return { body: email.body ?? null, note: email.body ? "" : "Body not stored for this load." };
      const localId = email.id.split(":").pop() ?? email.id;
      const r = await get<Api.EmailView>(`/api/loads/${encodeURIComponent(load.summary.id)}/emails/${encodeURIComponent(localId)}`, load.summary.source === "fixture" ? "fixtures" : "live");
      return { body: r.data.body, note: r.data.bodyNote };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}
