/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "src/web"),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist/web"),
    emptyOutDir: true,
  },
  // The editor's root is src/web, but the tests are in all of src (server, shared and editor).
  test: {
    root: __dirname,
    include: ["src/**/*.test.ts"],
  },
});
