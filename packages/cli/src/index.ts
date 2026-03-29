#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "node:module";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { claimCommand, completeCommand } from "./commands/claim.js";
import { syncCommand } from "./commands/sync.js";
import { nextCommand } from "./commands/next.js";
import { logCommand } from "./commands/log.js";
import { addCommand } from "./commands/add.js";
import { ingestCommand } from "./commands/ingest.js";
import { reportCommand } from "./commands/report.js";
import { healthCommand } from "./commands/health.js";
import { dashboardCommand } from "./commands/dashboard.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("groundctl")
  .description("The shared memory your agents and you actually need.")
  .version(pkg.version);

program
  .command("init")
  .description("Setup hooks + initial state for the current project")
  .option("--import-from-git", "Bootstrap sessions and features from git history")
  .action((opts) => initCommand({ importFromGit: opts.importFromGit }));

program
  .command("status")
  .description("Show macro view of the product state")
  .action(statusCommand);

program
  .command("claim <feature>")
  .description("Reserve a feature for the current session")
  .option("-s, --session <id>", "Session ID (auto-generated if omitted)")
  .action(claimCommand);

program
  .command("complete <feature>")
  .description("Mark a feature as done and release the claim")
  .action(completeCommand);

program
  .command("sync")
  .description("Regenerate PROJECT_STATE.md and AGENTS.md from SQLite")
  .action(syncCommand);

program
  .command("next")
  .description("Show next available (unclaimed) feature")
  .action(nextCommand);

program
  .command("log")
  .description("Show session timeline")
  .option("-s, --session <id>", "Show details for a specific session")
  .action(logCommand);

program
  .command("add <type>")
  .description("Add a feature or session (type: feature, session)")
  .option("-n, --name <name>", "Name")
  .option("-p, --priority <priority>", "Priority (critical, high, medium, low)")
  .option("-d, --description <desc>", "Description")
  .option("--agent <agent>", "Agent type for sessions")
  .action(addCommand);

program
  .command("ingest")
  .description("Parse a transcript and write session data to SQLite")
  .option("--source <source>", "Source agent (claude-code, codex)", "claude-code")
  .option("--session-id <id>", "Session ID")
  .option("--transcript <path>", "Path to transcript JSONL file (auto-detected if omitted)")
  .option("--project-path <path>", "Project path (defaults to cwd)")
  .option("--no-sync", "Skip regenerating markdown after ingest")
  .action((opts) =>
    ingestCommand({
      source: opts.source,
      sessionId: opts.sessionId,
      transcript: opts.transcript,
      projectPath: opts.projectPath,
      noSync: !opts.sync,
    })
  );

program
  .command("report")
  .description("Generate SESSION_REPORT.md from SQLite")
  .option("-s, --session <id>", "Report for a specific session")
  .option("--all", "Generate report for all sessions")
  .action(reportCommand);

program
  .command("health")
  .description("Show product health score")
  .action(healthCommand);

program
  .command("dashboard")
  .description("Start web dashboard on port 4242")
  .option("-p, --port <port>", "Port number", "4242")
  .action(dashboardCommand);

program.parse();
