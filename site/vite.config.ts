import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Workspace packages resolve to their TypeScript source (the "source" export condition), so the
// console runs the same clause engine code the workflow runs. The engine's scorecard imports
// node:crypto for one hash; in the browser that resolves to a small pure SHA-256. JSX is compiled by
// esbuild (React 18 automatic runtime). Routes are client-side, so assets use absolute paths.
export default defineConfig({
  base: "/",
  esbuild: { jsx: "automatic" },
  resolve: {
    conditions: ["source", "module", "browser", "development|production"],
    alias: { "node:crypto": fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url)) },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
