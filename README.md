# groundctl

> The shared memory your agents and you actually need.

When Claude Code builds your product across sessions, nobody remembers what was built, what's left, or what's in progress. groundctl fixes that — for you and for your agents.

## The problem

- **You** lose track of what was built across sessions
- **Your agents** restart from zero every time — no memory of prior work
- **Multiple agents** can't coordinate — they duplicate work, create conflicts, drift

## What groundctl does

groundctl is persistent product memory — a local SQLite database that tracks features, sessions, claims, and decisions. Both you and your agents read and write to it. No cloud required.

```
┌─────────────────────────────────────────┐
│  SQLite (source of truth)               │
│  → features, sessions, claims, decisions│
├─────────────────────────────────────────┤
│  Markdown (LLM interface)               │
│  → PROJECT_STATE.md, AGENTS.md          │
│  → auto-generated, agents read these    │
├─────────────────────────────────────────┤
│  Claiming system                        │
│  → agents reserve features              │
│  → no conflicts, no duplicated work     │
└─────────────────────────────────────────┘
```

## Install

```bash
npm install -g @groundctl/cli
```

## Quick start

```bash
cd your-project
groundctl init

# Add features to track
groundctl add feature -n "auth-system" -p high
groundctl add feature -n "user-dashboard" -p medium
groundctl add feature -n "api-v2" -p high

# See product state
groundctl status
```

```
  your-project — 0% implemented (0 sessions)

  Features  ░░░░░░░░░░░░░░░░░░░░  0/3 done

  Available:
    ○ auth-system (high)
    ○ api-v2 (high)
    ○ user-dashboard (medium)
```

## Run agents in parallel

```bash
groundctl claim "auth-system"      # Agent 1
groundctl claim "api-v2"           # Agent 2
groundctl claim "user-dashboard"   # Agent 3
# No conflicts. No duplicated work. No drift.

groundctl complete "auth-system"   # Agent 1 done
groundctl status                   # See real-time state
```

## How it works with Claude Code

groundctl installs hooks that run before and after each session:

- **Pre-session**: regenerates `PROJECT_STATE.md` from SQLite — your agent reads it and knows exactly where the product stands
- **Post-session**: updates state after work is done

The agent never starts from zero again.

## Commands

| Command | Description |
|---------|-------------|
| `groundctl init` | Setup hooks + create database |
| `groundctl status` | Macro view of product state |
| `groundctl add feature -n <name> -p <priority>` | Track a new feature |
| `groundctl claim <feature>` | Reserve a feature for your session |
| `groundctl complete <feature>` | Mark feature done, release claim |
| `groundctl next` | Show next available feature |
| `groundctl sync` | Regenerate markdown from SQLite |
| `groundctl log` | Session timeline |

## Claiming system

The claiming system is what makes multi-agent coordination possible:

```bash
# Agent 1 starts working
$ groundctl claim "markets-uk"
  ✓ Claimed "markets-uk" → session a1b2c3d4

# Agent 2 tries the same feature
$ groundctl claim "markets-uk"
  Feature "markets-uk" is already claimed by session a1b2c3d4

  Available instead:
    ○ markets-de
    ○ markets-fr
```

No race conditions. No duplicated work. SQLite WAL mode handles concurrent writes safely.

## Works with

- **Claude Code** — hooks installed automatically via `groundctl init`
- **Codex CLI** — hooks included
- **Any agent** — CLI is agent-agnostic, any tool that can run shell commands works

## Philosophy

- **SQLite is the source of truth** — markdown and JSON are generated outputs
- **Local-first** — works offline, no cloud required, your data stays on your machine
- **Zero overhead** — hooks run automatically, no manual tracking
- **Agent-native** — designed for LLMs to read and write, not just humans

## Meta

groundctl was built using groundctl.

Sessions S1–S∞ tracked in [PROJECT_STATE.md](PROJECT_STATE.md).

```bash
$ groundctl status  # run in this repo

  groundctl — 60% implemented (2 sessions)

  Features  ████████████░░░░░░░░  6/10 done

  Available:
    ○ npm-publish (high)
    ○ show-hn-launch (high)
    ○ dashboard (medium)
```

## License

MIT

---

Created by [Patrick Joubert](https://github.com/patrickjoubert), co-founder of Rippletide.
