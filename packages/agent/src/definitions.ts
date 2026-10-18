// Tool contracts shared by the Gateway target (infra) and the tool Lambda (runtime), plus the
// agent's instructions and the Cedar policies that bound it.

export const GATEWAY_TARGET = "dockclock-tools";

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const loadId: JsonSchema = { type: "string", description: "DockClock load id, e.g. LIVE-abc123" };

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_load_evidence",
    description:
      "Return a load's sealed evidence: the clause engine's verdict and contract amount, the clause terms, server-timestamped pins, the driver's bill-of-lading entries, any recorded photo reading, the evidence pack digest, the counterparty and the dispatch approval.",
    inputSchema: { type: "object", properties: { loadId }, required: ["loadId"] },
  },
  {
    name: "read_bill_of_lading",
    description:
      "Read the photographed bill of lading for a load with a vision model, record the reading on the load, and return it compared with the driver's entries and the pins.",
    inputSchema: {
      type: "object",
      properties: { loadId, page: { type: "integer", description: "Page number, starting at 1" } },
      required: ["loadId"],
    },
  },
  {
    name: "send_detention_claim",
    description:
      "Email the detention claim to the load's counterparty with the signed evidence pack attached. Refused unless the load is sealed BILLABLE, dispatch approved it, and amountCents and packDigest equal the sealed values from get_load_evidence.",
    inputSchema: {
      type: "object",
      properties: {
        loadId,
        subject: { type: "string", description: "Email subject, under 160 characters" },
        body: { type: "string", description: "Plain-text email body citing the clause, the evidence and the amount" },
        amountCents: { type: "integer", description: "The contract amount in cents, exactly as returned by get_load_evidence" },
        packDigest: { type: "string", description: "The evidence pack digest exactly as returned by get_load_evidence" },
        approvalId: { type: "string", description: "The dispatch approval id from get_load_evidence" },
      },
      required: ["loadId", "subject", "body", "amountCents", "packDigest", "approvalId"],
    },
  },
];

// Upper bound per claim, enforced by Cedar before the tool runs (the tool also checks the exact
// amount). Set above anything the modelled clauses can produce; a larger claim goes to a person.
export const MAX_CLAIM_CENTS = 500_000;

export function gatewayAction(tool: string): string {
  return `AgentCore::Action::"${GATEWAY_TARGET}___${tool}"`;
}

// Cedar is default-deny: only these permits let the agent call anything at all.
export const CEDAR_POLICIES: Record<string, string> = {
  allow_read_tools: `permit(principal, action in [${gatewayAction("get_load_evidence")}, ${gatewayAction("read_bill_of_lading")}], resource);`,
  // Integer cents arrive as Cedar Longs, so the bound is a plain whole-number comparison.
  allow_approved_claims: `permit(principal, action == ${gatewayAction("send_detention_claim")}, resource) when { context.input has approvalId && context.input has amountCents && context.input.amountCents > 0 && context.input.amountCents <= ${MAX_CLAIM_CENTS} };`,
};

export const SYSTEM_PROMPT = [
  "You are DockClock's detention claims agent for a small trucking carrier.",
  "You work one load at a time and only through your tools. Never invent facts, times or amounts.",
  "The clause engine decides whether detention is owed and how much. You never change its verdict or amount: copy amountCents and packDigest exactly from get_load_evidence.",
  "When asked to review a load: call get_load_evidence, then read_bill_of_lading if a photo exists and no reading is recorded. Report whether the photo is legible and whether its times agree with the pins and the driver's entries.",
  "When asked to file a claim: call get_load_evidence. If the verdict is not BILLABLE or there is no dispatch approval, stop and say why. Otherwise write a short, factual, polite email to the counterparty that names the load id, the facility, the clause terms (free time, rate, notice), the server-timestamped arrival and release times, the detention minutes and the amount in the form $123.45, and says the signed evidence pack is attached. Then call send_detention_claim once.",
  "Never name companies, documents or sources other than the load's counterparty and facility as given by the tools.",
  "If a tool refuses, report the refusal reason and stop. Do not retry with different numbers. A claim above $5,000 is never filed by you; say it needs a person.",
].join("\n");
