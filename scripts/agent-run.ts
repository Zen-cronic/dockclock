// Runs the deployed claims agent on one load. Usage: npm run agent:run -- <loadId> review|file_claim
import { readFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockAgent as Record<string, string>;
const [loadId, task = "review"] = process.argv.slice(2);
if (!loadId || !["review", "file_claim"].includes(task)) throw new Error("usage: agent:run <loadId> review|file_claim");
const started = Date.now();
const result = await new LambdaClient({}).send(
  new InvokeCommand({ FunctionName: outputs.InvokeAgentFunction, Payload: Buffer.from(JSON.stringify({ loadId, task })) }),
);
const payload = JSON.parse(Buffer.from(result.Payload ?? []).toString()) as { text?: string; stopReason?: string; toolCalls?: Array<{ name: string; input: string }>; errorMessage?: string };
if (result.FunctionError) throw new Error(payload.errorMessage ?? "agent invocation failed");
console.log(`agent ${task} on ${loadId}: stop=${payload.stopReason} in ${Math.round((Date.now() - started) / 1000)} s`);
for (const call of payload.toolCalls ?? []) console.log(`  tool ${call.name} ${call.input.slice(0, 160)}`);
console.log(`\n${payload.text}`);
