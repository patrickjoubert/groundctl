# Contributing to groundctl

Thanks for wanting to contribute! groundctl is MIT-licensed and welcomes contributions.

## Development setup

```bash
git clone https://github.com/groundctl/groundctl.git
cd groundctl
npm install
npm run build
```

## Project structure

```
packages/cli/     — @groundctl/cli (the main tool)
packages/dashboard/ — React dashboard (coming soon)
hooks/            — Pre-built hooks for Claude Code and Codex
examples/         — Real-world usage examples
docs/             — Documentation
```

## Making changes

1. Fork the repo
2. Create a branch (`git checkout -b feature/my-change`)
3. Make your changes in `packages/cli/src/`
4. Build with `npm run build`
5. Test locally: `node packages/cli/dist/index.js status`
6. Open a PR

## Key design principles

- **SQLite is the source of truth** — never bypass it
- **Markdown is generated** — don't edit generated files manually
- **CLI is agent-agnostic** — should work with any coding agent
- **Local-first** — no cloud dependency in core
- **Concurrent-safe** — SQLite WAL mode, optimistic locking for claims
