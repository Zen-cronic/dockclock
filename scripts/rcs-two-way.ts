// Turns on two-way messaging for the existing RCS agent, pointing it at the topic, roles and media
// bucket the DockClockMessaging stack created. Idempotent; prints the agent's two-way settings.
//   npm run rcs:two-way
import { readFileSync } from "node:fs";
import { DescribeRcsAgentsCommand, PinpointSMSVoiceV2Client, UpdateRcsAgentCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const out = (key: string) => {
  const value = outputs[key];
  if (!value) throw new Error(`missing output ${key}; deploy with DOCKCLOCK_RCS_AGENT_ID set`);
  return value;
};
const agentId = process.env.DOCKCLOCK_RCS_AGENT_ID;
if (!agentId) throw new Error("DOCKCLOCK_RCS_AGENT_ID is empty");

const sms = new PinpointSMSVoiceV2Client({});
await sms.send(
  new UpdateRcsAgentCommand({
    RcsAgentId: agentId,
    TwoWayEnabled: true,
    TwoWayChannelArn: out("RcsTopicArn"),
    TwoWayChannelRole: out("RcsTwoWayRoleArn"),
  }),
);
// Media storage needs two-way already on, so it is a second call.
await sms.send(
  new UpdateRcsAgentCommand({
    RcsAgentId: agentId,
    TwoWayMediaS3BucketName: out("RcsMediaBucket"),
    TwoWayMediaS3KeyPrefix: out("RcsMediaPrefix"),
    TwoWayMediaS3Role: out("RcsMediaRoleArn"),
  }),
);
const agent = (await sms.send(new DescribeRcsAgentsCommand({ RcsAgentIds: [agentId] }))).RcsAgents?.[0];
const shown = Object.fromEntries(Object.entries(agent ?? {}).filter(([key]) => key.startsWith("TwoWay") || key === "Status" || key === "RcsAgentId"));
console.log(JSON.stringify(shown, null, 2));
