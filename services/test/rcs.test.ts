import { describe, expect, it } from "vitest";
import type { InboundEvent } from "@dockclock/whatsapp";
import { applyEvent, failoverEffect, type LoadState } from "../src/lifecycle.js";
import { COPY, LANGUAGES } from "../src/messages.js";
import { rcsBolRequest, rcsDispatchCard, rcsLocationRequest, rcsReleaseOffer } from "../src/rcs.js";

const awaitingBol: LoadState = {
  loadId: "4471",
  nonce: "abc123",
  phase: "awaiting_bol",
  version: 5,
  arrived: { serverAt: "2026-10-13T13:00:00.000Z", messageId: "a", lat: 0, lon: 0 },
  released: { serverAt: "2026-10-13T17:20:00.000Z", messageId: "r", lat: 0, lon: 0 },
  bol: null,
  flowSends: 1,
};

function photo(channel: "rcs" | undefined, s3Key?: string): InboundEvent {
  return {
    kind: "inbound",
    ...(channel ? { channel } : {}),
    wamid: "rcs.m1",
    serverAt: "2026-10-13T17:25:00.000Z",
    sender: { kind: "phone", e164: "+15550100001" },
    body: { type: "image", mediaId: "m1", mimeType: "image/jpeg", metaSha256: null, ...(s3Key ? { s3Key } : {}) },
  };
}

describe("RCS driver prompts", () => {
  it("fit RCS limits in every language and carry the same dc1 payloads as WhatsApp", () => {
    for (const language of LANGUAGES) {
      const copy = COPY[language];
      for (const text of [copy.rcs.arrived, copy.rcs.shareLocation, copy.released, copy.talkToDispatch]) expect([...text].length, `${language}: ${text}`).toBeLessThanOrEqual(25);
      expect(copy.rcs.dispatch("Lakeshore DC, Columbus OH", "Oct 17, 2:00 PM").length).toBeLessThan(2000);
    }
    const dispatch = JSON.stringify(rcsDispatchCard("es_MX", "4471", "abc123", "Lakeshore DC", "17 oct, 2:00 p.m."));
    expect(dispatch).toContain("dc1.arrived.4471.abc123");
    expect(dispatch).toContain("dc1.dispatch.4471.abc123");
    expect(dispatch).toContain("Llegué");
    expect(JSON.stringify(rcsReleaseOffer("fr_CA", "4471", "abc123", "Lakeshore DC", "13:52"))).toContain("dc1.released.4471.abc123");
  });

  it("asks for the pin with a RequestLocation action whose tap changes nothing", () => {
    const content = rcsLocationRequest("en_US", "arrived");
    expect(content.Suggestions?.[0]).toEqual({ RequestLocation: { Text: "Share location", PostbackData: "location_request.arrived" } });
    expect(content.Suggestions?.[0]?.RequestLocation?.PostbackData.startsWith("dc1.")).toBe(false);
  });

  it("asks for a photo reply where WhatsApp would open the release Flow", () => {
    expect(rcsBolRequest("en_US", "Lakeshore DC", "16:02 EDT").Content?.TextMessage?.Body).toContain("Reply with a photo of the signed bill of lading");
  });
});

describe("RCS bill of lading", () => {
  it("takes an RCS photo reply as the BOL, with no times and no signature", () => {
    const t = applyEvent(awaitingBol, photo("rcs", "rcs-inbound/rcs/m1#bol.jpg"));
    expect(t.outcome).toBe("ADVANCED");
    expect(t.state.phase).toBe("documented");
    expect(t.state.bol).toMatchObject({ channel: "rcs", inTime: null, outTime: null, receiverSigned: false, media: "pending" });
    expect(t.state.bol?.photos[0]?.s3Key).toBe("rcs-inbound/rcs/m1#bol.jpg");
    expect(t.effects).toEqual([{ type: "download_media" }, { type: "resume", step: "bol" }]);
  });

  it("still points WhatsApp drivers to the camera Flow instead", () => {
    const t = applyEvent(awaitingBol, photo(undefined));
    expect(t.state.phase).toBe("awaiting_bol");
    expect(t.effects).toEqual([{ type: "tell_driver", key: "use_bol_button" }]);
  });
});

describe("failoverEffect", () => {
  it("re-sends the failed prompt only while the load is still waiting on it", () => {
    expect(failoverEffect("dispatch_template", "dispatched")).toEqual({ type: "send_dispatch" });
    expect(failoverEffect("offer_release", "at_dock")).toEqual({ type: "offer_release" });
    expect(failoverEffect("location_released", "awaiting_release_pin")).toEqual({ type: "request_location", step: "released" });
    expect(failoverEffect("release_flow", "awaiting_bol")).toEqual({ type: "send_release_flow" });
    expect(failoverEffect("tell_dispatch_notified", "at_dock")).toEqual({ type: "tell_driver", key: "dispatch_notified" });
    expect(failoverEffect("offer_release", "awaiting_bol")).toBeNull();
    expect(failoverEffect("tell_not_a_key", "at_dock")).toBeNull();
    expect(failoverEffect("offer_release", "sealed")).toBeNull();
  });
});
