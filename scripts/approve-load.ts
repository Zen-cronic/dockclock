// Records a dispatch approval for a sealed load from the command line, for testing the claim path
// before the WhatsApp approval tap exists. Usage: npm run approve:load -- <loadId>
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const loadId = process.argv[2];
if (!loadId) throw new Error("usage: approve:load <loadId>");
const approvalId = `appr-${randomBytes(6).toString("hex")}`;
await DynamoDBDocumentClient.from(new DynamoDBClient({})).send(
  new PutCommand({
    TableName: outputs.TableName,
    Item: { pk: `LOAD#${loadId}`, sk: "APPROVAL", approvalId, approvedAt: new Date().toISOString(), approver: "operator-cli-test" },
    ConditionExpression: "attribute_not_exists(pk)",
  }),
);
console.log(`approved ${loadId} as ${approvalId} (approver: operator-cli-test)`);
