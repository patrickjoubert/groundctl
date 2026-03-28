import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { openDb, closeDb, saveDb } from "../storage/db.js";

export async function addCommand(
  type: string,
  options: { name?: string; priority?: string; description?: string; agent?: string }
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

    db.run(
      "INSERT INTO features (id, name, priority, description) VALUES (?, ?, ?, ?)",
      [id, options.name, priority, options.description ?? null]
    );

    saveDb();
    closeDb();

    console.log(chalk.green(`\n  ✓ Feature added: ${options.name} (${priority})\n`));
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
