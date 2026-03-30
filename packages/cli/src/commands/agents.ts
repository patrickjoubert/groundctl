import chalk from "../colors.js";
import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { findDbPath } from "./dashboard.js";

interface ClaimRow {
  feature_id: string;
  feature_name: string;
  session_id: string;
  claimed_at: string;
}
interface FileRow { session_id: string; path: string; }

function elapsed(ts: string): string {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); const rm = m % 60;
  return `${h}h ${rm}m`;
}

export async function agentsCommand(): Promise<void> {
  const dbPath = findDbPath();
  if (!dbPath) {
    console.error(chalk.red("  ✗ No .groundctl/db.sqlite found. Run: groundctl init"));
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const db  = new SQL.Database(readFileSync(dbPath));

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
    `SELECT c.feature_id, f.name as feature_name, c.session_id, c.claimed_at
     FROM claims c JOIN features f ON c.feature_id = f.id
     WHERE c.released_at IS NULL ORDER BY c.claimed_at DESC`
  );
  const files = q<FileRow>("SELECT session_id, path FROM files_modified ORDER BY id DESC LIMIT 500");
  db.close();

  console.log(chalk.bold(`\n  groundctl agents\n`));

  if (claims.length === 0) {
    console.log(chalk.dim("  No active agents\n"));
    return;
  }

  const STALE_MS = 2 * 60 * 60 * 1000; // 2h

  for (const c of claims) {
    const age     = Date.now() - new Date(c.claimed_at).getTime();
    const stale   = age > STALE_MS;
    const el      = elapsed(c.claimed_at);
    const fCount  = files.filter(f => f.session_id === c.session_id).length;
    const staleLabel = stale ? chalk.red("  ⚠ STALE") : "";

    const icon  = stale ? chalk.red("⚠") : chalk.yellow("●");
    const name  = stale ? chalk.red(c.feature_name) : chalk.yellow(c.feature_name);
    const time  = stale ? chalk.red(`${el}`) : chalk.dim(`${el}`);

    console.log(`  ${icon} ${name}${staleLabel}`);
    console.log(`    ${chalk.dim("session")} ${chalk.blue(c.session_id.slice(0,8))}  ${chalk.dim("·")}  démarré il y a ${time}  ${chalk.dim("·")}  ${chalk.dim(fCount + " fichiers")}`);
    if (stale) {
      console.log(`    ${chalk.red("→ Stale depuis +" + el + " — release avec:")} ${chalk.dim("groundctl stale")}`);
    }
    console.log();
  }
}
