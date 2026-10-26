import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The read-API Lambda is bundled from services/, so a value imported from site/src would pull the
// browser's code into the backend. The API contract's types may come from site/src/api.ts (they are
// erased at build); any value the two share lives in a package.
const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "test") return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? sources(path) : /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe("services and the site's source", () => {
  it("imports nothing but types from site/src", () => {
    const files = sources(root);
    expect(files.length).toBeGreaterThan(10);
    const values = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]*site\/src\/[^"]*)"/gms)].map((m) => `${file.slice(root.length)}: ${m[1]}`);
    });
    expect(values).toEqual([]);
  });
});
