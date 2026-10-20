import { Link } from "react-router-dom";
import { FEATURED_LOAD, useLoad, useOverview } from "../model/client.js";
import { clock, usd } from "../format.js";
import { ChannelBadge, ProvenanceBadge, channelName } from "../ui/badges.js";
import { Page } from "../ui/AppShell.js";
import { DockClockBand } from "../ui/DockClockBand.js";
import { KpiTile } from "../ui/KpiTile.js";
import { EmptyState } from "../ui/EmptyState.js";

export function Overview() {
  const ov = useOverview();
  const featured = useLoad(FEATURED_LOAD);
  const o = ov.data?.data;
  const load = featured.data?.data;
  return (
    <Page
      crumbs={[{ label: "Overview" }]}
      badges={ov.data && <ProvenanceBadge kind={ov.data.source} />}
      actions={
        <Link className="btn primary" to="/judges">
          Start the judges path
        </Link>
      }
    >
      {!o ? (
        <EmptyState title="Loading" />
      ) : (
        <>
          <div className="kpis">
            <KpiTile label="Claimed" value={usd(o.claimedUsd)} tone="money" />
            <KpiTile label="Claims filed" value={o.claimsFiled} />
            <KpiTile label="Delivered" value={o.deliveredPct ?? "—"} unit={o.deliveredPct != null ? "%" : ""} tone="ok" />
            <KpiTile label="Failovers" value={o.failovers} />
          </div>
          {load && (
            <div style={{ marginTop: 16 }}>
              <Link to={`/loads/${load.summary.id}`} style={{ textDecoration: "none", display: "block" }} aria-label={`Open load ${load.summary.id}`}>
                <DockClockBand load={load} />
              </Link>
            </div>
          )}
          <div className="section-title">Activity</div>
          <div className="grid-2">
            <div className="card">
              <div className="card-head">
                <h2>Latest</h2>
                <Link className="small" to="/messages">All messages ›</Link>
              </div>
              <ul className="feed">
                {o.activity.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <span className="ts">{clock(a.at, load?.timeZone ?? "America/New_York")}</span>
                    <span className={`dot ${a.tone}`} aria-hidden="true" />
                    <Link className="t" to={`/loads/${a.loadId}`}>{a.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div className="card-head"><h2>By channel</h2></div>
              <div className="card-body">
                <div className="chanbars">
                  {o.byChannel.map((c) => {
                    const total = Math.max(1, c.sent + c.received);
                    return (
                      <div className="chanbar" key={c.channel}>
                        <ChannelBadge channel={c.channel} />
                        <div className="bars" aria-label={`${channelName(c.channel)}: ${c.delivered} delivered, ${c.sent - c.delivered - c.failed} sent, ${c.received} received, ${c.failed} failed`}>
                          <i className="d" style={{ width: `${(c.delivered / total) * 100}%` }} />
                          <i className="s" style={{ width: `${(Math.max(0, c.sent - c.delivered - c.failed) / total) * 100}%` }} />
                          <i className="r" style={{ width: `${(c.received / total) * 100}%` }} />
                          <i className="f" style={{ width: `${(c.failed / total) * 100}%` }} />
                        </div>
                        <span className="n">{c.sent + c.received}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="legend">
                  <span><i style={{ background: "var(--go)" }} />delivered</span>
                  <span><i style={{ background: "var(--ink-3)" }} />sent</span>
                  <span><i style={{ background: "var(--rule-2)" }} />received</span>
                  <span><i style={{ background: "var(--stop)" }} />failed</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
