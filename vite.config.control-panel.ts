import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"));

export default defineConfig({
  root: path.resolve(__dirname, "src/control-panel"),
  plugins: [react()],
  base: "./",
  // The app's version, from package.json, for the footer.
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: path.resolve(__dirname, "dist/control-panel"),
    emptyOutDir: true,
  },
});
