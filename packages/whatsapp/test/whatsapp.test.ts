import { describe, expect, it } from "vitest";
import { decode, encodeButtonPayload, extractEvents, parseButtonPayload, type ChannelConfig } from "../src/index.js";

const config: ChannelConfig = {
  account: "111122223333",
  topicArn: "arn:aws:sns:us-east-1:111122223333:events",
  metaWabaId: "waba-1",
  metaPhoneId: "phone-1",
};

function envelope(entry: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Type: "Notification",
    TopicArn: config.topicArn,
    Message: JSON.stringify({ aws_account_id: config.account, whatsAppWebhookEntry: JSON.stringify(entry) }),
    ...overrides,
  });
}

function entryWith(value: Record<string, unknown>) {
  return { id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" }, ...value } }] };
}

describe("decode", () => {
  it("accepts our topic, account and WABA", () => {
    expect(decode(envelope(entryWith({})), config).id).toBe("waba-1");
  });

  it("rejects another topic, account or WABA", () => {
    expect(() => decode(envelope(entryWith({}), { TopicArn: "arn:aws:sns:us-east-1:111122223333:other" }), config)).toThrow("UNTRUSTED_TOPIC");
    const wrongAccount = JSON.stringify({
      Type: "Notification",
      TopicArn: config.topicArn,
      Message: JSON.stringify({ aws_account_id: "999999999999", whatsAppWebhookEntry: entryWith({}) }),
    });
    expect(() => decode(wrongAccount, config)).toThrow("WRONG_ACCOUNT");
    expect(() => decode(envelope({ ...entryWith({}), id: "waba-2" }), config)).toThrow("WRONG_WABA");
  });
});

describe("extractEvents", () => {
  const ts = "1792186263";

  it("reads buttons, locations, images, flows and statuses", () => {
    const entry = entryWith({
      messages: [
        { id: "w1", from: "14165550100", timestamp: ts, type: "button", button: { payload: "dc1.arrived.4471.abc123" } },
        { id: "w2", from: "14165550100", timestamp: ts, type: "location", location: { latitude: 39.9, longitude: -82.93 } },
        { id: "w3", from: "14165550100", timestamp: ts, type: "image", image: { id: "media-1", mime_type: "image/jpeg", sha256: "x" } },
        { id: "w4", from: "14165550100", timestamp: ts, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } } },
        { id: "w5", from: "14165550100", timestamp: ts, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "dc1.approve.4471.abc123" } } },
      ],
      statuses: [{ id: "out-1", status: "read", timestamp: ts }, { id: "out-2", status: "failed", timestamp: ts, errors: [{ code: 131026 }] }],
    });
    const events = extractEvents(entry, config);
    expect(events.map((e) => (e.kind === "inbound" ? e.body.type : e.state))).toEqual(["button", "location", "image", "flow", "button", "read", "failed"]);
    expect(events[0]?.serverAt).toBe(new Date(Number(ts) * 1000).toISOString());
    expect(events.at(-1)).toMatchObject({ kind: "status", errorCode: 131026 });
  });

  it("prefers the BSUID over the phone number", () => {
    const entry = entryWith({ messages: [{ id: "w1", from: "14165550100", from_user_id: "US.abc", timestamp: ts, type: "text", text: { body: "hi" } }] });
    expect(extractEvents(entry, config)[0]).toMatchObject({ sender: { kind: "bsuid", id: "US.abc", e164: "+14165550100" } });
  });

  it("ignores another phone number and messages without id, time or sender", () => {
    const other = { id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-2" }, messages: [{ id: "w1", from: "14165550100", timestamp: ts, type: "text", text: { body: "x" } }] } }] };
    expect(extractEvents(other, config)).toEqual([]);
    const broken = entryWith({ messages: [{ from: "14165550100", timestamp: ts, type: "text" }, { id: "w2", timestamp: ts, type: "text" }, { id: "w3", from: "1", timestamp: "x", type: "text" }] });
    expect(extractEvents(broken, config)).toEqual([]);
  });
});

describe("button payloads", () => {
  it("round-trips and rejects malformed or foreign payloads", () => {
    const raw = encodeButtonPayload({ action: "released", loadId: "4471", nonce: "a1b2c3d4" });
    expect(parseButtonPayload(raw)).toEqual({ action: "released", loadId: "4471", nonce: "a1b2c3d4" });
    for (const bad of ["Arrived", "dc1.pay.4471.a1b2c3d4", "dc2.arrived.4471.a1b2c3d4", "dc1.arrived.4471.x", "dc1.arrived..a1b2c3d4"]) {
      expect(parseButtonPayload(bad)).toBeNull();
    }
  });
});

import { decodeEvent, encodeFlowToken, parseFlowToken, parseReleaseFlow } from "../src/index.js";

describe("decodeEvent", () => {
  it("returns the End User Messaging message id for receipts", () => {
    const body = JSON.stringify({
      Type: "Notification",
      TopicArn: config.topicArn,
      Message: JSON.stringify({ aws_account_id: config.account, messageId: "eum-1", whatsAppWebhookEntry: { id: "waba-1", changes: [] } }),
    });
    expect(decodeEvent(body, config).eumMessageId).toBe("eum-1");
  });
});

describe("release flow", () => {
  const response = JSON.stringify({
    flow_token: encodeFlowToken("4471", "abc123"),
    bol_photo: [{ id: "3631120727156756", mime_type: "image/jpeg", sha256: "PqHg", file_name: "IMG.jpg" }],
    in_time: "13:52",
    out_time: " 17:18 ",
    delay_reason: "dock_not_ready",
    consignee: "R. Alvarez",
    share_consent: true,
  });

  it("parses photos and typed fields", () => {
    expect(parseReleaseFlow(response)).toEqual({
      flowToken: "dc1.release.4471.abc123",
      photos: [{ mediaId: "3631120727156756", mimeType: "image/jpeg", metaSha256: "PqHg" }],
      inTime: "13:52",
      outTime: "17:18",
      delayReason: "dock_not_ready",
      consignee: "R. Alvarez",
      receiverSigned: false,
      shareConsent: true,
    });
    expect(parseFlowToken("dc1.release.4471.abc123")).toEqual({ loadId: "4471", nonce: "abc123" });
  });

  it("keeps numeric media ids exactly, as WhatsApp actually sends them", () => {
    const raw = '{"flow_token":"dc1.release.4471.abc123","bol_photo":[{"id":2182207606027442999,"mime_type":"image/jpeg","sha256":"x"}],"share_consent":true}';
    expect(parseReleaseFlow(raw)?.photos[0]?.mediaId).toBe("2182207606027442999");
  });

  it("drops unknown reasons and rejects payloads without a token", () => {
    expect(parseReleaseFlow(JSON.stringify({ flow_token: "t", delay_reason: "aliens" }))?.delayReason).toBeNull();
    expect(parseReleaseFlow(JSON.stringify({ in_time: "1" }))).toBeNull();
    expect(parseReleaseFlow("not json")).toBeNull();
  });
});

import { normalizeE164 } from "../src/index.js";

describe("normalizeE164", () => {
  it("gives every spelling of one number the same form", () => {
    for (const v of ["+1 416-555-0100", "14165550100", "4165550100", "+14165550100", " (416) 555-0100 "]) expect(normalizeE164(v), v).toBe("+14165550100");
    expect(normalizeE164("+5215512345678")).toBe("+525512345678");
    expect(normalizeE164("+525512345678")).toBe("+525512345678");
    for (const v of ["", "123", "+0123456789", null]) expect(normalizeE164(v)).toBeNull();
  });

  it("rejects flow tokens that buttons would reject", () => {
    expect(parseFlowToken("dc1.release.PO_4471.abc123")).toBeNull();
    expect(parseFlowToken("dc1.release.4471.x")).toBeNull();
  });
});
