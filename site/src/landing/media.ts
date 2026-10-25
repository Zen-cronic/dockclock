import { useEffect, useState } from "react";

// A media query as state, e.g. reduced motion or a phone-width screen. `fallback` applies where
// there is no window (static rendering in tests).
export function useMedia(query: string, fallback: boolean): boolean {
  const [hit, setHit] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : fallback));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const q = window.matchMedia(query);
    const on = () => setHit(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [query]);
  return hit;
}
