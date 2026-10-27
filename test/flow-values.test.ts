import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A release Flow's in_time and out_time are values the service compares, so they come from
// localClockOf (null for a time that does not parse), never from isoToLocalClock, whose "--:--" is
// for a person to read. The smoke scripts sent the display placeholder as a form value.
const root = fileURLToPath(new URL("..", import.meta.url));

describe("Flow form values", () => {
  it("are never the display clock's placeholder", () => {
    const files = ["scripts", join("services", "src")].flatMap((dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)));
    expect(files.length).toBeGreaterThan(10);
    const misuses = files.flatMap((file) => {
      const text = readFileSync(join(root, file), "utf8");
      return [...text.matchAll(/^.*\b(?:in|out)_time\s*:\s*isoToLocalClock\b.*$/gm)].map((m) => `${file}: ${m[0].trim()}`);
    });
    expect(misuses).toEqual([]);
  });
});
