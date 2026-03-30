import chalk from "../colors.js";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { queryOne } from "../storage/query.js";

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
  group?: string;
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

  // --group: resolve group name → id
  if (options.group !== undefined) {
    if (options.group === "" || options.group === "none") {
      sets.push("group_id = ?");
      params.push(null);
    } else {
      const slug = options.group.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
      const grp = queryOne<{ id: number; label: string }>(
        db,
        "SELECT id, label FROM feature_groups WHERE name = ? OR label = ? LIMIT 1",
        [slug, options.group]
      );
      if (!grp) {
        console.log(chalk.red(`\n  Group "${options.group}" not found. Create it first:\n  groundctl add group -n "${slug}" --label "${options.group}"\n`));
        closeDb();
        process.exit(1);
      }
      sets.push("group_id = ?");
      params.push(grp.id);
    }
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
