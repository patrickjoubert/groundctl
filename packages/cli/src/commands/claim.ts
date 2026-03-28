import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

export async function claimCommand(
  featureIdOrName: string,
  options: { session?: string }
): Promise<void> {
  const db = await openDb();

  const feature = queryOne<{ id: string; name: string; status: string }>(
    db,
    `SELECT id, name, status FROM features
     WHERE id = ? OR name = ? OR name LIKE ?`,
    [featureIdOrName, featureIdOrName, `%${featureIdOrName}%`]
  );

  if (!feature) {
    console.log(chalk.red(`\n  Feature "${featureIdOrName}" not found.\n`));
    console.log(chalk.gray("  Add it with: groundctl add feature -n '" + featureIdOrName + "'"));
    closeDb();
    process.exit(1);
  }

  if (feature.status === "done") {
    console.log(chalk.yellow(`\n  Feature "${feature.name}" is already done.\n`));
    closeDb();
    return;
  }

  const existingClaim = queryOne<{ session_id: string; claimed_at: string }>(
    db,
    `SELECT session_id, claimed_at FROM claims
     WHERE feature_id = ? AND released_at IS NULL`,
    [feature.id]
  );

  if (existingClaim) {
    console.log(
      chalk.red(`\n  Feature "${feature.name}" is already claimed by session ${existingClaim.session_id}`)
    );

    const alternatives = query<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM features
       WHERE status = 'pending'
       AND id NOT IN (SELECT feature_id FROM claims WHERE released_at IS NULL)
       ORDER BY CASE priority
         WHEN 'critical' THEN 0 WHEN 'high' THEN 1
         WHEN 'medium' THEN 2 WHEN 'low' THEN 3
       END
       LIMIT 3`,
    );

    if (alternatives.length > 0) {
      console.log(chalk.gray("\n  Available instead:"));
      for (const alt of alternatives) {
        console.log(chalk.gray(`    ○ ${alt.name}`));
      }
    }
    console.log("");
    closeDb();
    process.exit(1);
  }

  const sessionId = options.session ?? randomUUID().slice(0, 8);

  const sessionExists = queryOne(
    db,
    "SELECT id FROM sessions WHERE id = ?",
    [sessionId]
  );

  if (!sessionExists) {
    db.run(
      "INSERT INTO sessions (id, agent, started_at) VALUES (?, 'claude-code', datetime('now'))",
      [sessionId]
    );
  }

  db.run(
    "INSERT INTO claims (feature_id, session_id) VALUES (?, ?)",
    [feature.id, sessionId]
  );

  db.run(
    "UPDATE features SET status = 'in_progress', session_claimed = ?, claimed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [sessionId, feature.id]
  );

  saveDb();
  closeDb();

  console.log(
    chalk.green(`\n  ✓ Claimed "${feature.name}" → session ${sessionId}\n`)
  );
}

export async function completeCommand(featureIdOrName: string): Promise<void> {
  const db = await openDb();

  const feature = queryOne<{ id: string; name: string; status: string }>(
    db,
    `SELECT id, name, status FROM features
     WHERE id = ? OR name = ? OR name LIKE ?`,
    [featureIdOrName, featureIdOrName, `%${featureIdOrName}%`]
  );

  if (!feature) {
    console.log(chalk.red(`\n  Feature "${featureIdOrName}" not found.\n`));
    closeDb();
    process.exit(1);
  }

  db.run(
    "UPDATE claims SET released_at = datetime('now') WHERE feature_id = ? AND released_at IS NULL",
    [feature.id]
  );

  db.run(
    "UPDATE features SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [feature.id]
  );

  saveDb();
  closeDb();

  console.log(chalk.green(`\n  ✓ Completed "${feature.name}"\n`));
}
