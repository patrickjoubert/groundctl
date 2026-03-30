import chalk from "../colors.js";
import initSqlJs from "sql.js";
import { readFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline";
import { findDbPath } from "./dashboard.js";

interface ClaimRow {
  id: number;
  feature_id: string;
  feature_name: string;
  session_id: string;
  claimed_at: string;
}

function elapsed(ts: string): string {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); const rm = m % 60;
  return `${h}h ${rm}m`;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

export async function staleCommand(): Promise<void> {
  const dbPath = findDbPath();
  if (!dbPath) {
    console.error(chalk.red("  ✗ No .groundctl/db.sqlite found. Run: groundctl init"));
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const buf = readFileSync(dbPath);
  const db  = new SQL.Database(buf);

  function q<T>(sql: string): T[] {
    try {
      const stmt = db.prepare(sql);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    } catch { return []; }
  }

  const claims = q<ClaimRow>(
    `SELECT c.rowid as id, c.feature_id, f.name as feature_name, c.session_id, c.claimed_at
     FROM claims c JOIN features f ON c.feature_id = f.id
     WHERE c.released_at IS NULL ORDER BY c.claimed_at ASC`
  );

  const STALE_MS = 2 * 60 * 60 * 1000; // 2h
  const stale    = claims.filter(c => Date.now() - new Date(c.claimed_at).getTime() > STALE_MS);

  console.log(chalk.bold(`\n  groundctl stale\n`));

  if (stale.length === 0) {
    console.log(chalk.green("  ✓ Aucun claim stale (< 2h)\n"));
    db.close();
    return;
  }

  console.log(chalk.red(`  ${stale.length} claim${stale.length > 1 ? "s" : ""} stale :\n`));

  for (const c of stale) {
    const el = elapsed(c.claimed_at);
    console.log(`  ${chalk.red("⚠")}  ${chalk.yellow(c.feature_name)}`);
    console.log(`     session ${chalk.blue(c.session_id.slice(0,8))} · claimé il y a ${chalk.red(el)}\n`);
  }

  if (!process.stdout.isTTY) { db.close(); return; }

  const answer = await prompt(chalk.bold("  Libérer tous les claims stales ? [y/N] "));

  if (answer.toLowerCase() !== "y") {
    console.log(chalk.dim("\n  Annulé.\n"));
    db.close();
    return;
  }

  let released = 0;
  for (const c of stale) {
    try {
      db.run(
        "UPDATE claims SET released_at = datetime('now') WHERE feature_id = ? AND session_id = ? AND released_at IS NULL",
        [c.feature_id, c.session_id]
      );
      db.run("UPDATE features SET status = 'pending', updated_at = datetime('now') WHERE id = ?", [c.feature_id]);
      released++;
    } catch { /* skip */ }
  }

  const data = db.export();
  db.close();
  writeFileSync(dbPath, Buffer.from(data));

  console.log(chalk.green(`\n  ✓ ${released} claim${released > 1 ? "s" : ""} libéré${released > 1 ? "s" : ""}\n`));
}
