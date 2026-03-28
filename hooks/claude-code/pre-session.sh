#!/bin/bash
# groundctl — pre-session hook for Claude Code
# Install: cp hooks/claude-code/*.sh .claude/hooks/
#
# This hook runs before each Claude Code session.
# It regenerates state files from SQLite so the agent
# starts with fresh product context.

set -euo pipefail

if ! command -v groundctl &>/dev/null; then
  echo "[groundctl] CLI not found. Install: npm install -g @groundctl/cli"
  exit 0
fi

groundctl sync 2>/dev/null || true

echo "--- groundctl: Product state loaded ---"

if [ -f PROJECT_STATE.md ]; then
  cat PROJECT_STATE.md
fi

if [ -f AGENTS.md ]; then
  cat AGENTS.md
fi
