import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to their TypeScript source, so tests never run against stale dist/.
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/test/**/*.test.ts", "infra/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
