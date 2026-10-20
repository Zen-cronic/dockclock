import { PinpointSMSVoiceV2Client, SendRcsMessageCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalTemplate } from "../src/approval.js";
import { renderRcs, renderWhatsApp } from "../src/outbound.js";
import { rcsDispatchCard, rcsLocationRequest } from "../src/rcs.js";
import { dispatchTemplate, locationRequest, releaseButtons, releaseFlowMessage, send, sendRcs, textMessage } from "../src/sender.js";

const messaging = mockClient(SocialMessagingClient);
const sms = mockClient(PinpointSMSVoiceV2Client);
const dynamo = mockClient(DynamoDBDocumentClient);
const driver = { address: { kind: "phone" as const, e164: "+15550100001" }, driverKey: "phone:a" };
const bsuidDriver = { address: { kind: "bsuid" as const, id: "US.13491208655302741918" }, driverKey: "bsuid:b" };

const sendItems = () => dynamo.commandCalls(PutCommand).map((c) => c.args[0].input.Item as Record<string, unknown>).filter((i) => String(i.sk).startsWith("SEND#"));

describe("outbound message records", () => {
  beforeEach(() => {
    messaging.reset();
    sms.reset();
    dynamo.reset();
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-1" });
    sms.on(SendRcsMessageCommand).resolves({ MessageId: "rcs-1" });
    dynamo.on(GetCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
    dynamo.on(PutCommand).resolves({});
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      ORIGINATION_PHONE_ID: "phone-number-id-test",
      DRIVER_REPLIES: "on",
      DRIVER_ALLOWLIST: "+15550100001,US.13491208655302741918",
      RELEASE_FLOW_ID: "123",
      RCS_AGENT_ID: "rcs-test",
      RCS_TOPIC_ARN: "arn:aws:sns:us-east-1:111122223333:rcs",
      MEDIA_BUCKET: "media",
    });
  });
  afterEach(() => {
    delete process.env.DRIVER_REPLIES;
    delete process.env.RCS_AGENT_ID;
    delete process.env.RCS_TOPIC_ARN;
  });

  it("renders the dispatch template as the approved text with its buttons, never the payloads", () => {
    const out = renderWhatsApp(dispatchTemplate("en_US", "4471", "nonce-secret", "Lakeshore DC", "Oct 17, 2:00 PM"));
    expect(out).toEqual({
      kind: "template",
      template: { name: "dockclock_load_dispatch", language: "en_US" },
      text: "Load 4471 is booked: Lakeshore DC, appointment Oct 17, 2:00 PM. When you are parked at the dock, tap Arrived and we will start the detention clock.",
      footer: "Reply STOP to stop load messages.",
      buttons: ["Arrived", "Talk to dispatch"],
    });
    expect(JSON.stringify(out)).not.toContain("nonce-secret");
  });

  it("renders text, buttons, location requests and the Flow call to action", () => {
    expect(renderWhatsApp(textMessage("hello"))).toEqual({ kind: "text", text: "hello" });
    const buttons = renderWhatsApp(releaseButtons("en_US", "4471", "n1", "Lakeshore DC", "14:02"));
    expect(buttons.kind).toBe("buttons");
    expect(buttons.buttons).toEqual(["Released", "Talk to dispatch"]);
    expect(JSON.stringify(buttons)).not.toContain("dc1.");
    expect(renderWhatsApp(locationRequest("en_US", "arrived"))).toMatchObject({ kind: "location_request", text: expect.stringContaining("Share your location") });
    const flow = renderWhatsApp(releaseFlowMessage("en_US", "4471", "n1", "Lakeshore DC", { loadLabel: "4471", arrivedHint: "", releasedHint: "" }));
    expect(flow).toMatchObject({ kind: "flow", flowCta: "Add BOL photo" });
    expect(JSON.stringify(flow)).not.toContain("flow_token");
  });

  it("renders the dispatcher approval template with the amount", () => {
    const out = renderWhatsApp(approvalTemplate("4471", "n1", "the contract clause is met", "$90.98"));
    expect(out.text).toContain("Proposed claim: $90.98");
    expect(out.buttons).toEqual(["Approve claim", "Hold"]);
  });

  it("renders RCS cards and location requests with their suggestion labels", () => {
    expect(renderRcs(rcsDispatchCard("en_US", "4471", "n1", "Lakeshore DC", "Oct 17, 2:00 PM"))).toMatchObject({ kind: "card", title: expect.stringContaining("4471"), buttons: expect.arrayContaining(["Talk to dispatch"]) });
    expect(renderRcs(rcsLocationRequest("en_US", "released"))).toMatchObject({ kind: "location_request", buttons: [expect.any(String)] });
  });

  it("writes SEND# into the load's partition without the recipient", async () => {
    await send(bsuidDriver, dispatchTemplate("en_US", "4471", "n1", "Lakeshore DC", "Oct 17"), "dispatch_template", "4471");
    const [item] = sendItems();
    expect(item?.pk).toBe("LOAD#4471");
    expect(String(item?.sk)).toMatch(/^SEND#\d{4}-\d\d-\d\dT[^#]+#out-1$/);
    expect(item).toMatchObject({ channel: "whatsapp", purpose: "dispatch_template", audience: "driver", messageId: "out-1" });
    const text = JSON.stringify(item);
    expect(text).not.toContain("US.13491208655302741918");
    expect(text).not.toContain("bsuid:b");
  });

  it("records RCS sends and dispatcher sends the same way", async () => {
    await sendRcs(driver, rcsDispatchCard("en_US", "4471", "n1", "Lakeshore DC", "Oct 17"), "dispatch_card", "4471");
    await send(driver, approvalTemplate("4471", "n1", "ok", "$1.00"), "dispatch_approval", "4471", { audience: "dispatcher" });
    const items = sendItems();
    expect(items.map((i) => [i.channel, i.purpose, i.audience])).toEqual([
      ["rcs", "dispatch_card", "driver"],
      ["whatsapp", "dispatch_approval", "dispatcher"],
    ]);
    expect(JSON.stringify(items)).not.toContain("15550100001");
  });

  it("never records a send that belongs to no load, and never fails a send over the record", async () => {
    await send(driver, textMessage("stopped"), "opt_out", "-", { ignoreOptOut: true });
    expect(sendItems()).toHaveLength(0);
    dynamo.on(PutCommand).rejects(new Error("throttled"));
    expect(await send(driver, textMessage("hi"), "test", "4471")).toBe("out-1");
  });
});
