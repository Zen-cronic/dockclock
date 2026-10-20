import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findLeaks } from "@dockclock/sanitize";
import { describe, expect, it } from "vitest";

// The console builds against site/fixtures/api/, so every fixture must be a valid response of the
// contract (site/src/api.ts) and as clean as the live API's responses.
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "site", "fixtures", "api");

function files(at: string): string[] {
  return readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".json") ? [path] : [];
  });
}

function typeOf(file: string): string | null {
  const name = relative(dir, file).replace(/\\/g, "/");
  if (name === "index.json") return null;
  if (name.startsWith("error-") || name.includes(".error.")) return "ApiError";
  if (name === "overview.json") return "ApiResponse<Overview>";
  if (name === "loads.json") return "ApiResponse<LoadsPage>";
  if (name.startsWith("messages")) return "ApiResponse<MessageFeed>";
  if (name.endsWith(".pack.json")) return "ApiResponse<SignedPackInfo>";
  if (name.includes(".emails.")) return "ApiResponse<EmailView>";
  if (name.startsWith("loads/")) return "ApiResponse<LoadView>";
  throw new Error(`no contract type for fixture ${name}`);
}

describe("API fixtures", () => {
  const all = files(dir);

  it("exist for every route, with RCS, failover, in-progress and photo cases", () => {
    const names = all.map((f) => relative(dir, f));
    for (const needed of ["overview.json", "loads.json", "messages.json", "error-404.json"]) expect(names).toContain(needed);
    const views = all.filter((f) => typeOf(f) === "ApiResponse<LoadView>").map((f) => JSON.parse(readFileSync(f, "utf8")).data);
    expect(views.some((v) => v.summary.channel === "rcs" && v.claim?.status === "sent")).toBe(true);
    expect(views.some((v) => v.summary.failover && v.messages.some((m: { failover?: unknown }) => m.failover))).toBe(true);
    expect(views.some((v) => v.summary.live)).toBe(true);
    expect(views.some((v) => v.photos.some((p: { legible?: boolean }) => p.legible === true))).toBe(true);
    expect(views.some((v) => v.photos.some((p: { legible?: boolean }) => p.legible === false))).toBe(true);
  });

  it("hold nothing the API would refuse to send", () => {
    for (const file of all) expect(findLeaks(JSON.parse(readFileSync(file, "utf8")), "925432502717"), relative(dir, file)).toEqual([]);
  });

  it("type-check against the contract", () => {
    const tmp = mkdtempSync(join(tmpdir(), "api-fixtures-"));
    const contract = join(root, "site", "src", "api").replace(/\\/g, "/");
    const lines = [`import type { ApiError, ApiResponse, EmailView, LoadsPage, LoadView, MessageFeed, Overview, SignedPackInfo } from "${contract}";`];
    all.forEach((file, i) => {
      const type = typeOf(file);
      if (type) lines.push(`export const f${i} = ${readFileSync(file, "utf8").trim()} satisfies ${type};`);
    });
    writeFileSync(join(tmp, "check.ts"), lines.join("\n"));
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "Bundler", strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] }, files: ["check.ts"] }),
    );
    expect(() => execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", join(tmp, "tsconfig.json")], { encoding: "utf8" })).not.toThrow();
  }, 120_000);
});
