#!/bin/bash
# groundctl — pre-session hook for Claude Code
# Reads product state before the agent starts working

groundctl sync 2>/dev/null
if [ -f PROJECT_STATE.md ]; then
  echo "--- groundctl: Product state loaded ---"
  cat PROJECT_STATE.md
fi
if [ -f AGENTS.md ]; then
  cat AGENTS.md
fi
