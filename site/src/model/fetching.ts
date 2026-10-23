// How the console falls back when the live API fails, kept free of React and Vite so the site
// tests can run it. A real 404 is an answer (the load is not in the demo workspace); a 5xx, a 429
// or a network failure is not, so the page shows recorded data, keeps the fallback badge up and
// tries live again with backoff until it answers.
import type { Source } from "./model.js";

export const POLL_MS = 3000;
export const MAX_BACKOFF_MS = 30_000;

export type LiveFailure = "not_found" | "unavailable";

export class ApiFetchError extends Error {
  constructor(
    readonly kind: LiveFailure,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

// 404 is the API's "not in the demo workspace"; everything else (5xx, 429, 400, a CloudFront
// error page, no network) means the live answer is not known yet.
export function failureKind(error: unknown): LiveFailure {
  return error instanceof ApiFetchError ? error.kind : "unavailable";
}

export function failureOf(status: number, message: string): ApiFetchError {
  return new ApiFetchError(status === 404 ? "not_found" : "unavailable", status, message);
}

// 3 s, 6 s, 12 s, 24 s, then every 30 s.
export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.max(0, failures - 1));
}

export interface Sourced<T> {
  data: T;
  source: Source;
  pollMs: number | null;
  // True while live is failing and a recorded copy (or nothing) is shown in its place.
  fallback: boolean;
  // Why live did not answer, when it did not.
  liveError: LiveFailure | null;
  // Live failures in a row, for the backoff.
  liveFailures: number;
}

export interface Attempts<T, R> {
  // Null when live is not tried (the fixtures or replay data mode).
  live: (() => Promise<{ data: T; pollMs: number | null }>) | null;
  fixture: (() => T | Promise<T>) | null;
  replay: () => R;
  // Live failures in a row before this attempt.
  failuresBefore: number;
  warn?: (message: string) => void;
}

// Live, then the recorded API responses, then the bundled replays. Never throws: when nothing has
// the data, `data` is whatever the replay gives (null for an unknown load) and liveError says
// whether live said 404 or did not answer.
export async function withFallback<T, R = T>(a: Attempts<T, R>): Promise<Sourced<T | R>> {
  let liveError: LiveFailure | null = null;
  let liveFailures = 0;
  if (a.live) {
    try {
      const r = await a.live();
      return { data: r.data, source: "live", pollMs: r.pollMs, fallback: false, liveError: null, liveFailures: 0 };
    } catch (error) {
      liveError = failureKind(error);
      liveFailures = liveError === "unavailable" ? a.failuresBefore + 1 : 0;
      a.warn?.(`live unavailable (${(error as Error).message})`);
    }
  }
  const fallback = liveError === "unavailable";
  if (a.fixture) {
    try {
      return { data: await a.fixture(), source: "fixture", pollMs: null, fallback, liveError, liveFailures };
    } catch (error) {
      a.warn?.(`fixture unavailable (${(error as Error).message})`);
    }
  }
  return { data: a.replay(), source: "replay", pollMs: null, fallback, liveError, liveFailures };
}

// When to ask again: every 3 s on live data the API says can still change, with backoff while
// live is failing, and never on final or recorded data.
export function refetchMs(data: Pick<Sourced<unknown>, "source" | "fallback" | "liveFailures" | "pollMs"> | undefined, options: { onlyWhilePolling?: boolean } = {}): number | false {
  if (!data) return false;
  if (data.fallback) return backoffMs(data.liveFailures);
  if (data.source !== "live") return false;
  if (options.onlyWhilePolling && !data.pollMs) return false;
  return POLL_MS;
}

// Retries of a one-shot read (a pack, an email body) after it failed everywhere.
export const ONE_SHOT_RETRIES = 3;
export const oneShotDelay = (attempt: number) => backoffMs(attempt + 1);
