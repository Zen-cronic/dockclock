import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { claimAutoReload, ErrorBoundary, isChunkLoadError, PageError, pathChanged, RELOAD_GAP_MS } from "../src/ui/ErrorBoundary.js";

// A memory sessionStorage, or one that throws as a locked-down browser's does.
function store(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
const broken: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
};

describe("the console's error boundary", () => {
  it("knows a failed chunk import in each browser's words", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/AppShell-abc.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });

  it("reloads on its own once, not again soon after, so it cannot loop", () => {
    const s = store();
    const t = 1_700_000_000_000;
    expect(claimAutoReload(s, t)).toBe(true);
    expect(claimAutoReload(s, t + 5_000)).toBe(false);
    expect(claimAutoReload(s, t + RELOAD_GAP_MS + 1)).toBe(true);
  });

  it("never reloads on its own without a working sessionStorage", () => {
    expect(claimAutoReload(null, Date.now())).toBe(false);
    expect(claimAutoReload(broken, Date.now())).toBe(false);
  });

  it("shows a short message and a Reload button", () => {
    const html = renderToStaticMarkup(createElement(PageError, { chunk: true }));
    expect(html).toContain("This page did not load");
    expect(html).toContain("DockClock was updated while this tab was open.");
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
  });

  // React.lazy keeps a failed import's rejection: after a chunk failure only a full page load of the
  // new path can load it, while any other error clears and the new route draws in place.
  it("loads the new path in full after a failed chunk, and redraws in place after any other error", () => {
    const chunk = new TypeError("Failed to fetch dynamically imported module: https://x/assets/Judges-abc.js");
    expect(pathChanged(null)).toBe("none");
    expect(pathChanged(chunk)).toBe("load");
    expect(pathChanged(new TypeError("Cannot read properties of undefined"))).toBe("redraw");

    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    try {
      const moved = (error: unknown) => {
        const boundary = new ErrorBoundary({ children: null, resetKey: "/judges" });
        boundary.state = { error };
        const setState = vi.spyOn(boundary, "setState").mockImplementation(() => undefined);
        boundary.componentDidUpdate({ children: null, resetKey: "/loads" });
        return setState;
      };
      expect(moved(chunk)).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(moved(new Error("draw failed"))).toHaveBeenCalledWith({ error: null });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
