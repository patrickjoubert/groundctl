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

The interesting part: it parses Claude Code transcripts
automatically after each session — files touched, commits,
decisions made — and writes them to a local SQLite db.
Then generates PROJECT_STATE.md and AGENTS.md that the next
agent reads at session start.

The meta part: groundctl was built using groundctl.
S1–S3 tracked in its own PROJECT_STATE.md.

Install: npm install -g @groundctl/cli
Repo: github.com/groundctl/groundctl
Docs: groundctl.org

Would love feedback on the transcript parsing heuristics —
decision detection is regex-based today, wondering if it's
worth an LLM call for better accuracy.

---

## Notes (not for posting)

- Post Tuesday or Wednesday 9am PT for best HN traffic
- Reply to every comment in the first 2 hours
- The "built itself using itself" angle is the hook — lead with it in comments
- If someone asks about multi-agent coordination, point to the claiming system
- If someone asks about cloud sync / team use: "coming — local-first core is complete, cloud is next"
- If someone asks why not just use git: "git tracks what changed, not what's left to build or what decisions were made — and agents can't query git for 'what feature should I work on next'"
- Likely objections to prepare for:
  - "Why not just a CLAUDE.md file?" → CLAUDE.md is static, groundctl is live state + claiming system + multi-agent coordination
  - "How is this different from a todo list?" → It's machine-writable. The agent updates it, not you.
  - "sql.js is slow for large projects" → Acknowledged, better-sqlite3 is the path when Node 25 prebuilds ship
