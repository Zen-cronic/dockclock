import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { facilityById } from "@dockclock/evidence";
import type { LoadItem } from "./store.js";
import { env, log } from "./config.js";

const ses = new SESv2Client({ maxAttempts: 3 });

// Tells a person at dispatch that a driver needs them. Email via SES, so the claim of
// "dispatch has been notified" in the driver's chat is backed by a real message.
export async function notifyDispatch(load: LoadItem, reason: string): Promise<string | null> {
  if (load.synthetic) {
    log("dispatch_notify_skipped", { loadId: load.loadId, reason, why: "synthetic test load" });
    return null;
  }
  const facility = facilityById(load.facilityId);
  const subject = `DockClock: load ${load.loadId} needs dispatch (${reason})`;
  const text = [
    `Load ${load.loadId} at ${facility.name} needs a person.`,
    `Reason: ${reason}.`,
    `Phase: ${load.phase}. Driver language: ${load.language}.`,
    `Arrived pin: ${load.arrived?.serverAt ?? "none"}. Released pin: ${load.released?.serverAt ?? "none"}.`,
    "Reply to the driver on WhatsApp or call them.",
  ].join("\n");
  const out = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: env.fromEmail(),
      Destination: { ToAddresses: [env.dispatchEmail()] },
      ConfigurationSetName: env.configurationSet(),
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      EmailTags: [{ Name: "purpose", Value: "dispatch_escalation" }],
    }),
  );
  log("dispatch_notified", { loadId: load.loadId, reason, sesMessageId: out.MessageId });
  return out.MessageId ?? null;
}
