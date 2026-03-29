# Claiming System

The claiming system is groundctl's answer to the question: *how do you run 10 agents on the same product without them duplicating work or stepping on each other?*

## How it works

A **claim** is a record in SQLite that says: feature X is being worked on by session Y.

```sql
claims (feature_id, session_id, claimed_at, released_at)
```

When `released_at` is NULL, the claim is active. When an agent completes a feature, `released_at` is set and `features.status` is updated to `done`.

## Basic flow

```bash
# Agent sees what's available
groundctl next
# → docs (high) — getting-started, hooks, claiming, multi-agent docs

# Agent reserves it
groundctl claim "docs"
# → ✓ Claimed "docs" → session S4

# Another agent tries the same feature
groundctl claim "docs"
# → Feature "docs" is already claimed by session S4
#   Available instead:
#     ○ show-hn-prep

# Agent finishes
groundctl complete "docs"
# → ✓ Completed "docs"
# → SQLite: claims.released_at = now, features.status = "done"
```

## Feature matching

`groundctl claim` matches features by:
1. **Exact ID** — `groundctl claim "docs"`
2. **Exact name** — `groundctl claim "Docs"`
3. **Prefix match** — `groundctl claim "doc"` → matches "docs"
4. **Substring match** — `groundctl claim "oc"` → matches "docs"

Exact matches always win over prefix/substring — so `groundctl claim "demo"` will never accidentally claim `multi-agent-demo` if a feature named "demo" exists.

## Session IDs

Each claim is tied to a session. You can specify a session ID:

```bash
groundctl claim "markets-uk" --session S5
```

Or let groundctl generate one (UUID prefix):

```bash
groundctl claim "markets-uk"
# → ✓ Claimed "markets-uk" → session a3f7b2c1
```

## Stale claims

A claim is considered stale when it's been open for more than 24 hours without being completed. `groundctl health` reports stale claims.

To release a stale claim without completing the feature:

```bash
groundctl complete "markets-uk"
# → ✓ Completed "markets-uk"
# Then re-open if needed:
groundctl add feature -n "markets-uk" -p high
```

Or manually reset in the DB:

```bash
sqlite3 .groundctl/db.sqlite \
  "UPDATE claims SET released_at = datetime('now') WHERE feature_id = 'markets-uk';
   UPDATE features SET status = 'pending', session_claimed = NULL WHERE id = 'markets-uk';"
```

## Priority ordering

`groundctl next` returns features ordered by priority (critical → high → medium → low), excluding currently claimed features.

```bash
groundctl next
# → show-hn-prep (high) — the next available feature not currently claimed
```

## Conflict detection

If two agents run `groundctl claim` simultaneously on the same feature, SQLite's serialized writes guarantee exactly one succeeds. The other gets the "already claimed" message.

This is an **optimistic lock** — lightweight, no blocking, no deadlocks.

## Parallel agents example

```bash
# Terminal 1 — Agent for UK market
groundctl claim "markets-uk" --session agent-1
# → ✓ Claimed "markets-uk" → session agent-1

# Terminal 2 — Agent for DE market
groundctl claim "markets-de" --session agent-2
# → ✓ Claimed "markets-de" → session agent-2

# Terminal 3 — Agent tries UK (conflict)
groundctl claim "markets-uk" --session agent-3
# → Feature "markets-uk" is already claimed by session agent-1
#   Available instead: ○ markets-fr

# Both agents finish
groundctl complete "markets-uk"
groundctl complete "markets-de"
```

See [multi-agent.md](multi-agent.md) for orchestrating at scale.
