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

echo "[3/3] Organizing build artifacts and resources into appbuilds/..."
mkdir -p appbuilds/macos
mkdir -p appbuilds/windows

# Copy macOS artifacts
if [ -d "src-tauri/target/release/bundle/dmg" ]; then
  cp src-tauri/target/release/bundle/dmg/*.dmg appbuilds/macos/ 2>/dev/null || true
fi
if [ -d "src-tauri/target/release/bundle/macos" ]; then
  cp -R src-tauri/target/release/bundle/macos/*.app appbuilds/macos/ 2>/dev/null || true
fi

# Ensure server and web assets are inside the application bundle
APP_RES="appbuilds/macos/Orlablocks.app/Contents/Resources"
if [ -d "$APP_RES" ]; then
  echo "Injecting dist/ assets into $APP_RES..."
  mkdir -p "$APP_RES/dist"
  cp -R dist/server "$APP_RES/dist/"
  cp -R dist/web "$APP_RES/dist/"

  # Embed Node.js binary into the app bundle for zero-dev-tools independence
  NODE_BIN="$(which node 2>/dev/null || true)"
  if [ -n "$NODE_BIN" ] && [ -f "$NODE_BIN" ]; then
    echo "Embedding Node.js binary ($NODE_BIN) into bundle..."
    cp "$NODE_BIN" "$APP_RES/node"
    chmod +x "$APP_RES/node"
  fi
fi

echo "Build complete! Artifacts located in appbuilds/macos/:"
ls -lh appbuilds/macos/ 2>/dev/null || true
