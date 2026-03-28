# Changelog

## 0.1.0 (2026-03-28)

### Session 3
- `groundctl.org` landing page (static HTML, Vercel deploy)
- npm package ready: `@groundctl/cli` on npmjs.com
- `SHOW_HN.md` draft

### Session 2
- `groundctl ingest` — parse Claude Code JSONL transcripts
- `groundctl init --import-from-git` — bootstrap from git history
- `groundctl report` — generate SESSION_REPORT.md
- `groundctl health` — quality score (features/tests/decisions/claims/deploy)
- Post-session hook updated to auto-ingest transcripts
- groundctl tracks itself (S1–S3 in SQLite)

### Session 1 — Initial release

Initial release.

### Features
- `groundctl init` — setup hooks and database
- `groundctl status` — macro product view with ASCII progress
- `groundctl claim` / `complete` — feature claiming system
- `groundctl next` — show available features
- `groundctl sync` — regenerate PROJECT_STATE.md and AGENTS.md
- `groundctl log` — session timeline
- `groundctl add` — add features and sessions
- Claude Code and Codex CLI hooks
- SQLite with WAL mode for concurrent access
- Markdown generation for LLM consumption
