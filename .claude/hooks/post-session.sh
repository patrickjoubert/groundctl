#!/bin/bash
# groundctl — post-session hook for Claude Code
# Updates product state after the agent finishes

set -euo pipefail

if ! command -v groundctl &>/dev/null; then
  exit 0
fi

groundctl ingest \
  --source claude-code \
  ${CLAUDE_SESSION_ID:+--session-id "$CLAUDE_SESSION_ID"} \
  ${CLAUDE_TRANSCRIPT_PATH:+--transcript "$CLAUDE_TRANSCRIPT_PATH"} \
  --project-path "$PWD" \
  --no-sync 2>/dev/null || true

groundctl sync 2>/dev/null || true
echo "--- groundctl: Product state updated ---"
