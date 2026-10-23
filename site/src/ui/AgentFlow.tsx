import { clockOn } from "../format.js";
import type { FlowNode } from "../model/flow.js";
import { IconAgent, IconCheck, IconClock, IconDoc, IconEmail, IconLock, IconMessages, IconStop } from "./icons.js";

const ICONS = { chat: IconMessages, mail: IconEmail, lock: IconLock, agent: IconAgent, check: IconCheck, stop: IconStop, clock: IconClock, doc: IconDoc };

// AgentFlow: the load's workflow as a vertical graph, each node tagged with the AWS services that ran it.
export function AgentFlow({ nodes, timeZone, onOpen }: { nodes: FlowNode[]; timeZone: string; onOpen?: (n: FlowNode) => void }) {
  // A run that crosses days dates the later nodes.
  const ref = nodes[0]?.at ?? "";
  return (
    <ol className="flow">
      {nodes.map((n) => {
        const Icon = ICONS[n.icon];
        return (
          <li key={n.id} className={n.tone}>
            <span className="node" aria-hidden="true">
              <Icon />
            </span>
            <div>
              <div className="ti">{n.title}</div>
              <div className="svcline">{n.services.join(" ∙ ")}</div>
            </div>
            <div className="when">
              {n.tone !== "skipped" && (
                <>
                  {clockOn(n.at, timeZone, ref)}
                  <br />
                </>
              )}
              {n.raw && onOpen ? (
                <button className="linkbtn" onClick={() => onOpen(n)}>{n.outcome ?? "details"}</button>
              ) : (
                <span>{n.outcome}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
