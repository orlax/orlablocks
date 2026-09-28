import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "src/control-panel"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist/control-panel"),
    emptyOutDir: true,
  },
});
