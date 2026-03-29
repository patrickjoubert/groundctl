import chalk from "chalk";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { queryOne } from "../storage/query.js";

/** Parse "11/11" → { done: 11, total: 11 }, or null on bad input. */
function parseProgress(s: string): { done: number; total: number } | null {
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  return { done: parseInt(m[1], 10), total: parseInt(m[2], 10) };
}

interface UpdateOptions {
  description?: string;
  items?: string;
  progress?: string;
  priority?: string;
  status?: string;
}

export async function updateCommand(
  type: string,
  nameOrId: string,
  options: UpdateOptions
): Promise<void> {
  if (type !== "feature") {
    console.log(chalk.red(`\n  Unknown type "${type}". Use "feature".\n`));
    process.exit(1);
  }

  const db = await openDb();

  // Find the feature: exact id → exact name → substring match
  const feature = queryOne<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM features
     WHERE id = ?1 OR name = ?1
     OR id LIKE ?2 OR name LIKE ?2
     ORDER BY CASE WHEN id = ?1 OR name = ?1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [nameOrId, `%${nameOrId}%`]
  );

  if (!feature) {
    console.log(chalk.red(`\n  Feature "${nameOrId}" not found.\n`));
    closeDb();
    process.exit(1);
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (options.description !== undefined) {
    sets.push("description = ?");
    params.push(options.description);
  }

  if (options.items !== undefined) {
    const items = options.items.split(",").map((s) => s.trim()).filter(Boolean).join(",");
    sets.push("items = ?");
    params.push(items);
  }

  if (options.progress !== undefined) {
    const p = parseProgress(options.progress);
    if (!p) {
      console.log(chalk.yellow(`  ⚠  --progress "${options.progress}" ignored (expected N/N format)\n`));
    } else {
      sets.push("progress_done = ?", "progress_total = ?");
      params.push(p.done, p.total);
    }
  }

  if (options.priority !== undefined) {
    sets.push("priority = ?");
    params.push(options.priority);
  }

  if (options.status !== undefined) {
    sets.push("status = ?");
    params.push(options.status);
  }

  if (sets.length === 0) {
    console.log(chalk.yellow("\n  Nothing to update — pass at least one option.\n"));
    closeDb();
    return;
  }

  sets.push("updated_at = datetime('now')");
  params.push(feature.id);

  db.run(
    `UPDATE features SET ${sets.join(", ")} WHERE id = ?`,
    params as Parameters<typeof db.run>[1]
  );

  saveDb();
  closeDb();

  console.log(chalk.green(`  ✓ Updated: ${feature.name}`));
}
