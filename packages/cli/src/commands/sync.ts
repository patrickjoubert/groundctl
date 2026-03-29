import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { openDb, closeDb } from "../storage/db.js";
import { generateProjectState, generateAgentsMd } from "../generators/markdown.js";

export async function syncCommand(opts?: { silent?: boolean }): Promise<void> {
  const db = await openDb();
  const projectName = process.cwd().split("/").pop() ?? "unknown";

  const projectState = generateProjectState(db, projectName);
  const agentsMd = generateAgentsMd(db, projectName);

  closeDb();

  const cwd = process.cwd();
  writeFileSync(join(cwd, "PROJECT_STATE.md"), projectState);
  writeFileSync(join(cwd, "AGENTS.md"), agentsMd);

  if (!opts?.silent) {
    console.log(chalk.green("\n  ✓ PROJECT_STATE.md regenerated"));
    console.log(chalk.green("  ✓ AGENTS.md regenerated\n"));
  }
}
