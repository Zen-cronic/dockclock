import { useEffect, useState } from "react";
import { clockEndOf, releaseTimeOf } from "@dockclock/clause-engine";
import { clock, dateLong, usd, zoneName } from "../format.js";
import type { Photo } from "../model/model.js";
import type { SignedPackInfo } from "../snapshot.js";
import { verifyPack } from "../verify.js";
import { Mark } from "./badges.js";
import { Drawer, Json } from "./Drawer.js";
import { IconCheck, IconClose } from "./icons.js";

interface PackShape {
  loadId?: string;
  clauseId?: string;
  facility?: { name?: string };
  appointmentAt?: string;
  sealedAt?: string;
  events?: { arrived?: { serverAt?: string }; releasedTap?: { serverAt?: string } | null; released?: { serverAt?: string }; bol?: { cameraOnly?: boolean; pageSha256s?: Array<string | null> } | null; notice?: unknown };
  corroboration?: { confidence?: string; signals?: Array<{ name: string; ok: boolean }> };
  evaluation?: { verdict?: string; billableMinutes?: number; amountUsd?: number };
}

type Tamper = { amount: boolean; release: boolean; check: boolean };
const TAMPERS: Array<[keyof Tamper, string, string]> = [
  ["amount", "Amount", "to $9,999.00"],
  ["release", "Release", "+30 min"],
  ["check", "Failed check", ""],
];

// The Release switch moves the time that stopped the clock: the Released tap on a pack that has one
// (version 2), the release pin on an older pack.
export function tampered(pack: PackShape, t: Tamper): PackShape {
  const p = structuredClone(pack);
  if (t.amount && p.evaluation) p.evaluation.amountUsd = 9999;
  const end = t.release ? clockEndOf(p.events) : null;
  const moved = end ? new Date(Date.parse(end.at) + 30 * 60_000).toISOString() : null;
  if (moved && end?.by === "released_tap" && p.events?.releasedTap) p.events.releasedTap.serverAt = moved;
  else if (moved && p.events?.released) p.events.released.serverAt = moved;
  if (t.check && p.corroboration?.signals) {
    for (const s of p.corroboration.signals) s.ok = true;
    p.corroboration.confidence = "high";
  }
  return p;
}

let keyCache: string | null = null;
async function publicKey(path: string): Promise<string> {
  if (keyCache) return keyCache;
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!res.ok) throw new Error(`public key: HTTP ${res.status}`);
  keyCache = await res.text();
  return keyCache;
}

export function useSignatureCheck(pack: SignedPackInfo | null, mutate?: (p: PackShape) => PackShape) {
  const [state, setState] = useState<{ status: "checking" | "valid" | "invalid" | "error"; digest?: string; error?: string }>({ status: "checking" });
  useEffect(() => {
    let live = true;
    if (!pack) return;
    setState({ status: "checking" });
    const target = mutate ? mutate(pack.pack as PackShape) : pack.pack;
    publicKey(pack.publicKeyPath)
      .then((pem) => verifyPack(target, pack.signatureBase64, pem))
      .then((r) => live && setState({ status: r.valid ? "valid" : "invalid", digest: r.digest }))
      .catch((e: Error) => live && setState({ status: "error", error: e.message }));
    return () => {
      live = false;
    };
  }, [pack, mutate]);
  return state;
}

// EvidencePanel: the signed pack as a canary carbon copy, the in-browser KMS signature check, and
// three switches that change the pack so the check fails.
export function EvidencePanel({ pack, timeZone, photos }: { pack: SignedPackInfo; timeZone: string; photos: Photo[] }) {
  const [t, setT] = useState<Tamper>({ amount: false, release: false, check: false });
  const [raw, setRaw] = useState(false);
  const [mutate, setMutate] = useState<((p: PackShape) => PackShape) | undefined>(undefined);
  useEffect(() => {
    const any = t.amount || t.release || t.check;
    setMutate(() => (any ? (p: PackShape) => tampered(p, t) : undefined));
  }, [t]);
  const check = useSignatureCheck(pack, mutate);
  const orig = pack.pack as PackShape;
  const now = tampered(orig, t);
  const when = (iso?: string) => (iso ? `${clock(iso, timeZone)} ${zoneName(iso, timeZone)}` : "—");
  const row = (label: string, a: string, b: string) => (
    <>
      <span>{label}</span>
      <b className={a !== b ? "changed" : ""}>{b}</b>
    </>
  );
  const signals = (p: PackShape) => `${(p.corroboration?.signals ?? []).filter((s) => s.ok).length} of ${(p.corroboration?.signals ?? []).length}`;
  const diffs: string[] = [];
  if (t.amount) diffs.push(`amount ${usd(orig.evaluation?.amountUsd ?? 0)} → ${usd(9999)}`);
  if (t.release) diffs.push(`${orig.events?.releasedTap?.serverAt ? "Released tap" : "released"} ${when(releaseTimeOf(orig.events) ?? undefined)} → ${when(releaseTimeOf(now.events) ?? undefined)}`);
  if (t.check) diffs.push(`checks ${signals(orig)} → ${signals(now)}`);
  return (
    <div className="grid-2">
      <div>
        <div className="printout">
          
          <h3>Evidence pack</h3>
          <div className="small" style={{ color: "var(--form-ink)", opacity: 0.75 }}>{pack.packId}</div>
          <div className="kv">
            {row("Load", orig.loadId ?? "", now.loadId ?? "")}
            {row("Facility", orig.facility?.name ?? "", now.facility?.name ?? "")}
            {row("Arrived", when(orig.events?.arrived?.serverAt), when(now.events?.arrived?.serverAt))}
            {orig.events?.releasedTap?.serverAt && row("Released tap", when(orig.events.releasedTap.serverAt), when(now.events?.releasedTap?.serverAt))}
            {row(orig.events?.releasedTap?.serverAt ? "Release pin" : "Released", when(orig.events?.released?.serverAt), when(now.events?.released?.serverAt))}
            {row("Checks passed", signals(orig), signals(now))}
            {row("Verdict", orig.evaluation?.verdict ?? "", now.evaluation?.verdict ?? "")}
            {row("Amount", usd(orig.evaluation?.amountUsd ?? 0), usd(now.evaluation?.amountUsd ?? 0))}
            {row("Sealed", orig.sealedAt ? dateLong(orig.sealedAt, timeZone) : "", now.sealedAt ? dateLong(now.sealedAt, timeZone) : "")}
          </div>
        </div>
        <p style={{ marginTop: 10 }}>
          <button className="linkbtn" onClick={() => setRaw(true)}>Raw</button>
        </p>
        {photos.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head"><h2>Bill of lading</h2></div>
            {photos.map((ph) => (
              <div className="card-body photo-ev" key={ph.index}>
                {ph.url ? <img src={ph.url} alt={`Bill of lading page ${ph.index}`} /> : <div className="nophoto" aria-label={ph.note ?? "No image stored"}>{ph.note ?? "—"}</div>}
                <div>
                  {ph.url && <span className="small">{ph.badge}</span>}
                  {ph.reading && (
                    <dl className="kv-list">
                      <dt>Agent read in</dt><dd>{ph.reading.inTime ?? "not legible"}</dd>
                      <dt>Agent read out</dt><dd>{ph.reading.outTime ?? "not legible"}</dd>
                      <dt>Signed</dt><dd>{ph.reading.signed == null ? "—" : ph.reading.signed ? "yes" : "no"}</dd>
                    </dl>
                  )}
                  {ph.legible === false && <p className="small" style={{ marginTop: 8 }}>Not legible: a clearer photo was requested.</p>}
                  {ph.matchesPack != null && <p className={ph.matchesPack ? "ok-text" : "bad-text"} style={{ marginTop: 8 }}><Mark ok={ph.matchesPack} />{ph.matchesPack ? "sha256 matches the pack" : "sha256 differs from the pack"}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card verifycard">
        <div className={`vres ${check.status === "valid" ? "good" : check.status === "invalid" ? "bad" : ""}`} aria-live="polite">
          <span className="ic">{check.status === "valid" ? <IconCheck /> : check.status === "invalid" ? <IconClose /> : "…"}</span>
          <div>
            <b>{check.status === "valid" ? "Signature valid" : check.status === "invalid" ? "Signature broken" : check.status === "error" ? "Couldn't check" : "Checking"}</b>
            <span className="small">{check.status === "error" ? check.error : "in your browser"}</span>
          </div>
        </div>
        {diffs.length > 0 && (
          <ul className="diffs">
            {diffs.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
        <div style={{ height: 16 }} />
        {TAMPERS.map(([k, label, hint]) => (
          <label className="switch" key={k}>
            <input type="checkbox" role="switch" checked={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.checked })} />
            {label}
            <span className="hint">{hint}</span>
          </label>
        ))}
        <details style={{ marginTop: 16 }}>
          <summary className="small" style={{ cursor: "pointer" }}>Terminal</summary>
          <pre className="json" style={{ marginTop: 8 }}>npm run verify:pack -- {pack.packId}.pack.json</pre>
          <p className="small" style={{ marginTop: 6 }}>
            <a href={`${import.meta.env.BASE_URL}${pack.publicKeyPath}`} download>Public key</a> ∙ key {pack.spkiSha256.slice(0, 12)}…
          </p>
        </details>
      </div>
      {raw && (
        <Drawer title="Raw pack" onClose={() => setRaw(false)}>
          <p className="small">The exact signed object. The signature covers these bytes in canonical JSON.</p>
          <Json value={{ pack: pack.pack, algorithm: pack.algorithm, signatureBase64: pack.signatureBase64 }} />
        </Drawer>
      )}
    </div>
  );
}
