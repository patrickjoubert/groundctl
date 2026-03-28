import type { Database, QueryExecResult } from "sql.js";

/**
 * Run a SELECT query and return results as an array of objects.
 * Bridges sql.js's array-based results to a more ergonomic object API.
 */
export function query<T extends Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = []
): T[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) {
    stmt.bind(params);
  }

  const results: T[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as T;
    results.push(row);
  }
  stmt.free();
  return results;
}

/**
 * Run a SELECT query and return the first result as an object, or undefined.
 */
export function queryOne<T extends Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = []
): T | undefined {
  const rows = query<T>(db, sql, params);
  return rows[0];
}
