import { cpSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const replayDir = fileURLToPath(new URL("./replay/", import.meta.url));

// Serves and ships site/replay/*.json at ./replay/, so `?replay=<name>` can load an exported load.
function replayFiles(): Plugin {
  return {
    name: "dockclock-replay-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/replay\/([A-Za-z0-9._-]+\.json)$/.exec((req.url ?? "").split("?")[0] ?? "");
        const file = match ? `${replayDir}${match[1]}` : null;
        if (!file || !existsSync(file)) return next();
        res.setHeader("Content-Type", "application/json");
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      cpSync(replayDir, fileURLToPath(new URL("./dist/replay/", import.meta.url)), { recursive: true });
    },
  };
}

// Workspace packages resolve to their TypeScript source (the "source" export condition), so the page
// runs the same clause engine code the workflow runs. The engine's scorecard imports node:crypto for
// one hash; in the browser that resolves to a small pure SHA-256.
export default defineConfig({
  base: "./",
  plugins: [replayFiles()],
  resolve: {
    conditions: ["source", "module", "browser", "development|production"],
    alias: { "node:crypto": fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url)) },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
