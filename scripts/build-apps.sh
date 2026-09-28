#!/usr/bin/env bash
set -e

# Orlablocks Desktop Build Pipeline
# Outputs packaged applications to appbuilds/macos/ and appbuilds/windows/

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=========================================="
echo "  Orlablocks Packaging Pipeline           "
echo "=========================================="

echo "[1/3] Building Web, Server, and Control Panel assets..."
npm run build

echo "[2/3] Building Native Desktop App with Tauri..."
npx tauri build

echo "[3/3] Organizing build artifacts into appbuilds/..."
mkdir -p appbuilds/macos
mkdir -p appbuilds/windows

# Copy macOS artifacts
if [ -d "src-tauri/target/release/bundle/dmg" ]; then
  cp src-tauri/target/release/bundle/dmg/*.dmg appbuilds/macos/ 2>/dev/null || true
fi
if [ -d "src-tauri/target/release/bundle/macos" ]; then
  cp -R src-tauri/target/release/bundle/macos/*.app appbuilds/macos/ 2>/dev/null || true
fi

echo "Build complete! Artifacts located in appbuilds/:"
ls -lh appbuilds/macos/ 2>/dev/null || true
