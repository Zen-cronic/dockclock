import { clock, zoneName } from "../format.js";
import { useEmailBody } from "../model/client.js";
import type { ConsoleEmail, LoadDetail } from "../model/model.js";

export function EmailView({ email, timeZone, body, note }: { email: ConsoleEmail; timeZone: string; body?: string | null; note?: string }) {
  const text = body !== undefined ? body : email.body;
  return (
    <div className="mailview">
      <div className="hdr">
        <span>From</span>
        <b>{email.from}</b>
        <span>To</span>
        <span style={{ color: "var(--ink)" }}>{email.to} <span className="small">∙ {email.toNote}</span></span>
        <span>Sent</span>
        <span style={{ color: "var(--ink)" }}>
          {clock(email.sentAt, timeZone)} {zoneName(email.sentAt, timeZone)}
          {email.status === "delivered" ? " ∙ delivered" : email.status === "bounced" ? " ∙ bounced" : email.status === "not_sent" ? " ∙ not sent (test)" : ""}
        </span>
        <span>Subject</span>
        <b>{email.subject}</b>
      </div>
      {text ? <pre>{text}</pre> : <p className="small" style={{ padding: "16px 0" }}>{note || (email.status === "not_sent" ? "Not emailed on a test load." : "Body not stored for this load.")}</p>}
      <div className="files">
        {email.attachments.map((a) => (
          <span className="file" key={a.name} title={a.sha256 ? `sha256 ${a.sha256}` : undefined}>{a.name}</span>
        ))}
      </div>
    </div>
  );
}

// EmailBody: fetches the body when it does not travel with the load.
export function EmailBody({ load, email }: { load: LoadDetail; email: ConsoleEmail }) {
  const q = useEmailBody(load, email);
  if (q.isLoading) return <p className="small">Loading…</p>;
  return <EmailView email={email} timeZone={load.timeZone} body={q.data?.body ?? null} note={q.data?.note ?? ""} />;
}
