# Hooks — Automatic Session Tracking

groundctl installs hooks that run automatically before and after each Claude Code / Codex CLI session.

## How hooks work

`groundctl init` copies hook scripts into your project:

```
.claude/hooks/pre-session.sh   ← runs before Claude Code starts
.claude/hooks/post-session.sh  ← runs after Claude Code finishes
.codex/hooks/pre-session.sh    ← same for Codex CLI
.codex/hooks/post-session.sh
```

Claude Code and Codex CLI execute these automatically — no manual setup needed.

## Pre-session hook

```bash
#!/bin/bash
groundctl sync 2>/dev/null
if [ -f PROJECT_STATE.md ]; then
  cat PROJECT_STATE.md   # agent reads the product state
fi
if [ -f AGENTS.md ]; then
  cat AGENTS.md          # agent reads instructions
fi
```

The agent sees the current product state before writing a single line of code.

## Post-session hook

```bash
#!/bin/bash
groundctl ingest \
  --source claude-code \
  ${CLAUDE_SESSION_ID:+--session-id "$CLAUDE_SESSION_ID"} \
  ${CLAUDE_TRANSCRIPT_PATH:+--transcript "$CLAUDE_TRANSCRIPT_PATH"} \
  --project-path "$PWD"
groundctl sync
```

Claude Code sets `$CLAUDE_SESSION_ID` and `$CLAUDE_TRANSCRIPT_PATH` automatically.

## What `groundctl ingest` extracts

The transcript is a JSONL file (`~/.claude/projects/<project>/session-id.jsonl`).

Each line is a message: assistant tool calls, tool results, text responses.

groundctl extracts:

| Signal | Source | How |
|--------|--------|-----|
| Files created | `Write` tool calls | `input.file_path` |
| Files modified | `Edit` tool calls | `input.file_path` |
| Files deleted | `Bash` calls with `rm` | regex on command |
| Git commits | `Bash` calls with `git commit` | extract `-m` message |
| Decisions | Assistant text | regex patterns (see below) |
| Session summary | Last assistant text block | first meaningful line |

## Decision detection

groundctl looks for these patterns in assistant text:

- `"I decided..."`, `"going with..."`, `"chose X over Y"`
- `"tradeoff:"`, `"decision:"`, `"rationale:"`
- `"because ..."` (with surrounding context)

Low-confidence decisions (short text, no rationale) are stored with `confidence: "low"` — visible in `groundctl report`.

The parser is intentionally best-effort. It's offline-first with zero latency — no LLM call. For V1 this is good enough. Future versions may offer an opt-in LLM pass for better accuracy.

## Manual ingest

If the hook didn't run (or you want to re-parse):

```bash
# Auto-detect latest transcript for current project
groundctl ingest

# Explicit transcript path
groundctl ingest --transcript ~/.claude/projects/-Users-you-myapp/session-id.jsonl

# Without syncing markdown (faster, sync separately)
groundctl ingest --no-sync
groundctl sync
```

## Customizing hooks

The hooks in `.claude/hooks/` are yours — edit them freely.

Example: add a Slack notification after session:

```bash
#!/bin/bash
groundctl ingest --source claude-code --no-sync 2>/dev/null || true
groundctl sync 2>/dev/null || true

# Notify Slack
STATUS=$(groundctl status --json 2>/dev/null || echo "{}")
curl -s -X POST "$SLACK_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"Session complete. $(echo $STATUS | jq -r .summary)\"}"
```

## Codex CLI hooks

Works identically. groundctl looks for `$CODEX_SESSION_ID` and `$CODEX_TRANSCRIPT_PATH` (set by Codex CLI on session end).
