import { describe, expect, it } from "vitest";
import { decodeRcsEvent, isFromTopic, type RcsConfig } from "../src/index.js";

const config: RcsConfig = { topicArn: "arn:aws:sns:us-east-1:111122223333:dockclock-rcs-events", agentId: "rcs-cb1e6e519e9049fabf8c0ae38e4d876b", mediaBucket: "media" };
const publishedAt = "2026-10-18T16:20:01.123Z";

function envelope(message: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ Type: "Notification", TopicArn: config.topicArn, Timestamp: publishedAt, Message: JSON.stringify(message), ...overrides });
}

// Shapes from the AWS End User Messaging SMS user guide (rcs-events, rcs-inbound, rcs-inbound-media).
const suggestion = {
  originationNumber: "12679164820",
  destinationNumber: config.agentId,
  messageBody: JSON.stringify({ type: "SUGGESTION", text: "Arrived", postbackData: "dc1.arrived.4471.abc123" }),
  inboundMessageId: "nIMYZGrBUILWng0Qck0deqVaAoTSJY5PsktKYOBYJhVaTsrdMdrs714e8SLZAjD3",
};
const media = {
  originationNumber: "+14255551234",
  destinationNumber: config.agentId,
  messageBody: JSON.stringify({ mediaStatus: "SUCCESS", s3Bucket: "media", s3Key: "rcs-inbound/rcs/msg-abc123def456#photo_2026.jpg", mimeType: "image/jpeg", fileName: "photo_2026.jpg", fileSizeBytes: 1211843 }),
  inboundMessageId: "8821d750-4bc5-4cb1-a8c3-c3d64a38d019",
};
const delivered = {
  eventType: "RCS_DELIVERED",
  eventVersion: "1.0",
  eventTimestamp: 1781661267660,
  isFinal: true,
  originationPhoneNumber: config.agentId,
  destinationPhoneNumber: "+13022640220",
  messageId: "b4a3196d-5b61-4884-a0d9-745acf1f6235",
  messageStatus: "DELIVERED",
  messageStatusDescription: "Message has been accepted by phone",
  context: { loadId: "4471", purpose: "dispatch_card" },
};

describe("decodeRcsEvent", () => {
  it("turns a suggested-reply tap into the same button event WhatsApp produces", () => {
    const [event] = decodeRcsEvent(envelope(suggestion), config);
    expect(event).toEqual({
      kind: "inbound",
      channel: "rcs",
      wamid: `rcs.${suggestion.inboundMessageId}`,
      serverAt: publishedAt,
      sender: { kind: "phone", e164: "+12679164820" },
      body: { type: "button", payload: "dc1.arrived.4471.abc123" },
    });
  });

  it("refuses another topic or another agent", () => {
    expect(() => decodeRcsEvent(envelope(suggestion, { TopicArn: "arn:aws:sns:us-east-1:111122223333:other" }), config)).toThrow("UNTRUSTED_TOPIC");
    expect(() => decodeRcsEvent(envelope({ ...suggestion, destinationNumber: "rcs-someoneelse" }), config)).toThrow("WRONG_AGENT");
    expect(() => decodeRcsEvent(envelope({ ...delivered, originationPhoneNumber: "rcs-someoneelse" }), config)).toThrow("WRONG_AGENT");
  });

  it("keeps a stored photo's S3 key and refuses media in a bucket that is not ours", () => {
    const [photo] = decodeRcsEvent(envelope(media), config);
    expect(photo).toMatchObject({ kind: "inbound", body: { type: "image", mimeType: "image/jpeg", s3Key: "rcs-inbound/rcs/msg-abc123def456#photo_2026.jpg", metaSha256: null } });
    const foreign = JSON.stringify({ ...JSON.parse(media.messageBody), s3Bucket: "elsewhere" });
    expect(decodeRcsEvent(envelope({ ...media, messageBody: foreign }), config)[0]).toMatchObject({ body: { type: "other", rawType: "rcs:media_foreign_bucket" } });
  });

  it("reports a photo the service could not store as a photo without a key", () => {
    const failed = JSON.stringify({ mediaStatus: "ROLE_ASSUME_FAILED", mediaStatusMessage: "could not assume role", mimeType: "image/heic", fileName: "IMG.heic" });
    const [event] = decodeRcsEvent(envelope({ ...media, messageBody: failed }), config);
    expect(event).toMatchObject({ body: { type: "image", mimeType: "image/heic" } });
    expect((event as { body: { s3Key?: string } }).body.s3Key).toBeUndefined();
  });

  it("reads a shared location in either spelling, and reports an unknown shape by its keys only", () => {
    const flat = JSON.stringify({ type: "LOCATION", latitude: 39.8995, longitude: -82.938 });
    expect(decodeRcsEvent(envelope({ ...suggestion, messageBody: flat }), config)[0]).toMatchObject({ body: { type: "location", lat: 39.8995, lon: -82.938 } });
    const nested = JSON.stringify({ type: "LOCATION", location: { lat: "39.8995", lng: "-82.938" } });
    expect(decodeRcsEvent(envelope({ ...suggestion, messageBody: nested }), config)[0]).toMatchObject({ body: { type: "location", lat: 39.8995, lon: -82.938 } });
    const odd = JSON.stringify({ type: "LOCATION", point: "39.8995,-82.938" });
    expect(decodeRcsEvent(envelope({ ...suggestion, messageBody: odd }), config)[0]).toMatchObject({ body: { type: "other", rawType: "rcs:location_unparsed:point+type" } });
  });

  it("passes plain text through and ignores typing and conversation notices", () => {
    expect(decodeRcsEvent(envelope({ ...suggestion, messageBody: "STOP" }), config)[0]).toMatchObject({ body: { type: "text", text: "STOP" } });
    const typing = { ...suggestion, messageBody: JSON.stringify({ type: "RCS_TYPING", receivedAt: "2026-06-17T17:36:29.937+0000" }) };
    expect(decodeRcsEvent(envelope(typing), config)).toEqual([]);
  });

  it("maps delivery events to receipts that carry the send's load and purpose", () => {
    const [receipt] = decodeRcsEvent(envelope(delivered), config);
    expect(receipt).toMatchObject({ kind: "status", channel: "rcs", eumMessageId: delivered.messageId, state: "delivered", loadId: "4471", purpose: "dispatch_card" });
    expect(receipt?.serverAt).toBe(new Date(1781661267660).toISOString());
    const [undeliverable] = decodeRcsEvent(envelope({ ...delivered, messageStatus: "UNDELIVERABLE" }), config);
    expect(undeliverable).toMatchObject({ state: "failed" });
    const [failed] = decodeRcsEvent(envelope({ ...delivered, eventType: "RCS_FAILED", messageStatus: undefined }), config);
    expect(failed).toMatchObject({ state: "failed" });
  });

  it("routes by topic without trusting the body", () => {
    expect(isFromTopic(envelope(suggestion), config.topicArn)).toBe(true);
    expect(isFromTopic("not json", config.topicArn)).toBe(false);
  });
});
