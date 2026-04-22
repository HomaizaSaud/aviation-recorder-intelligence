#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "[error] Node.js is not installed. Install Node.js 18+ before continuing." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[error] npm is not installed or not on your PATH. Install npm before continuing." >&2
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/^v//')
REQUIRED_MAJOR=18
MAJOR_VERSION=${NODE_VERSION%%.*}

if [ "$MAJOR_VERSION" -lt "$REQUIRED_MAJOR" ]; then
  echo "[error] Detected Node.js v$NODE_VERSION. Please upgrade to Node.js v$REQUIRED_MAJOR or newer." >&2
  exit 1
fi

echo "Installing npm dependencies..."
npm install

echo "Done."
