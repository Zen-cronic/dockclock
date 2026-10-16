import { createHmac } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Sender } from "@dockclock/whatsapp";
import { env } from "./config.js";

const secrets = new SecretsManagerClient({});
let secret: Promise<string> | undefined;

function hmacKey(): Promise<string> {
  secret ??= secrets
    .send(new GetSecretValueCommand({ SecretId: env.identitySecretArn() }))
    .then((out) => {
      if (!out.SecretString) throw new Error("identity secret is empty");
      return out.SecretString;
    })
    .catch((error: unknown) => {
      secret = undefined;
      throw error;
    });
  return secret;
}

// A stable, non-reversible key for a driver. BSUIDs are already opaque; phone numbers are keyed
// through an HMAC so they never appear in item keys or logs.
export function driverKeyWith(key: string, sender: Sender): string {
  if (sender.kind === "bsuid") return `bsuid:${sender.id}`;
  return `phone:${createHmac("sha256", key).update(sender.e164).digest("hex").slice(0, 32)}`;
}

export async function driverKey(sender: Sender): Promise<string> {
  return driverKeyWith(await hmacKey(), sender);
}
