/**
 * Test helper: create an in-memory sql.js database with the full groundctl schema applied.
 * Does not touch the filesystem — safe to use in parallel tests.
 */
import initSqlJs, { type Database } from "sql.js";
import { applySchema } from "../../storage/schema.js";

export async function createTestDb(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("PRAGMA journal_mode = WAL");
  applySchema(db);
  return db;
}

/** Insert a feature row and return its id. */
export function insertFeature(
  db: Database,
  opts: {
    id?: string;
    name: string;
    status?: "pending" | "in_progress" | "done" | "blocked";
    priority?: "critical" | "high" | "medium" | "low";
  }
): string {
  const id = opts.id ?? opts.name;
  db.run(
    `INSERT INTO features (id, name, status, priority) VALUES (?, ?, ?, ?)`,
    [id, opts.name, opts.status ?? "pending", opts.priority ?? "medium"]
  );
  return id;
}

/** Insert a session row. */
export function insertSession(db: Database, id: string): void {
  db.run(
    `INSERT INTO sessions (id, agent, started_at) VALUES (?, 'claude-code', datetime('now'))`,
    [id]
  );
}

/** Claim a feature for a session. */
export function claimFeature(db: Database, featureId: string, sessionId: string): void {
  db.run(
    `INSERT INTO claims (feature_id, session_id, claimed_at) VALUES (?, ?, datetime('now'))`,
    [featureId, sessionId]
  );
  db.run(
    `UPDATE features SET status = 'in_progress', session_claimed = ?, claimed_at = datetime('now') WHERE id = ?`,
    [sessionId, featureId]
  );
}

/** Release an active claim (complete). */
export function releaseFeature(db: Database, featureId: string): void {
  db.run(
    `UPDATE claims SET released_at = datetime('now') WHERE feature_id = ? AND released_at IS NULL`,
    [featureId]
  );
  db.run(
    `UPDATE features SET status = 'done', completed_at = datetime('now') WHERE id = ?`,
    [featureId]
  );
}

/** Count active (unreleased) claims for a feature. */
export function activeClaims(db: Database, featureId: string): number {
  const stmt = db.prepare(
    `SELECT COUNT(*) as n FROM claims WHERE feature_id = ? AND released_at IS NULL`
  );
  stmt.bind([featureId]);
  stmt.step();
  const n = (stmt.getAsObject() as { n: number }).n;
  stmt.free();
  return n;
}

/** Return the status of a feature. */
export function featureStatus(db: Database, featureId: string): string | null {
  const stmt = db.prepare(`SELECT status FROM features WHERE id = ?`);
  stmt.bind([featureId]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject() as { status: string };
  stmt.free();
  return row.status;
}

/** Run the "next available" query (mirrors nextCommand's SQL). */
export function queryNextAvailable(db: Database): Array<{ id: string; name: string; priority: string }> {
  const stmt = db.prepare(`
    SELECT f.id, f.name, f.priority
    FROM features f
    WHERE f.status = 'pending'
    AND f.id NOT IN (SELECT feature_id FROM claims WHERE released_at IS NULL)
    AND f.id NOT IN (
      SELECT d.feature_id
      FROM feature_dependencies d
      JOIN features dep ON dep.id = d.depends_on_id
      WHERE dep.status != 'done' AND d.type = 'blocks'
    )
    ORDER BY
      CASE f.priority
        WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3
      END
    LIMIT 5
  `);
  const rows: Array<{ id: string; name: string; priority: string }> = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as { id: string; name: string; priority: string });
  }
  stmt.free();
  return rows;
}
