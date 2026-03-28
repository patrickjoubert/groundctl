#!/bin/bash
# groundctl — post-session hook for Claude Code
# Install: cp hooks/claude-code/*.sh .claude/hooks/
#
# This hook runs after each Claude Code session.
# It parses the transcript, writes to SQLite, and regenerates state files.

set -euo pipefail

if ! command -v groundctl &>/dev/null; then
  exit 0
fi

# Ingest the transcript (auto-discovers latest transcript for this project)
groundctl ingest \
  --source claude-code \
  ${CLAUDE_SESSION_ID:+--session-id "$CLAUDE_SESSION_ID"} \
  ${CLAUDE_TRANSCRIPT_PATH:+--transcript "$CLAUDE_TRANSCRIPT_PATH"} \
  --project-path "$PWD" \
  --no-sync 2>/dev/null || true

# Always sync state files
groundctl sync 2>/dev/null || true

echo "--- groundctl: Product state updated ---"
