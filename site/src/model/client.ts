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
import { ApiFetchError, failureOf, ONE_SHOT_RETRIES, oneShotDelay, POLL_MS, refetchMs, withFallback, type Sourced } from "./fetching.js";

const replayModules = import.meta.glob<ReplaySnapshot>("../../replay/*.json", { eager: true, import: "default" });
const replays: ReplaySnapshot[] = Object.values(replayModules).sort((a, b) => (b.clock.arrivedAt ?? "").localeCompare(a.clock.arrivedAt ?? ""));
const fixtureModules = import.meta.glob<unknown>("../../fixtures/api/**/*.json", { eager: true, import: "default" });
const fixturePhotos = import.meta.glob<string>("../../fixtures/api/photos/*", { eager: true, query: "?url", import: "default" });

export const FEATURED_LOAD = FEATURED.whatsapp;
export const FEATURED_RCS_LOAD = FEATURED.rcs;
export { POLL_MS };

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

// In-progress captures of a load, recorded from the read API while it ran
// (site/fixtures/api/loads/live/<id>.<status>.json), oldest first.
export interface Capture {
  status: string;
  asOf: string;
  detail: LoadDetail;
}

export function recordedCaptures(loadId: string): Capture[] {
  const out: Capture[] = [];
  for (const [key, value] of Object.entries(fixtureModules)) {
    const m = new RegExp(`/loads/live/${loadId.replace(/[^A-Za-z0-9-]/g, "")}\\.([a-z_]+)\\.json$`).exec(key);
    if (!m) continue;
    const r = value as Api.ApiResponse<Api.LoadView>;
    if (!r.data) continue;
    out.push({ status: m[1]!, asOf: r.data.clock.asOf, detail: detailFromApi(r.data, "fixture", fixturePhotoUrl) });
  }
  return out.sort((a, b) => a.asOf.localeCompare(b.asOf));
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
    let res: Response;
    try {
      res = await fetch(path, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new ApiFetchError("unavailable", null, `${path}: ${(error as Error).message}`);
    }
    // Not the API's JSON (a CloudFront error page, a proxy): live did not answer.
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) throw new ApiFetchError("unavailable", res.status, `${path}: HTTP ${res.status}`);
    try {
      body = (await res.json()) as Api.ApiResponse<T> | Api.ApiError;
    } catch {
      throw new ApiFetchError("unavailable", res.status, `${path}: unreadable JSON`);
    }
  }
  if ("error" in body) throw failureOf(body.error.status, body.error.message);
  if (body.schema !== "dockclock.api/1") throw new ApiFetchError("unavailable", null, `${path}: unexpected schema`);
  return body;
}

export type { Sourced } from "./fetching.js";

// Live failures in a row, by path, for the backoff.
const liveFailures = new Map<string, number>();

// Fetch from the chosen source. When /api fails, fall back to the recorded API responses in
// site/fixtures/api (badged RECORDED), then to the bundled replays (badged REPLAY), and keep
// asking live (with backoff) until it answers again. A real 404 is not retried.
async function load<A, T, R = T>(path: string, fromApi: (r: Api.ApiResponse<A>, s: Source) => T, fromReplay: () => R): Promise<Sourced<T | R>> {
  const m = mode();
  const out = await withFallback<T, R>({
    live:
      m === "live"
        ? async () => {
            const r = await get<A>(path, "live");
            return { data: fromApi(r, "live"), pollMs: r.pollMs };
          }
        : null,
    fixture: m === "replay" ? null : async () => fromApi(await get<A>(path, "fixtures"), "fixture"),
    replay: fromReplay,
    failuresBefore: liveFailures.get(path) ?? 0,
    // Say why in the console for whoever is debugging.
    warn: (message) => console.warn(`DockClock: ${path}: ${message}`),
  });
  liveFailures.set(path, out.liveFailures);
  return out;
}

const replayDetails = (): LoadDetail[] => replays.map((s) => detailFromReplay(s, "replay"));
const poll = (q: { state: { data?: Sourced<unknown> | undefined } }) => refetchMs(q.state.data);

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => load<Api.Overview, Overview>("/api/overview", (r, s) => overviewFromApi(r.data, s, r.generatedAt), () => overviewFromDetails(replayDetails(), "replay")),
    refetchInterval: poll,
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
    refetchInterval: poll,
  });
}

export function useLoad(id: string | undefined) {
  return useQuery({
    queryKey: ["load", id],
    enabled: Boolean(id),
    queryFn: () =>
      load<Api.LoadView, LoadDetail, LoadDetail | null>(
        `/api/loads/${encodeURIComponent(id ?? "")}`,
        (r, s) => detailFromApi(r.data, s, s === "fixture" ? fixturePhotoUrl : (u) => u),
        () => replayDetails().find((d) => d.summary.id === id) ?? null,
      ),
    // A finished load stops polling; a load shown in place of a failing live API keeps retrying.
    refetchInterval: (q) => refetchMs(q.state.data, { onlyWhilePolling: true }),
  });
}

export function useMessages() {
  return useQuery({
    queryKey: ["messages"],
    queryFn: () => load<Api.MessageFeed, FeedRow[]>("/api/messages?limit=200", (r) => feedFromApi(r.data), () => feedFromDetails(replayDetails())),
    refetchInterval: poll,
  });
}

// The full signed pack: with the load for replays, otherwise from /api/loads/:id/pack, then the
// recorded response, then the bundled replay of the same load. It is immutable once sealed, so a
// copy from any source is the same bytes. When none has it the query fails (and retries), and the
// page offers Retry instead of "Checking" forever.
export function usePack(load: LoadDetail | null | undefined) {
  return useQuery({
    queryKey: ["pack", load?.summary.id, load?.packSummary?.packId],
    enabled: Boolean(load?.packSummary),
    queryFn: async (): Promise<SignedPackInfo | null> => {
      if (!load) return null;
      if (load.pack) return load.pack;
      const id = load.summary.id;
      const path = `/api/loads/${encodeURIComponent(id)}/pack`;
      const m = mode();
      const out = await withFallback<SignedPackInfo, SignedPackInfo | null>({
        live: m === "live" ? async () => ({ data: (await get<SignedPackInfo>(path, "live")).data, pollMs: null }) : null,
        fixture: m === "replay" ? null : async () => (await get<SignedPackInfo>(path, "fixtures")).data,
        replay: () => replays.find((r) => r.load.loadId === id)?.pack ?? null,
        failuresBefore: 0,
        warn: (message) => console.warn(`DockClock: ${path}: ${message}`),
      });
      if (!out.data) throw new Error("Couldn't load the pack");
      return out.data;
    },
    retry: ONE_SHOT_RETRIES,
    retryDelay: oneShotDelay,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// An email's body: with the load for replays, otherwise from /api/loads/:id/emails/:emailId, then
// the recorded response. When neither answers the query fails (and retries), and the page offers
// Retry rather than saying the body was not stored.
export function useEmailBody(load: LoadDetail | null | undefined, email: ConsoleEmail | null) {
  return useQuery({
    queryKey: ["email", email?.id],
    enabled: Boolean(load && email),
    queryFn: async (): Promise<{ body: string | null; note: string }> => {
      if (!load || !email) return { body: null, note: "" };
      if (email.body !== undefined || load.summary.source === "replay") return { body: email.body ?? null, note: email.body ? "" : "Body not stored for this load." };
      const localId = email.id.split(":").pop() ?? email.id;
      const path = `/api/loads/${encodeURIComponent(load.summary.id)}/emails/${encodeURIComponent(localId)}`;
      const m = mode();
      const out = await withFallback<Api.EmailView, null>({
        live: m === "live" ? async () => ({ data: (await get<Api.EmailView>(path, "live")).data, pollMs: null }) : null,
        fixture: m === "replay" ? null : async () => (await get<Api.EmailView>(path, "fixtures")).data,
        replay: () => null,
        failuresBefore: 0,
        warn: (message) => console.warn(`DockClock: ${path}: ${message}`),
      });
      if (!out.data) throw new Error("Couldn't load the email");
      return { body: out.data.body, note: out.data.bodyNote };
    },
    retry: ONE_SHOT_RETRIES,
    retryDelay: oneShotDelay,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
