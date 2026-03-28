#!/bin/bash
# groundctl — pre-session hook for Codex CLI
set -euo pipefail

if ! command -v groundctl &>/dev/null; then
  echo "[groundctl] CLI not found. Install: npm install -g @groundctl/cli"
  exit 0
fi

groundctl sync 2>/dev/null || true

if [ -f PROJECT_STATE.md ]; then
  cat PROJECT_STATE.md
fi
