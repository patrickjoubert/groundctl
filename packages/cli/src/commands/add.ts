import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { openDb, closeDb, saveDb } from "../storage/db.js";

/** Parse "11/11" → { done: 11, total: 11 }, or null on bad input. */
function parseProgress(s: string): { done: number; total: number } | null {
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  return { done: parseInt(m[1], 10), total: parseInt(m[2], 10) };
}

export async function addCommand(
  type: string,
  options: {
    name?: string;
    priority?: string;
    description?: string;
    agent?: string;
    items?: string;
    progress?: string;
  }
): Promise<void> {
  const db = await openDb();

  if (type === "feature") {
    if (!options.name) {
      console.log(chalk.red("\n  --name is required for features.\n"));
      closeDb();
      process.exit(1);
    }

    const id = options.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const priority = options.priority ?? "medium";

    // Parse --progress "N/N"
    let progressDone: number | null = null;
    let progressTotal: number | null = null;
    if (options.progress) {
      const p = parseProgress(options.progress);
      if (p) {
        progressDone = p.done;
        progressTotal = p.total;
      } else {
        console.log(chalk.yellow(`  ⚠  --progress "${options.progress}" ignored (expected N/N format)`));
      }
    }

    // Normalise --items: trim each item, remove empties
    const items = options.items
      ? options.items.split(",").map((s) => s.trim()).filter(Boolean).join(",")
      : null;

    db.run(
      `INSERT INTO features
         (id, name, priority, description, progress_done, progress_total, items)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, options.name, priority, options.description ?? null,
       progressDone, progressTotal, items]
    );

    saveDb();
    closeDb();

    const extras: string[] = [];
    if (progressDone !== null) extras.push(`${progressDone}/${progressTotal}`);
    if (items) extras.push(`${items.split(",").length} items`);
    const suffix = extras.length ? chalk.gray(` — ${extras.join(", ")}`) : "";
    console.log(chalk.green(`\n  ✓ Feature added: ${options.name} (${priority})${suffix}\n`));

  } else if (type === "session") {
    const id = options.name ?? randomUUID().slice(0, 8);
    const agent = options.agent ?? "claude-code";

    db.run("INSERT INTO sessions (id, agent) VALUES (?, ?)", [id, agent]);

    saveDb();
    closeDb();

    console.log(chalk.green(`\n  ✓ Session created: ${id} (${agent})\n`));
  } else {
    console.log(chalk.red(`\n  Unknown type "${type}". Use "feature" or "session".\n`));
    closeDb();
    process.exit(1);
  }
}
