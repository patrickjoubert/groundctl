import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import chalk from "chalk";
import { findDbPath, claimFeatureInDb } from "./dashboard.js";

export async function launchCommand(featureName: string): Promise<void> {
  const dbPath = findDbPath();
  if (!dbPath) {
    console.error(chalk.red("  ✗ No .groundctl/db.sqlite found. Run: groundctl init"));
    process.exit(1);
  }

  console.log(chalk.dim(`\n  Claiming "${featureName}"...\n`));
  const result = await claimFeatureInDb(dbPath, featureName);

  if (!result.ok) {
    // If already claimed, allow continuing
    if (result.error !== "Already claimed") {
      console.error(chalk.red(`  ✗ ${result.error}`));
      process.exit(1);
    }
    console.log(chalk.yellow(`  ⚠ Already claimed — continuing\n`));
  } else {
    console.log(chalk.green(`  ✓ Claimed "${result.featureName ?? featureName}"\n`));
  }

  // Read AGENTS.md for context
  const projectDir = dbPath.replace("/.groundctl/db.sqlite", "");
  const agentsPath = join(projectDir, "AGENTS.md");
  const agentsCtx  = existsSync(agentsPath)
    ? `\n\n--- AGENTS.md ---\n${readFileSync(agentsPath, "utf8").slice(0, 2000)}`
    : "";

  const prompt = `You are working on feature "${result.featureName ?? featureName}" in the groundctl project.

Read AGENTS.md and PROJECT_STATE.md first to understand the codebase and conventions.
Then implement the feature. When done, run: groundctl complete "${featureName}"${agentsCtx}`;

  console.log(chalk.bold("  Launching Claude Code...\n"));
  console.log(chalk.dim("  Context:"));
  console.log(chalk.gray(`  Feature: ${result.featureName ?? featureName}`));
  console.log(chalk.gray(`  Project: ${projectDir}\n`));

  // Try to launch claude
  const claude = spawn("claude", ["--print", prompt], {
    stdio: "inherit",
    cwd: projectDir,
  });

  claude.on("error", () => {
    // claude not in PATH — show copy command
    console.log(chalk.yellow("  claude not found in PATH.\n"));
    console.log(chalk.bold("  Copy and run in terminal:\n"));
    console.log(chalk.cyan(`  cd ${projectDir} && claude\n`));
    console.log(chalk.dim("  Then paste this prompt:\n"));
    console.log(chalk.white(prompt.slice(0, 300) + "...\n"));
  });

  claude.on("close", (code) => {
    if (code === 0) {
      console.log(chalk.green("\n  ✓ Claude session complete"));
      console.log(chalk.dim(`  Run: groundctl complete "${featureName}"\n`));
    }
  });
}
