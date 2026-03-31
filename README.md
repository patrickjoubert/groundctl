# groundctl

> Always know what to build next.

---

## The problem

You can run 5 AI agents in parallel.
But you can't keep track of what they're doing.

When you scale agents:
- work overlaps
- progress is unclear
- next steps are guesswork
- mental load explodes

---

## The solution

groundctl is a local execution layer that keeps your
product on track while multiple AI agents build it.

It shows what's being built, what's done, and what to
do next — so you can move fast without losing control.

---

## Core loop

```bash
# Agent 1 takes a work unit
groundctl claim "auth-system"

# Agent 2 takes another — in parallel
groundctl claim "api-v2"

# No overlap. No confusion.

# What should happen next?
groundctl next
→ markets-de (high priority, no blocking deps)

# Agent 1 is done
groundctl complete "auth-system"
→ released — ready for next agent
```

---

## Install

```bash
npm install -g @groundctl/cli
cd your-project
groundctl init
```

That's it. `groundctl watch` starts automatically.
After every Claude Code session, it ingests the
transcript and updates shared state. Zero manual steps.

---

## How it works

groundctl gives agents a shared execution layer:

| Step | Command | What it does |
|------|---------|--------------|
| Reserve | `groundctl claim <work>` | Agent takes ownership |
| Finish | `groundctl complete <work>` | Marks done, releases |
| Orient | `groundctl next` | What to build next |

Setup commands:

```bash
groundctl init              # setup your project
groundctl status            # product overview
groundctl plan "goal"       # AI-powered work planning
groundctl dashboard         # visual cockpit at :4242
```

---

## groundctl watch

The daemon that makes everything automatic.

```bash
# Runs in background after groundctl init
# After every Claude Code session:
✓ Ingests transcript → files, commits, decisions
✓ Updates shared state
✓ Regenerates PROJECT_STATE.md + AGENTS.md
✓ Next agent reads it — knows exactly where to start
```

Zero manual steps. Always in sync.

---

## Dashboard

```bash
groundctl dashboard
# Opens http://localhost:4242
```

Three views — **LE PLAN** (full product map, feature cards by group), **LE CHANTIER** (active agents, what's ready to launch, what's blocked), **LES CORPS DE MÉTIER** (per-group progress with parallel run detection).

---

## Works with your orchestrator

groundctl tells your agents what to build.
Your orchestrator runs them.

```bash
groundctl export --conductor
→ .conductor/tasks.md — ready to import

groundctl export --agent-teams
→ .claude/tasks/groundctl-export.json
```

Compatible with Conductor, Claude Code Agent Teams,
and any tool that reads task lists.

> "Conductor runs your agents.
>  groundctl tells them what to build."

---

## Works with

- **Claude Code** — hooks installed automatically
- **Codex CLI** — hooks included
- **Conductor** — `groundctl export --conductor`
- **Claude Code Agent Teams** — `groundctl export --agent-teams`
- **Any agent** — CLI is agent-agnostic

---

## Philosophy

The problem is not that AI agents are weak.
It's that humans can't track them when they scale.

That's what groundctl solves.

- **Local-first** — SQLite, no cloud required
- **Agent-native** — designed for LLMs to read and write
- **Zero overhead** — watch daemon, no manual tracking
- **Open source** — MIT, forever free

---

## Meta

groundctl was built using groundctl.
18 sessions · 29 features · 100% implemented

View [PROJECT_STATE.md](PROJECT_STATE.md) to see exactly how it was built.

---

MIT License · [groundctl.org](https://groundctl.org)

Created by [Patrick Joubert](https://github.com/patrickjoubert),
co-founder of [Rippletide](https://rippletide.com).

---

## Keywords

AI agent coordination · parallel agents · Claude Code ·
vibe coding · agent orchestration · product tracking ·
execution layer · multi-agent systems · groundctl

## Related

- [Rippletide](https://rippletide.com) — decision enforcement
  for AI agents in enterprise
- [evspec.io](https://evspec.io) — built using groundctl
