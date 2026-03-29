# Multi-Agent Orchestration

groundctl was designed from day one for the world where you run N Claude Code sessions in parallel on the same product.

## The problem without groundctl

Without shared state:
- Agent 1 builds `markets-uk`
- Agent 2 also starts `markets-uk` (didn't know)
- Conflict in git, duplicate work, diverged implementations
- No way to know what's left without reading all N transcripts

## The solution: shared SQLite + claiming

All agents read and write the same `.groundctl/db.sqlite`.

```
Agent 1: groundctl claim "markets-uk"  → reserved
Agent 2: groundctl claim "markets-de"  → reserved
Agent 3: groundctl claim "markets-uk"  → BLOCKED, take markets-fr instead
```

## Setup for parallel agents

```bash
# 1. Initialize once
cd your-project
groundctl init
groundctl add feature -n "markets-uk" -p high
groundctl add feature -n "markets-de" -p high
groundctl add feature -n "markets-fr" -p high
groundctl add feature -n "markets-nl" -p high

# 2. Launch agents in separate terminals
# Each agent:
#   - reads PROJECT_STATE.md (pre-session hook)
#   - claims a feature
#   - builds it
#   - completes it
#   - writes back via post-session hook
```

## Headless agents (no human in the loop)

For fully autonomous runs, give each agent a startup script:

```bash
#!/bin/bash
# agent-startup.sh

# Read current state
groundctl sync
cat PROJECT_STATE.md
cat AGENTS.md

# Claim next available feature
NEXT=$(groundctl next --json | jq -r '.[0].id')
if [ -z "$NEXT" ]; then
  echo "No features available. Exiting."
  exit 0
fi

groundctl claim "$NEXT" --session "$SESSION_ID"
echo "Starting work on: $NEXT"
```

Then at session end:

```bash
groundctl complete "$NEXT"
groundctl ingest --no-sync
groundctl sync
```

## PROJECT_STATE.md as agent context

The file `PROJECT_STATE.md` is generated from SQLite and tells agents:

```markdown
# myapp — Product State
Last updated: 2026-03-29 | Last session: S5 | Progress: 60%

## What's been built
- user-auth (completed 2026-03-28)
- dashboard (completed 2026-03-28)

## Currently claimed
- markets-uk → session agent-1 (started 14:23)
- markets-de → session agent-2 (started 14:25)

## Available next
- markets-fr (priority: high)
- markets-nl (priority: high)
- stripe-integration (priority: medium)

## Decisions made
- S3: Chose Stripe over Paddle — better EU coverage
- S4: Used Railway over Fly.io — simpler for solo builder
```

Every agent reads this on startup. No duplicate context-passing needed.

## Dependency ordering (coming in groundctl 0.2)

The SQLite schema already has a `feature_dependencies` table. In the next release, `groundctl next` will use the DAG to only surface features whose dependencies are complete.

```bash
# Today
groundctl next
# → markets-fr (high)

# 0.2.x: respects deps
# → payment-integration (high) — blocked: waiting on user-auth ✓, stripe-integration ✗
```

## Anti-patterns to avoid

**Don't share a single PROJECT_STATE.md as the source of truth** — it's a generated artifact. SQLite is the source of truth. Two agents writing to the same markdown file will corrupt it.

**Don't run agents without claiming** — they'll overlap on features. Always `groundctl claim` before starting.

**Don't leave claims open indefinitely** — stale claims block other agents. `groundctl health` reports them.

## Tips

- Use meaningful session IDs: `groundctl claim "feat" --session agent-markets-uk-2026-03-29`
- Run `groundctl status` in a separate terminal to monitor all agents live
- Or use `groundctl dashboard` for a real-time web view at port 4242
- After a batch run: `groundctl report --all` generates a full session history
