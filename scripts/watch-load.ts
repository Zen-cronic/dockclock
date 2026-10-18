// Prints one load's state and timeline. Usage: npm run live:watch -- <loadId>
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const loadId = process.argv[2];
if (!loadId) throw new Error("usage: live:watch <loadId>");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const items = (await ddb.send(new QueryCommand({ TableName: outputs.TableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `LOAD#${loadId}` } }))).Items ?? [];
const meta = items.find((i) => i.sk === "META");
console.log(`${loadId}  channel=${meta?.channel}  phase=${meta?.phase}  version=${meta?.version}  verdict=${meta?.verdict ?? "-"}  dispatchError=${meta?.dispatchError ?? "none"}`);
if (meta?.dispatchMessageId) {
  const receipt = (await ddb.send(new GetCommand({ TableName: outputs.TableName, Key: { pk: `MSG#${meta.dispatchMessageId}`, sk: "RECEIPT" } }))).Item ?? {};
  const states = ["accepted", "sent", "delivered", "read", "failed"].filter((s) => receipt[`${s}At`]).map((s) => `${s} ${receipt[`${s}At`]}`);
  console.log(`  dispatch ${receipt.channel ?? "?"} message: ${states.join(", ") || "no receipt yet"}${receipt.failoverAction ? `  failover ${receipt.failoverAction}` : ""}`);
}
if (meta?.bol) console.log(`  bol: in ${meta.bol.inTime} out ${meta.bol.outTime} reason ${meta.bol.delayReason} media ${meta.bol.media} photos ${meta.bol.photos.length}`);
for (const e of items.filter((i) => String(i.sk).startsWith("EVENT#"))) console.log(`  ${e.serverAt}  ${String(e.channel ?? "").padEnd(8)} ${String(e.type).padEnd(8)} ${String(e.outcome).padEnd(24)} ${e.phaseBefore} -> ${e.phaseAfter}`);
for (const p of items.filter((i) => String(i.sk).startsWith("PACK#"))) console.log(`  pack ${p.s3Key}  verdict ${p.verdict}  confidence ${p.confidence}`);
