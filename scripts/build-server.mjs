// Bundles the server into dist/server/main.js for the desktop app (plan 11.2). A script rather than esbuild's CLI in
// package.json, so the build runs the same under cmd on Windows (plan 11B), where the CLI's quoted banner breaks.
import { build } from "esbuild";

await build({
  entryPoints: ["src/server/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["vite", "@vitejs/plugin-react"],
  // Bundled CommonJS dependencies still call require().
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  outfile: "dist/server/main.js",
  logLevel: "info",
});
