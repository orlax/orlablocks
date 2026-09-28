// Copies a Node.js binary to src-tauri/binaries/, where the Tauri config bundles it: `node` on macOS (as
// Contents/Resources/node), `node.exe` on Windows (next to the .exe, and in the portable payload). The Control Panel
// runs the server with it, so users need no Node (plans 11 and 11B).
//
// It's this machine's Node. With ORLA_UNIVERSAL_NODE=1 on macOS it's the official arm64 and x64 builds of the same
// version, downloaded from nodejs.org and joined with lipo, for a Universal app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "binaries");
const windows = process.platform === "win32";
const out = path.join(outDir, windows ? "node.exe" : "node");
fs.mkdirSync(outDir, { recursive: true });

if (process.platform === "darwin" && process.env.ORLA_UNIVERSAL_NODE === "1") {
  const version = process.version;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "orla-node-"));
  const slices = [];
  for (const arch of ["arm64", "x64"]) {
    const name = `node-${version}-darwin-${arch}`;
    const url = `https://nodejs.org/dist/${version}/${name}.tar.gz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Downloading ${url}: ${response.status}`);
    const tarball = path.join(work, `${name}.tar.gz`);
    fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
    execFileSync("tar", ["-xzf", tarball, "-C", work, `${name}/bin/node`]);
    slices.push(path.join(work, name, "bin", "node"));
  }
  execFileSync("lipo", ["-create", ...slices, "-output", out]);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Staged universal Node.js ${version} (${execFileSync("lipo", ["-archs", out]).toString().trim()})`);
} else {
  fs.copyFileSync(process.execPath, out);
  console.log(`Staged Node.js ${process.version} (${process.arch}) from ${process.execPath}`);
}
if (!windows) fs.chmodSync(out, 0o755);
