import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiMessage, LoadView } from "../src/api.js";
import { detailFromApi } from "../src/model/fromApi.js";
import { ConversationView } from "../src/ui/ConversationView.js";

// The PDF claim summary sent back over WhatsApp after filing: a document bubble with the file name,
// the caption and the hash of the file's bytes, in the phone of whoever received it.
const fxDir = new URL("../fixtures/api/loads/", import.meta.url);
const body = JSON.parse(readFileSync(new URL("SMOKE-DEMO-mvh3xsdv.json", fxDir), "utf8")) as { data: LoadView };
const sha = "085207f00ab4089b386a5eff743743e00cb3c275073fba140f09b4ef8e1a60a7";
const caption = "Claim summary for load SMOKE-DEMO-mvh3xsdv: $8.50. The signed evidence pack went with the claim email.";

function withDocument(over: Partial<ApiMessage> = {}): LoadView {
  const v = structuredClone(body.data);
  const last = v.messages.at(-1)!;
  v.messages.push({
    id: `m${v.messages.length + 1}`,
    at: new Date(Date.parse(last.at) + 1000).toISOString(),
    channel: "whatsapp",
    direction: "out",
    party: "driver",
    purpose: "claim_receipt",
    kind: "wa_document",
    body: caption,
    document: { filename: "detention-claim-SMOKE-DEMO-mvh3xsdv.pdf", caption, sha256: sha },
    status: "delivered",
    provenance: "recorded",
    ...over,
  });
  return v;
}

describe("the PDF claim summary in the conversation", () => {
  it("adapts a wa_document message into a document with its file name, caption and hash", () => {
    const d = detailFromApi(withDocument(), "fixture");
    const doc = d.messages.at(-1)!;
    expect(doc).toMatchObject({ kind: "document", body: caption, document: { filename: "detention-claim-SMOKE-DEMO-mvh3xsdv.pdf", caption, sha256: sha } });
  });

  it("draws a document bubble with the file name, PDF, the shortened hash (full on hover) and the caption", () => {
    const d = detailFromApi(withDocument(), "fixture");
    const html = renderToStaticMarkup(createElement(ConversationView, { messages: d.messages, timeZone: "America/New_York", party: "driver" }));
    expect(html).toContain('class="docfile"');
    expect(html).toContain("<b>detention-claim-SMOKE-DEMO-mvh3xsdv.pdf</b>");
    expect(html).toContain(`PDF ∙ sha256 ${sha.slice(0, 12)}…`);
    expect(html).toContain(`title="sha256 ${sha}"`);
    expect(html).toContain(caption);
  });

  it("shows a dispatcher's copy in the dispatch phone and a not-sent copy dashed", () => {
    const d = detailFromApi(withDocument({ party: "dispatcher", status: "not_sent", notSentReason: "Not sent: a test load." }), "fixture");
    const dispatch = renderToStaticMarkup(createElement(ConversationView, { messages: d.messages, timeZone: "America/New_York", party: "dispatcher" }));
    expect(dispatch).toContain("detention-claim-SMOKE-DEMO-mvh3xsdv.pdf");
    expect(dispatch).toMatch(/class="bub\s+unsent"/);
    const driver = renderToStaticMarkup(createElement(ConversationView, { messages: d.messages, timeZone: "America/New_York", party: "driver" }));
    expect(driver).not.toContain("detention-claim-SMOKE-DEMO-mvh3xsdv.pdf");
  });
});
