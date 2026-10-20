import { clock, zoneName } from "../format.js";
import type { ConsoleEmail } from "../model/model.js";

export function EmailView({ email, timeZone }: { email: ConsoleEmail; timeZone: string }) {
  return (
    <div className="mailview">
      <div className="hdr">
        <span>From</span>
        <b>{email.from}</b>
        <span>To</span>
        <span style={{ color: "var(--ink)" }}>{email.to} <span className="small">· {email.toNote}</span></span>
        <span>Sent</span>
        <span style={{ color: "var(--ink)" }}>
          {clock(email.sentAt, timeZone)} {zoneName(email.sentAt, timeZone)}
          {email.deliveredAt ? " · delivered" : ""}
          {email.bouncedAt ? " · bounced" : ""}
        </span>
        <span>Subject</span>
        <b>{email.subject}</b>
      </div>
      {email.body ? <pre>{email.body}</pre> : <p className="small" style={{ padding: "16px 0" }}>Body not stored for this load.</p>}
      <div className="files">
        {email.attachments.map((a) => (
          <span className="file" key={a.name} title={a.sha256 ? `sha256 ${a.sha256}` : undefined}>{a.name}</span>
        ))}
      </div>
    </div>
  );
}
