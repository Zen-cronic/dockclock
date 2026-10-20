import { useEffect, useRef, type ReactNode } from "react";
import { IconClose } from "./icons.js";

// Drawer: the one place dense detail goes (records, emails, the agent run, raw JSON).
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <div className="dh">
          <h2>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="db">{children}</div>
      </div>
    </>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
