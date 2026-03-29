import type { Database } from "sql.js";

export const SCHEMA_VERSION = 1;

export function applySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS features (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'done', 'blocked')),
      priority      TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      description   TEXT,
      parallel_safe INTEGER NOT NULL DEFAULT 1,
      session_claimed TEXT,
      claimed_at    TEXT,
      completed_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL DEFAULT 'claude-code',
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at    TEXT,
      summary     TEXT,
      prompt      TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS decisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      description TEXT NOT NULL,
      rationale   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files_modified (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      path          TEXT NOT NULL,
      operation     TEXT NOT NULL DEFAULT 'modified'
                    CHECK (operation IN ('created', 'modified', 'deleted')),
      lines_changed INTEGER DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS claims (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id  TEXT NOT NULL REFERENCES features(id),
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      claimed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      UNIQUE(feature_id, session_id, claimed_at)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS feature_dependencies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id    TEXT NOT NULL REFERENCES features(id),
      depends_on_id TEXT NOT NULL REFERENCES features(id),
      type          TEXT NOT NULL DEFAULT 'blocks'
                    CHECK (type IN ('blocks', 'suggests')),
      UNIQUE(feature_id, depends_on_id)
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_deps_feature ON feature_dependencies(feature_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_deps_depends ON feature_dependencies(depends_on_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_features_status ON features(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_claims_feature ON claims(feature_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_claims_active ON claims(feature_id) WHERE released_at IS NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_files_session ON files_modified(session_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id)");

  // ── feature_groups table ────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS feature_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      label       TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ── planned_features table (plan detection from transcripts) ────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS planned_features (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      name        TEXT NOT NULL,
      raw_text    TEXT,
      confidence  TEXT NOT NULL DEFAULT 'medium',
      imported    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_planned_session ON planned_features(session_id)");

  // Migrations: add columns (no-op if already present)
  const tryAlter = (sql: string) => { try { db.run(sql); } catch { /* already exists */ } };
  tryAlter("ALTER TABLE features ADD COLUMN progress_done  INTEGER");
  tryAlter("ALTER TABLE features ADD COLUMN progress_total INTEGER");
  tryAlter("ALTER TABLE features ADD COLUMN items          TEXT");
  tryAlter("ALTER TABLE features ADD COLUMN group_id       INTEGER REFERENCES feature_groups(id)");

  db.run(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
    [String(SCHEMA_VERSION)]
  );
}
