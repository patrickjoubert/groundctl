# Getting Started with groundctl

## Install

```bash
npm install -g @groundctl/cli
```

Requires Node.js 18+.

## Initialize your project

```bash
cd your-project
groundctl init
```

This creates:
- `.groundctl/db.sqlite` — local SQLite database (per-project, gitignored)
- `.claude/hooks/pre-session.sh` — reads state before Claude Code starts
- `.claude/hooks/post-session.sh` — parses transcript and updates state after session
- `.codex/hooks/` — same for Codex CLI
- `PROJECT_STATE.md` — human + agent readable state (gitignored, auto-generated)
- `AGENTS.md` — instructions for the next agent (gitignored, auto-generated)

## Bootstrap from existing git history

Already have a project with commits? Import the history:

```bash
groundctl init --import-from-git
```

This reads your git log, groups commits into sessions (4h gap = new session), and populates the database. If you have a `PROJECT_STATE.md` already, it imports features from it too.

## Add your first features

```bash
groundctl add feature -n "user-auth" -p high -d "JWT-based auth, login/logout endpoints"
groundctl add feature -n "dashboard" -p medium
groundctl add feature -n "stripe-integration" -p high
```

Priority: `critical`, `high`, `medium`, `low`

## Check your product state

```bash
groundctl status
```

```
myapp — 33% implemented (2 sessions)

Features  ███████░░░░░░░░░░░░░  1/3 done

Available:
  ○ dashboard (medium)
  ○ stripe-integration (high)
```

## Start a session

```bash
# See what to work on next
groundctl next

# Claim a feature
groundctl claim "dashboard"
# → reserves "dashboard" in SQLite so parallel agents don't duplicate work
```

Now start Claude Code. The pre-session hook reads `PROJECT_STATE.md` automatically.

## End a session

When Claude Code finishes, the post-session hook runs automatically:
1. Parses the session transcript
2. Extracts files modified, commits, decisions
3. Writes to SQLite
4. Regenerates `PROJECT_STATE.md` and `AGENTS.md`

Or manually:
```bash
groundctl complete "dashboard"
groundctl sync
groundctl report
```

## Check health

```bash
groundctl health
```

```
myapp — Health Score: 62/100

✅ Features    2/3 complete  (67%)  +27pts
⚠️  Tests       0 test files  (-20pts)
✅ Decisions   3 documented  +15pts
✅ Claims      0 stale  +10pts
⚠️  Deploy      not detected  +0pts

Recommendations:
  → Write tests before your next feature.
```

## View the web dashboard

```bash
groundctl dashboard
# Opens http://localhost:4242
```

Auto-refreshes every 10 seconds. Shows claims live, feature status, session timeline, health breakdown.

## Next steps

- [Hooks deep-dive](hooks.md) — how transcript parsing works
- [Claiming system](claiming.md) — coordinate parallel agents
- [Multi-agent guide](multi-agent.md) — run N agents in parallel
