import chalk from "chalk";
import { openDb, closeDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

function progressBar(done: number, total: number, width = 20): string {
  if (total === 0) return chalk.gray("░".repeat(width));
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(empty));
}

export async function statusCommand(): Promise<void> {
  const db = await openDb();
  const projectName = process.cwd().split("/").pop() ?? "unknown";

  const statusCounts = query<{ status: string; count: number }>(
    db,
    "SELECT status, COUNT(*) as count FROM features GROUP BY status"
  );

  const counts: Record<string, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
  };
  for (const row of statusCounts) {
    counts[row.status] = row.count;
  }
  const total = counts.pending + counts.in_progress + counts.done + counts.blocked;

  const activeClaims = query<{
    feature_id: string;
    feature_name: string;
    session_id: string;
    claimed_at: string;
  }>(
    db,
    `SELECT c.feature_id, f.name as feature_name, c.session_id, c.claimed_at
     FROM claims c
     JOIN features f ON c.feature_id = f.id
     WHERE c.released_at IS NULL`
  );

  const available = query<{ id: string; name: string; priority: string }>(
    db,
    `SELECT f.id, f.name, f.priority
     FROM features f
     WHERE f.status = 'pending'
     AND f.id NOT IN (SELECT feature_id FROM claims WHERE released_at IS NULL)
     ORDER BY
       CASE f.priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
       END`
  );

  const sessionCount = queryOne<{ count: number }>(
    db,
    "SELECT COUNT(*) as count FROM sessions"
  )?.count ?? 0;

  closeDb();

  console.log("");
  if (total === 0) {
    console.log(chalk.bold(`  ${projectName} — no features tracked yet\n`));
    console.log(chalk.gray("  Add features with: groundctl add feature -n 'my-feature'"));
    console.log(chalk.gray("  Then run: groundctl status\n"));
    return;
  }

  const pct = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  console.log(
    chalk.bold(`  ${projectName} — ${pct}% implemented`) +
      chalk.gray(` (${sessionCount} sessions)`)
  );
  console.log("");

  console.log(
    `  Features  ${progressBar(counts.done, total)}  ${counts.done}/${total} done`
  );
  if (counts.in_progress > 0) {
    console.log(chalk.yellow(`            ${counts.in_progress} in progress`));
  }
  if (counts.blocked > 0) {
    console.log(chalk.red(`            ${counts.blocked} blocked`));
  }
  console.log("");

  if (activeClaims.length > 0) {
    console.log(chalk.bold("  Claimed:"));
    for (const claim of activeClaims) {
      const elapsed = timeSince(claim.claimed_at);
      console.log(
        chalk.yellow(`    ● ${claim.feature_name} → session ${claim.session_id} (${elapsed})`)
      );
    }
    console.log("");
  }

  if (available.length > 0) {
    console.log(chalk.bold("  Available:"));
    for (const feat of available.slice(0, 5)) {
      const pColor =
        feat.priority === "critical" || feat.priority === "high"
          ? chalk.red
          : chalk.gray;
      console.log(`    ○ ${feat.name} ${pColor(`(${feat.priority})`)}`);
    }
    if (available.length > 5) {
      console.log(chalk.gray(`    ... and ${available.length - 5} more`));
    }
    console.log("");
  }
}

function timeSince(isoDate: string): string {
  const then = new Date(isoDate + "Z").getTime();
  const now = Date.now();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h${remainMins > 0 ? String(remainMins).padStart(2, "0") : ""}`;
}
