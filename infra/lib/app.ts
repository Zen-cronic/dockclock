import { App, Tags } from "aws-cdk-lib";
import type { DockClockConfig } from "./config.js";
import { CoreStack } from "./core-stack.js";
import { AgentStack } from "./agent-stack.js";
import { EmailStack } from "./email-stack.js";
import { MessagingStack } from "./messaging-stack.js";

export function buildApp(config: DockClockConfig, app = new App()) {
  const env = { account: config.account, region: config.region };
  const core = new CoreStack(app, "DockClockCore", { env });
  const email = new EmailStack(app, "DockClockEmail", { env });
  const messaging = new MessagingStack(app, "DockClockMessaging", { env, config, core, email });
  const agent = new AgentStack(app, "DockClockAgent", { env, config, core });
  // The lifecycle calls the agent's functions by name, so the agent deploys first.
  messaging.addDependency(agent);
  Tags.of(app).add("project", "dockclock");
  return { app, core, messaging, email, agent };
}
