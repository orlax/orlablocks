#!/usr/bin/env bash
set -e

# Copies this machine's Node.js binary to src-tauri/binaries/node, where tauri.conf.json's bundle.resources
# picks it up as Contents/Resources/node (the Control Panel runs the server with it, so users need no Node).
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
mkdir -p "$ROOT_DIR/src-tauri/binaries"
cp "$NODE_BIN" "$ROOT_DIR/src-tauri/binaries/node"
chmod +x "$ROOT_DIR/src-tauri/binaries/node"
echo "Staged Node.js $(node --version) ($(uname -m)) from $NODE_BIN"
