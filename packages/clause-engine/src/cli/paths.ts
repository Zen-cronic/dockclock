import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
export const LOADS_PATH = resolve(root, "fixtures/loads.json");
export const MANIFEST_PATH = resolve(root, "fixtures/MANIFEST.json");
