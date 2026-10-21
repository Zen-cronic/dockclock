// Dispatches a real LIVE- load to the first allowlisted driver number. Usage:
//   npm run live:dispatch -- [en_US|es_MX|fr_CA] [facilityId] [whatsapp|rcs] [--workspace demo] [--clause <id>]
// --workspace demo lists the load in the public demo workspace, so the console and /judges show it
// (sanitized). Without it, an operator load stays out of the console. --clause judge-demo runs the
// 5-minute demo clause instead of lakeshore-foods, so a real-phone take fits in about 10 minutes.
import { readFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const args = process.argv.slice(2);
const flag = args.indexOf("--workspace");
const workspace = flag === -1 ? undefined : args.splice(flag, 2)[1];
if (flag !== -1 && workspace !== "demo") throw new Error('--workspace takes "demo"');
const clauseFlag = args.indexOf("--clause");
const clauseId = clauseFlag === -1 ? "lakeshore-foods" : args.splice(clauseFlag, 2)[1];
if (!clauseId) throw new Error("--clause takes a clause id");
const [language = "en_US", facilityId = "lakeshore-columbus", channel = "whatsapp"] = args;
if (channel !== "whatsapp" && channel !== "rcs") throw new Error("channel must be whatsapp or rcs");
const driver = (process.env.DOCKCLOCK_DRIVER_ALLOWLIST ?? "").split(",")[0]?.trim();
if (!driver) throw new Error("DOCKCLOCK_DRIVER_ALLOWLIST is empty");

const loadId = `LIVE-${Date.now().toString(36)}`;
const appointmentAt = new Date(Math.ceil(Date.now() / 900_000) * 900_000).toISOString();
const result = await new LambdaClient({}).send(
  new InvokeCommand({
    FunctionName: outputs.DispatchFunction,
    Payload: Buffer.from(
      JSON.stringify({
        loadId,
        clauseId,
        facilityId,
        appointmentAt,
        channel,
        language,
        address: driver.startsWith("+") ? { kind: "phone", e164: driver } : { kind: "bsuid", id: driver },
        optIn: { method: "operator_test_consent_in_chat", at: new Date().toISOString() },
        ...(workspace ? { workspace } : {}),
      }),
    ),
  }),
);
const payload = Buffer.from(result.Payload ?? []).toString();
if (result.FunctionError) throw new Error(`dispatch failed: ${payload}`);
const { templateMessageId } = JSON.parse(payload) as { templateMessageId: string | null };
const { dispatchError } = JSON.parse(payload) as { dispatchError: string | null };
console.log(`dispatched ${loadId} (${language}, ${clauseId}, ${facilityId}, ${channel}${workspace ? ", demo workspace" : ""}); dispatch message ${templateMessageId ?? `NOT SENT${dispatchError ? `: ${dispatchError}` : ""}`}`);
console.log(`watch it: npm run -s live:watch -- ${loadId}`);
