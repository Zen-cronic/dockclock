// Puts existing judge and test loads into the public demo workspace (the byWorkspace index), once.
// Usage: npm run backfill:workspace            (dry run: lists what would change)
//        npm run backfill:workspace -- --apply (writes ws = "demo")
// Only DEMO- and SMOKE- loads, or loads already flagged demo or synthetic, are touched. Operator
// LIVE- loads stay out unless dispatched with --workspace demo. createdAt is required by the
// index; a load without one gets its appointment time, which is marked createdAtFrom.
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const apply = process.argv.includes("--apply");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = outputs.TableName!;

export function belongsInDemo(meta: Record<string, unknown>): boolean {
  const id = String(meta.loadId ?? "");
  return meta.demo === true || meta.synthetic === true || id.startsWith("DEMO-") || id.startsWith("SMOKE-");
}

let start: Record<string, unknown> | undefined;
let changed = 0;
let skipped = 0;
do {
  const page = await ddb.send(
    new ScanCommand({
      TableName: table,
      FilterExpression: "sk = :m AND begins_with(pk, :p)",
      ExpressionAttributeValues: { ":m": "META", ":p": "LOAD#" },
      ProjectionExpression: "pk, sk, loadId, demo, synthetic, ws, createdAt, appointmentAt",
      ExclusiveStartKey: start,
    }),
  );
  for (const meta of page.Items ?? []) {
    if (!belongsInDemo(meta) || meta.ws === "demo") {
      skipped += 1;
      continue;
    }
    const createdAt = typeof meta.createdAt === "string" ? meta.createdAt : String(meta.appointmentAt);
    console.log(`${apply ? "set" : "would set"} ws=demo on ${String(meta.loadId)}${typeof meta.createdAt === "string" ? "" : " (createdAt from appointment)"}`);
    if (apply) {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: meta.pk, sk: "META" },
          UpdateExpression: typeof meta.createdAt === "string" ? "SET ws = :w" : "SET ws = :w, createdAt = :c, createdAtFrom = :f",
          ExpressionAttributeValues: { ":w": "demo", ...(typeof meta.createdAt === "string" ? {} : { ":c": createdAt, ":f": "appointmentAt" }) },
        }),
      );
    }
    changed += 1;
  }
  start = page.LastEvaluatedKey;
} while (start);
console.log(`${apply ? "updated" : "would update"} ${changed} load(s); left ${skipped} unchanged`);
