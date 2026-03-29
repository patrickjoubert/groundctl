# Show HN: groundctl – Always know what to build next (MIT)

**Title:** Show HN: groundctl – Always know what to build next (MIT)

**URL:** https://groundctl.org

---

## Body

I built an EV specs API (evspec.io) using only Claude Code
across 7 sessions. After session 3, I had no idea what had
been built, what was left, or why certain decisions were made.

Jira assumes a human is tracking everything.
It doesn't know about sessions, transcripts, or parallel agents.

So I built groundctl — and used it to build itself.

    $ groundctl status --detail

    groundctl — 100% implemented (11 sessions)

    Features  ████████████████████  21/21 done

    CORE CLI        ████████████████████  done
      foundation    ██████████████  5/5   CLI skeleton, Commander.js
      cli-commands  ██████████████  11/11 init · status · claim · complete · next
                                          sync · log · report · health · ingest · watch

    INTELLIGENCE    ████████████████████  done
      auto-detect   ██████████████  5/5   detects features from git via Claude haiku
      watch         ██████████████  5/5   daemon auto-ingests sessions, zero steps

    OBSERVABILITY   ████████████████████  done
      dashboard     ██████████████  5/5   web UI port 4242, auto-refresh 10s

    DISTRIBUTION    ████████████████████  done
      groundctl.org · @groundctl/cli · MIT License

The killer feature: groundctl watch runs as a background daemon.
After every Claude Code session, it automatically ingests the
transcript — files touched, commits, decisions — and regenerates
PROJECT_STATE.md and AGENTS.md.

The next agent reads them and knows exactly where to start.
Zero manual steps. Always in sync.

No Anthropic API key required. detect.groundctl.org handles
feature detection — your project context never leaves your machine
except for the feature names.

Install:
    npm install -g @groundctl/cli
    cd your-project
    groundctl init

Repo: github.com/patrickjoubert/groundctl
Site: groundctl.org

---

## Notes (not for posting)

**When to post:** Tuesday or Wednesday 9am PT for best HN traffic

**Reply strategy — first 2 hours:**
- Reply to every comment
- Lead with the "built itself using itself" angle early
- Acknowledge the sql.js limitation proactively

**Expected objections:**

**"Just use a CHANGELOG"**
→ CHANGELOG is written by humans after the fact.
  groundctl captures what actually happened, automatically,
  from Claude Code transcripts.

**"Claude Code already has memory"**
→ Claude Code context resets every session.
  groundctl gives persistent product state across sessions,
  agents, and machines.

**"This is just a wrapper around git log"**
→ git log tells you what changed.
  groundctl tells you what's built, what's left,
  and what to build next — with feature groups,
  progress tracking, and agent-readable state.

**"Requires Anthropic API key"**
→ No. detect.groundctl.org proxies the detection.
  Zero config. Cloudflare edge, your key is never exposed.

**"Will this work with Cursor/Windsurf/Codex?"**
→ Codex hooks ship with groundctl today.
  Cursor and Windsurf support is on the roadmap.

**"What about privacy?"**
→ Everything is local by default. SQLite in .groundctl/.
  Only feature detection calls detect.groundctl.org —
  and only with git log + file tree, never your code.

**"SQLite won't scale to a team"**
→ Correct. Local-first is intentional — zero setup, zero cloud dependency.
  Team sync (Litestream replication) is on the roadmap.
  For now: one developer, one machine, multiple agents. That's the target user.

**"sql.js is slow"**
→ Acknowledged. better-sqlite3 is 10x faster but doesn't compile on Node 25.
  Will switch when prebuilds ship. For a CLI tool reading <1000 rows, sql.js
  is fast enough.

**"How is this different from a todo list?"**
→ It's machine-writable. The agent reads AND writes it.
  A todo list can't tell you which agent is working on which feature right now,
  or block a second agent from starting the same work.
