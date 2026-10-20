// The console read API (site/src/api.ts, dockclock.api/1), served through the desk's CloudFront
// distribution at /api/* from a Lambda function URL. Read only, demo workspace only, and fail
// closed: every JSON response is checked with findLeaks before it leaves, and a response that fails
// is replaced by a 500 (the findings are logged by path, never by value).
import { registerFacility, type Facility } from "@dockclock/evidence";
import { findLeaks, stripImageMetadata } from "@dockclock/sanitize";
import type { ApiError, ApiResponse, LoadsPage } from "../../site/src/api.js";
import { feedOf, overviewOf, type FeedFilters } from "./feed.js";
import { listWorkspace, partition, photoBytes, sourcesFor } from "./store.js";
import { buildLoadView, emailViewOf, packInfoOf, summaryOf } from "./view.js";
import { obj, str } from "./describe.js";

export interface HttpEvent {
  rawPath: string;
  rawQueryString?: string;
  requestContext?: { http?: { method?: string } };
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

// The private demo yard, so its pins can be checked; it is never part of a response.
if (process.env.DEMO_FACILITY) registerFacility(JSON.parse(process.env.DEMO_FACILITY) as Facility);

const SCHEMA = "dockclock.api/1" as const;
const LOAD_ID = /^[A-Za-z0-9-]{1,40}$/;
// The overview and the message feed look at the most recent loads only.
const WINDOW_LOADS = 50;
const CACHE = "public, max-age=3, s-maxage=3";

class HttpError extends Error {
  constructor(
    readonly status: ApiError["error"]["status"],
    readonly code: ApiError["error"]["code"],
    message: string,
  ) {
    super(message);
  }
}

const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found in the demo workspace`);

function json(status: number, body: unknown): HttpResult {
  return { statusCode: status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": CACHE, "x-content-type-options": "nosniff" }, body: JSON.stringify(body) };
}

function errorBody(status: ApiError["error"]["status"], code: ApiError["error"]["code"], message: string): ApiError {
  return { schema: SCHEMA, error: { status, code, message } };
}

function envelope<T>(data: T, pollMs: number | null, now: string): ApiResponse<T> {
  return { schema: SCHEMA, generatedAt: now, workspace: "demo", pollMs, data };
}

function spki(): string {
  return process.env.EVIDENCE_SPKI_SHA256 ?? "";
}

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, "bad_request", `${name} must be a whole number from 1 to ${max}`);
  return n;
}

function decodeCursor<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "bad_request", "cursor is not valid");
  }
}

async function loadItems(loadId: string) {
  if (!LOAD_ID.test(loadId)) throw notFound(`load ${loadId.slice(0, 40)}`);
  const items = await partition(loadId);
  if (!items) throw notFound(`load ${loadId}`);
  return items;
}

async function recentViews(now: string) {
  const { metas } = await listWorkspace(WINDOW_LOADS, null);
  const views = [];
  for (const meta of metas) {
    const items = await partition(String(meta.loadId));
    if (items) views.push(buildLoadView(await sourcesFor(items, { light: true, now, spkiSha256: spki() })));
  }
  return views;
}

const CHANNELS = ["whatsapp", "rcs", "sms", "email"];
const STATUSES = ["accepted", "sent", "delivered", "read", "failed", "received", "bounced", "not_sent"];

async function route(path: string, params: URLSearchParams, now: string): Promise<HttpResult> {
  const parts = path.replace(/\/+$/, "").split("/").slice(2); // after "/api"
  if (parts.length === 1 && parts[0] === "overview") {
    const views = await recentViews(now);
    return json(200, envelope(overviewOf(views, now), 3000, now));
  }
  if (parts.length === 1 && parts[0] === "loads") {
    const limit = intParam(params, "limit", 25, 100);
    const { metas, next } = await listWorkspace(limit, decodeCursor(params.get("cursor")));
    const loads = [];
    for (const meta of metas) {
      const items = await partition(String(meta.loadId));
      if (items) loads.push(summaryOf(items));
    }
    const page: LoadsPage = { loads, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null };
    return json(200, envelope(page, loads.some((l) => l.live) ? 3000 : null, now));
  }
  if (parts.length === 1 && parts[0] === "messages") {
    const filters: FeedFilters = {};
    const channel = params.get("channel");
    const status = params.get("status");
    const direction = params.get("direction");
    const loadId = params.get("loadId");
    if (channel !== null) {
      if (!CHANNELS.includes(channel)) throw new HttpError(400, "bad_request", "channel must be whatsapp, rcs, sms or email");
      filters.channel = channel as FeedFilters["channel"] & string;
    }
    if (status !== null) {
      if (!STATUSES.includes(status)) throw new HttpError(400, "bad_request", "status is not a message status");
      filters.status = status as FeedFilters["status"] & string;
    }
    if (direction !== null) {
      if (direction !== "in" && direction !== "out") throw new HttpError(400, "bad_request", "direction must be in or out");
      filters.direction = direction;
    }
    if (loadId !== null) {
      if (!LOAD_ID.test(loadId)) throw new HttpError(400, "bad_request", "loadId is not valid");
      filters.loadId = loadId;
    }
    const views = filters.loadId ? [buildLoadView(await sourcesFor(await loadItems(filters.loadId), { light: true, now, spkiSha256: spki() }))] : await recentViews(now);
    const feed = feedOf(views, filters, intParam(params, "limit", 50, 200), decodeCursor(params.get("cursor")));
    return json(200, envelope(feed, 3000, now));
  }
  if (parts[0] === "loads" && parts[1]) {
    const items = await loadItems(parts[1]);
    if (parts.length === 2) {
      const view = buildLoadView(await sourcesFor(items, { now, spkiSha256: spki() }));
      return json(200, envelope(view, view.summary.live ? 3000 : null, now));
    }
    if (parts.length === 3 && parts[2] === "pack") {
      const sources = await sourcesFor(items, { now, spkiSha256: spki() });
      if (!sources.signedPack) throw notFound(`a sealed pack for load ${parts[1]}`);
      return json(200, envelope(packInfoOf(sources.signedPack, spki()), null, now));
    }
    if (parts.length === 4 && parts[2] === "emails") {
      const email = emailViewOf(await sourcesFor(items, { now, spkiSha256: spki() }), parts[3]!);
      if (!email) throw notFound(`email ${parts[3]!.slice(0, 40)} of load ${parts[1]}`);
      return json(200, envelope(email, null, now));
    }
    if (parts.length === 4 && parts[2] === "photos") {
      const page = Number(parts[3]);
      if (!Number.isInteger(page) || page < 1 || page > 20) throw notFound("that photo");
      const bytes = await photoBytes(items, page);
      if (!bytes) throw notFound(`photo ${page} of load ${parts[1]}`);
      const stripped = stripImageMetadata(bytes);
      if (!stripped) throw new HttpError(415, "unsupported_media", `photo ${page} of load ${parts[1]} is not a JPEG or PNG image`);
      const meta = items.find((i) => i.sk === "META");
      const photo = obj((obj(meta?.bol).photos as unknown[] | undefined)?.[page - 1]);
      return {
        statusCode: 200,
        headers: {
          "content-type": stripped.type,
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
          // The stored original's hash, the one in the signed pack. These bytes have their metadata
          // removed, so they hash differently.
          "x-dockclock-original-sha256": str(photo.sha256) ?? "unknown",
          "x-dockclock-served-bytes": "metadata-stripped",
        },
        body: Buffer.from(stripped.bytes).toString("base64"),
        isBase64Encoded: true,
      };
    }
  }
  throw new HttpError(404, "not_found", "no such route");
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const now = new Date().toISOString();
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  if (method !== "GET" && method !== "HEAD") return json(400, errorBody(400, "bad_request", "the API is read only"));
  if (!path.startsWith("/api/")) return json(404, errorBody(404, "not_found", "no such route"));
  let result: HttpResult;
  try {
    result = await route(path, new URLSearchParams(event.rawQueryString ?? ""), now);
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, errorBody(error.status, error.code, error.message));
    console.log(JSON.stringify({ kind: "api_error", path, error: (error as Error).name, message: (error as Error).message.slice(0, 300) }));
    return json(500, errorBody(500, "internal", "the API could not read this"));
  }
  if (result.isBase64Encoded) return result;
  const leaks = findLeaks(JSON.parse(result.body), process.env.ACCOUNT_ID);
  if (leaks.length) {
    console.log(JSON.stringify({ kind: "api_leak_blocked", path, findings: leaks.length, at: leaks.slice(0, 10).map((l) => l.replace(/^.* at /, "")) }));
    return json(500, errorBody(500, "internal", "the response failed its sanitization check and was not sent"));
  }
  return result;
}
