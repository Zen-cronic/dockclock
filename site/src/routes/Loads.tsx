import { useNavigate } from "react-router-dom";
import { hasRecordedDetail, useLoads } from "../model/client.js";
import { usd } from "../format.js";
import { Page } from "../ui/AppShell.js";
import { ChannelBadge, ProvenanceBadge, Stamp } from "../ui/badges.js";
import { EmptyState } from "../ui/EmptyState.js";

const RUN_WORDS: Record<string, string> = { phone: "Real phone", demo: "Judge demo", operator: "Operator tap", integration: "Test run" };

export function Loads() {
  const q = useLoads();
  const nav = useNavigate();
  const loads = q.data?.data ?? [];
  return (
    <Page crumbs={[{ label: "Loads" }]} badges={q.data && <ProvenanceBadge kind={q.data.source} />}>
      <div className="card">
        {loads.length === 0 ? (
          <EmptyState title="No loads yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Load</th>
                <th className="hide-m">Facility</th>
                <th>Channel</th>
                <th className="hide-m">Run</th>
                <th>Verdict</th>
                <th>Owed</th>
              </tr>
            </thead>
            <tbody>
              {loads.map((l) => {
                const open = l.source !== "fixture" || hasRecordedDetail(l.id);
                return (
                  <tr key={l.id} className={open ? "" : "summary-only"} onClick={() => open && nav(`/loads/${l.id}`)} tabIndex={open ? 0 : -1} onKeyDown={(e) => open && e.key === "Enter" && nav(`/loads/${l.id}`)} title={open ? undefined : "Summary only in the recorded set"}>
                    <td className="id">{l.id}</td>
                    <td className="hide-m">{l.facility}</td>
                    <td><ChannelBadge channel={l.channel} />{l.failover ? <span className="small"> ∙ after failover</span> : null}</td>
                    <td className="hide-m"><span className="badge test">{l.runLabel ?? RUN_WORDS[l.runKind]}</span></td>
                    <td><Stamp verdict={l.verdict} /></td>
                    <td className="num">{usd(l.amountUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
