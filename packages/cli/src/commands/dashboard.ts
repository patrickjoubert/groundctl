import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function dashboardCommand(options: { port?: string }): Promise<void> {
  const port = options.port ?? "4242";

  // Find the dashboard server script relative to this file
  // In dist: dist/commands/dashboard.js → packages/dashboard/src/server.js
  const serverPath = join(__dirname, "..", "..", "..", "dashboard", "src", "server.js");

  if (!existsSync(serverPath)) {
    console.log(chalk.red(`\n  Dashboard server not found at: ${serverPath}\n`));
    console.log(chalk.gray("  If running from source: npm run build"));
    return;
  }

  console.log(chalk.bold(`\n  groundctl dashboard → http://localhost:${port}\n`));
  console.log(chalk.gray("  Auto-refreshes every 10s. Press Ctrl+C to stop.\n"));

  const child = spawn(process.execPath, [serverPath], {
    stdio: "inherit",
    env: { ...process.env, GROUNDCTL_PORT: port },
  });

  child.on("error", (err) => {
    console.error(chalk.red(`  Error: ${err.message}`));
  });

  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
}
