# Show HN: groundctl – product memory for AI agent builders (MIT)

**Title:** Show HN: groundctl – product memory for AI agent builders (MIT)

**URL:** https://groundctl.org

---

## Body

I've been building evspec.io (EV specs API for Europe) using only
Claude Code over 7 sessions. After session 4, I had no idea what
had been built, what was left, or what decisions had been made.

Jira and Linear assume a human is tracking everything. They don't
know about sessions, transcripts, or parallel agents.

So I built groundctl — a CLI that gives Claude Code (and Codex)
a persistent product memory:

    $ groundctl status        → where is my product right now
    $ groundctl claim <feat>  → reserve a feature for this session
    $ groundctl next          → what should the agent build next
    $ groundctl health        → quality score + accumulated debt
    $ groundctl dashboard     → web view at port 4242

The interesting part: it parses Claude Code transcripts
automatically after each session — files touched, commits,
decisions made — and writes them to a local SQLite db.
Then generates PROJECT_STATE.md and AGENTS.md that the next
agent reads at session start.

The meta part: groundctl was built using groundctl.
S1–S4 tracked in its own PROJECT_STATE.md.
Current state: 14/15 features done (93%).

Install: npm install -g @groundctl/cli
Repo: github.com/patrickjoubert/groundctl
Docs: groundctl.org

Would love feedback on:
- The transcript parsing heuristics (regex today, wondering about LLM pass)
- The claiming system design for distributed teams (SQLite works locally, thinking about sync for team use)
- Whether the health score metrics are the right ones

---

## Notes (not for posting)

**When to post:** Tuesday or Wednesday 9am PT for best HN traffic

**Reply strategy — first 2 hours:**
- Reply to every comment
- Lead with the "built itself using itself" angle early
- Acknowledge the sql.js limitation proactively

**Expected objections:**

**"Why not just use a CLAUDE.md file?"**
→ CLAUDE.md is static — you write it, it doesn't update. groundctl is live state
  written automatically after every session. The agent updates it, not you.
  Also: claiming system, multi-agent coordination, health score — none of that
  fits in a static file.

**"How is this different from a todo list?"**
→ It's machine-writable. The agent reads AND writes it.
  A todo list can't tell you which agent is working on which feature right now,
  or block a second agent from starting the same work.

**"SQLite won't scale to a team"**
→ Correct. Local-first is intentional — zero setup, zero cloud dependency.
  Team sync (SQLite on a shared volume or Litestream replication) is on the roadmap.
  For now: one developer, one machine, multiple agents. That's the target user.

**"sql.js is slow"**
→ Acknowledged. better-sqlite3 is 10x faster but doesn't compile on Node 25.
  Will switch when prebuilds ship. For a CLI tool reading <1000 rows, sql.js
  is fast enough.

**"Why not just read git log?"**
→ Git tells you what changed. groundctl tells you what's left to build,
  who's working on what right now, and what decisions were made and why.
  groundctl uses git log for import but the live claiming system and
  decision tracking are what git can't give you.

**"LLM call for decisions instead of regex?"**
→ This is genuinely interesting. Regex is offline, instant, free.
  An LLM pass would be slower and add a dependency but would catch more nuance.
  Plan: make it opt-in with --enrich flag in a future version.
