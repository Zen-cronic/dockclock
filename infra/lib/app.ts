import { App, Tags } from "aws-cdk-lib";
import type { DockClockConfig } from "./config.js";
import { CoreStack } from "./core-stack.js";
import { MessagingStack } from "./messaging-stack.js";

export function buildApp(config: DockClockConfig, app = new App()) {
  const env = { account: config.account, region: config.region };
  const core = new CoreStack(app, "DockClockCore", { env });
  const messaging = new MessagingStack(app, "DockClockMessaging", { env, config, core });
  Tags.of(app).add("project", "dockclock");
  return { app, core, messaging };
}
