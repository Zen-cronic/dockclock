import { Component, type ErrorInfo, type ReactNode } from "react";

// The top-level error boundary around every route. The console's chunks load on demand, so a
// redeploy that pruned the old hashed files makes the next dynamic import fail: then the page
// reloads once on its own to fetch the new build. Any other error, or a second failure soon after,
// shows a short message and a Reload button instead of a blank page. React.lazy keeps a failed
// import's rejection, so after a chunk failure no amount of moving between routes loads it again:
// moving elsewhere then loads that page in full (a reload of the new address), while after any
// other error it draws the new route in place.

const RELOAD_KEY = "dockclock:chunk-reload-at";
// A second chunk failure within this long of an automatic reload is not retried on its own.
export const RELOAD_GAP_MS = 60_000;

// A failed dynamic import. Browsers word it differently; Vite adds its own for CSS preloads.
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS/i.test(text);
}

type Store = Pick<Storage, "getItem" | "setItem">;

// True when this failure may reload the page on its own: no automatic reload in the last
// RELOAD_GAP_MS, and the time of this one written down. Without a working sessionStorage nothing
// could stop a reload loop, so the answer is then always no.
export function claimAutoReload(storage: Store | null, now: number): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOAD_KEY) ?? "0");
    if (Number.isFinite(last) && now - last < RELOAD_GAP_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
    return storage.getItem(RELOAD_KEY) === String(now);
  } catch {
    return false;
  }
}

function sessionStore(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

interface Props {
  children: ReactNode;
  // A new value (the path) means the reader moved elsewhere: see pathChanged.
  resetKey?: string;
}

// What moving to a new path does with a shown error: nothing without one, a full page load of the
// new path after a failed chunk (its lazy component would rethrow the cached failure), and a fresh
// draw in place after any other error.
export function pathChanged(error: unknown): "none" | "load" | "redraw" {
  if (error === null) return "none";
  return isChunkLoadError(error) ? "load" : "redraw";
}

export class ErrorBoundary extends Component<Props, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("DockClock console error", error, info.componentStack);
    if (isChunkLoadError(error) && claimAutoReload(sessionStore(), Date.now())) window.location.reload();
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey === this.props.resetKey) return;
    const next = pathChanged(this.state.error);
    if (next === "load") window.location.reload();
    else if (next === "redraw") this.setState({ error: null });
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return <PageError chunk={isChunkLoadError(this.state.error)} />;
  }
}

export function PageError({ chunk }: { chunk: boolean }) {
  return (
    <div className="empty" role="alert">
      <b>This page did not load</b>
      <p>{chunk ? "DockClock was updated while this tab was open." : "Something went wrong while drawing it."} Reloading usually fixes it.</p>
      <button type="button" className="btn primary" style={{ marginTop: 12 }} onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
