# Show HN: groundctl – run multiple AI agents without losing track (MIT)

**Title:** Show HN: groundctl – run multiple AI agents without losing track of what's being built (MIT)

**URL:** https://groundctl.org

---

## Post text

You can run 5 Claude Code agents in parallel.
But you can't keep track of what they're doing.

I tried. Building evspec.io — a European EV specs API —
across 7 sessions with Claude Code, I kept losing the
thread. What was built? What was left? What should each
agent do next?

Jira and Linear assume a human is tracking everything.
They don't know about sessions, parallel agents, or
transcript history.

So I built groundctl — and used it to build itself.

The core loop is 3 commands:

  groundctl claim "markets-de"    # agent reserves work
  groundctl complete "markets-de" # marks it done
  groundctl next                  # what to build next

The killer feature: groundctl watch runs as a background
daemon. After every Claude Code session, it auto-ingests
the transcript — files touched, commits, decisions — and
updates shared state. The next agent reads it and knows
exactly where to start. Zero manual steps.

The problem is not that AI agents are weak.
It's that humans can't track them when they scale.

That's what groundctl solves.

groundctl works alongside your orchestrator.
Use Conductor or Claude Code Agent Teams to run agents —
use groundctl to know what they should build.

  groundctl export --conductor
  → exports your product plan as Conductor tasks
  → each agent reads PROJECT_STATE.md on startup
  → no more 'what should I build?' at session start

Install:
  npm install -g @groundctl/cli
  cd your-project
  groundctl init

Repo: github.com/patrickjoubert/groundctl
Site: groundctl.org

---

## Timing

Post Tuesday or Wednesday 9:00 AM PT
Reply to every comment within 2 hours

---

## Prepared objections

**Q: "Just use git"**
A: git tracks code changes.
   groundctl tracks what's being built, what's done,
   and what to build next — across parallel agents.
   Different problem.

**Q: "Claude Code already has memory"**
A: Claude Code context resets every session.
   groundctl is persistent across sessions, agents,
   and machines. It's the shared state layer that
   Claude Code doesn't have.

**Q: "This is just a task manager"**
A: Task managers are for humans.
   groundctl is designed for agents to read and write.
   claim/complete/next is a machine-readable protocol,
   not a UI for humans to click through.

**Q: "Too many commands"**
A: Core loop is 3 commands: claim, complete, next.
   Everything else is optional.

**Q: "Requires Anthropic API key"**
A: No. detect.groundctl.org proxies feature detection.
   Zero config. Your code never leaves your machine.

**Q: "Will this work with Cursor/Windsurf?"**
A: Codex CLI hooks ship today.
   Cursor/Windsurf on the roadmap.

**Q: "What about teams / multi-machine?"**
A: v1 is optimized for solo builders and vibe coders.
   Multi-machine sync is on the roadmap.
   SQLite WAL handles concurrent local writes safely.

**Q: "Is this just vibe coding tooling?"**
A: It started there. But the core problem —
   humans can't track agents when they scale —
   applies to any agentic workflow. Solo today,
   teams and CI/CD tomorrow.
