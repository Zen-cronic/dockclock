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
    expect(extractEvents(entry, config)[0]).toMatchObject({ sender: { kind: "bsuid", id: "US.abc" } });
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
