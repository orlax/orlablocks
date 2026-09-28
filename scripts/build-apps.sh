#!/usr/bin/env bash
set -e

# Orlablocks Desktop Build Pipeline
# Outputs packaged applications to appbuilds/macos/ and appbuilds/windows/

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=========================================="
echo "  Orlablocks Packaging Pipeline           "
echo "=========================================="

# tauri.conf.json's beforeBuildCommand builds dist/ and stages Node.js, and its bundle.resources puts both into
# Contents/Resources, so the .app and the .dmg made from it are complete.
echo "[1/2] Building the assets and the native desktop app with Tauri..."
npx tauri build

echo "[2/2] Copying the build artifacts into appbuilds/..."
mkdir -p appbuilds/macos
mkdir -p appbuilds/windows
rm -rf appbuilds/macos/Orlablocks.app appbuilds/macos/*.dmg

# Copy macOS artifacts
if [ -d "src-tauri/target/release/bundle/dmg" ]; then
  cp src-tauri/target/release/bundle/dmg/*.dmg appbuilds/macos/ 2>/dev/null || true
fi
if [ -d "src-tauri/target/release/bundle/macos" ]; then
  cp -R src-tauri/target/release/bundle/macos/*.app appbuilds/macos/ 2>/dev/null || true
fi

echo "Build complete! Artifacts located in appbuilds/macos/:"
ls -lh appbuilds/macos/ 2>/dev/null || true
