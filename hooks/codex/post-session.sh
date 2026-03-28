#!/bin/bash
# groundctl — post-session hook for Codex CLI
set -euo pipefail

if ! command -v groundctl &>/dev/null; then
  exit 0
fi

groundctl sync 2>/dev/null || true
