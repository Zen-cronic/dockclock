// Builds the private "demo-yard" facility around the pins of a live load the operator ran, and
// writes it to the gitignored .env as DOCKCLOCK_DEMO_FACILITY. Coordinates are never printed.
// Usage: npm run demo:facility -- <loadId> [halfSideMeters]
import { readFileSync, writeFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const [loadId, half = "120"] = process.argv.slice(2);
if (!loadId) throw new Error("usage: demo:facility <loadId> [halfSideMeters]");
const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const load = (await ddb.send(new GetCommand({ TableName: outputs.TableName, Key: { pk: `LOAD#${loadId}`, sk: "META" } }))).Item;
const pins = [load?.arrived, load?.released].filter((p): p is { lat: number; lon: number } => typeof p?.lat === "number");
if (pins.length === 0) throw new Error(`load ${loadId} has no pins`);
const lat = pins.reduce((s, p) => s + p.lat, 0) / pins.length;
const lon = pins.reduce((s, p) => s + p.lon, 0) / pins.length;
const metres = Number(half);
const dLat = metres / 111_320;
const dLon = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
const round = (v: number) => Math.round(v * 1e5) / 1e5;
const facility = {
  id: "demo-yard",
  name: "Demo Yard (operator test site)",
  timeZone: "America/Toronto",
  polygon: [
    [round(lon - dLon), round(lat + dLat)],
    [round(lon + dLon), round(lat + dLat)],
    [round(lon + dLon), round(lat - dLat)],
    [round(lon - dLon), round(lat - dLat)],
  ],
};
const envPath = new URL("../.env", import.meta.url);
const lines = readFileSync(envPath, "utf8").split("\n").filter((l) => l && !l.startsWith("DOCKCLOCK_DEMO_FACILITY="));
lines.push(`DOCKCLOCK_DEMO_FACILITY=${JSON.stringify(facility)}`);
writeFileSync(envPath, `${lines.join("\n")}\n`);
console.log(`wrote demo-yard to .env: ${2 * metres} m square centred on ${pins.length} pin(s) of ${loadId}; coordinates not printed`);
