import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/test/**/*.test.ts", "infra/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
