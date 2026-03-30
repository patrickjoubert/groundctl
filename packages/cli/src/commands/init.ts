import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import chalk from "../colors.js";
import { openDb, closeDb } from "../storage/db.js";
import { generateProjectState, generateAgentsMd } from "../generators/markdown.js";
import { importFromGit } from "../ingest/git-import.js";
import { detectAndImportFeatures } from "../ingest/feature-detector.js";

const PRE_SESSION_HOOK = `#!/bin/bash
# groundctl — pre-session hook for Claude Code
# Reads product state before the agent starts working

groundctl sync 2>/dev/null
if [ -f PROJECT_STATE.md ]; then
  echo "--- groundctl: Product state loaded ---"
  cat PROJECT_STATE.md
fi
if [ -f AGENTS.md ]; then
  cat AGENTS.md
fi
`;

const POST_SESSION_HOOK = `#!/bin/bash
# groundctl — post-session hook for Claude Code
# Updates product state after the agent finishes

set -euo pipefail

if ! command -v groundctl &>/dev/null; then
  exit 0
fi

groundctl ingest \\
  --source claude-code \\
  \${CLAUDE_SESSION_ID:+--session-id "\$CLAUDE_SESSION_ID"} \\
  \${CLAUDE_TRANSCRIPT_PATH:+--transcript "\$CLAUDE_TRANSCRIPT_PATH"} \\
  --project-path "\$PWD" \\
  --no-sync 2>/dev/null || true

groundctl sync 2>/dev/null || true
echo "--- groundctl: Product state updated ---"
`;

const LAUNCH_AGENT_ID = "org.groundctl.watch";
const LAUNCH_AGENT_PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_ID}.plist`);

function buildLaunchAgentPlist(projectPath: string): string {
  // Resolve groundctl binary path
  const binPath = process.argv[1]; // path to the built groundctl script
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binPath}</string>
    <string>watch</string>
    <string>--project-path</string>
    <string>${projectPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(projectPath, ".groundctl", "watch.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(projectPath, ".groundctl", "watch.log")}</string>
</dict>
</plist>
`;
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

/** Start watch daemon and write PID to .groundctl/watch.pid */
function startWatchDaemon(projectPath: string): number | null {
  try {
    const args = [process.argv[1], "watch", "--project-path", projectPath];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid ?? null;
    if (pid) {
      const groundctlDir = join(projectPath, ".groundctl");
      mkdirSync(groundctlDir, { recursive: true });
      writeFileSync(join(groundctlDir, "watch.pid"), String(pid), "utf8");
    }
    return pid;
  } catch {
    return null;
  }
}

/** Check if the watch daemon is already running */
function watchDaemonRunning(projectPath: string): boolean {
  try {
    const pidPath = join(projectPath, ".groundctl", "watch.pid");
    if (!existsSync(pidPath)) return false;
    const pid = parseInt(readFileSync(pidPath, "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Install LaunchAgent plist and load it */
function installLaunchAgent(projectPath: string): boolean {
  try {
    const laDir = join(homedir(), "Library", "LaunchAgents");
    mkdirSync(laDir, { recursive: true });
    writeFileSync(LAUNCH_AGENT_PLIST_PATH, buildLaunchAgentPlist(projectPath), "utf8");
    // Load it immediately (best-effort)
    try { execSync(`launchctl load "${LAUNCH_AGENT_PLIST_PATH}"`, { stdio: "ignore" }); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

export async function initCommand(options: { importFromGit?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const projectName = cwd.split("/").pop() ?? "unknown";

  console.log(chalk.bold(`\ngroundctl init — ${projectName}\n`));

  // 1. Initialize SQLite database
  console.log(chalk.gray("  Creating SQLite database..."));
  const db = await openDb();

  // Import from git before generating markdown
  if (options.importFromGit) {
    const isGitRepo = existsSync(join(cwd, ".git"));
    if (!isGitRepo) {
      console.log(chalk.yellow("  ⚠ Not a git repo — skipping --import-from-git"));
    } else {
      console.log(chalk.gray("  Importing sessions from git history..."));
      const result = importFromGit(db, cwd);
      console.log(
        chalk.green(`  ✓ Git import: ${result.sessionsCreated} sessions`)
      );
      // Detect real product features using Claude API
      await detectAndImportFeatures(db, cwd);
    }
  }

  // Generate markdown
  const projectState = generateProjectState(db, projectName);
  const agentsMd = generateAgentsMd(db, projectName);
  closeDb();

  console.log(chalk.green("  ✓ Database ready"));

  // 2. Install Claude Code hooks
  const claudeHooksDir = join(cwd, ".claude", "hooks");
  if (!existsSync(claudeHooksDir)) {
    mkdirSync(claudeHooksDir, { recursive: true });
  }

  writeFileSync(join(claudeHooksDir, "pre-session.sh"), PRE_SESSION_HOOK);
  chmodSync(join(claudeHooksDir, "pre-session.sh"), 0o755);
  writeFileSync(join(claudeHooksDir, "post-session.sh"), POST_SESSION_HOOK);
  chmodSync(join(claudeHooksDir, "post-session.sh"), 0o755);
  console.log(chalk.green("  ✓ Claude Code hooks installed"));

  // 3. Install Codex hooks
  const codexHooksDir = join(cwd, ".codex", "hooks");
  if (!existsSync(codexHooksDir)) {
    mkdirSync(codexHooksDir, { recursive: true });
  }
  const codexPre = PRE_SESSION_HOOK.replace("Claude Code", "Codex");
  const codexPost = POST_SESSION_HOOK.replace("Claude Code", "Codex").replace("claude-code", "codex");
  writeFileSync(join(codexHooksDir, "pre-session.sh"), codexPre);
  chmodSync(join(codexHooksDir, "pre-session.sh"), 0o755);
  writeFileSync(join(codexHooksDir, "post-session.sh"), codexPost);
  chmodSync(join(codexHooksDir, "post-session.sh"), 0o755);
  console.log(chalk.green("  ✓ Codex hooks installed"));

  // 4. Write markdown files
  writeFileSync(join(cwd, "PROJECT_STATE.md"), projectState);
  writeFileSync(join(cwd, "AGENTS.md"), agentsMd);
  console.log(chalk.green("  ✓ PROJECT_STATE.md generated"));
  console.log(chalk.green("  ✓ AGENTS.md generated"));

  // 5. Create .gitignore entry for local db
  const gitignorePath = join(cwd, ".gitignore");
  const gitignoreEntry = "\n# groundctl local state\n.groundctl/\n";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".groundctl/")) {
      appendFileSync(gitignorePath, gitignoreEntry);
    }
  }

  // 6. Start watch daemon
  console.log("");
  if (watchDaemonRunning(cwd)) {
    console.log(chalk.green("  ✓ Watch daemon already running"));
  } else {
    const pid = startWatchDaemon(cwd);
    if (pid) {
      console.log(chalk.green(`  ✓ Watch daemon started`) + chalk.gray(` (PID ${pid})`));
    } else {
      console.log(chalk.yellow("  ⚠  Could not start watch daemon — run: groundctl watch --daemon"));
    }
  }

  // 7. Prompt for LaunchAgent (macOS only)
  if (process.platform === "darwin") {
    const laInstalled = existsSync(LAUNCH_AGENT_PLIST_PATH);
    if (!laInstalled) {
      const answer = await readLine(
        chalk.bold("  Start groundctl watch on login? (recommended) ") + chalk.gray("[y/n] ")
      );
      if (answer === "y" || answer === "yes") {
        const ok = installLaunchAgent(cwd);
        if (ok) {
          console.log(chalk.green("  ✓ LaunchAgent installed") + chalk.gray(` (${LAUNCH_AGENT_PLIST_PATH.replace(homedir(), "~")})`));
        } else {
          console.log(chalk.yellow("  ⚠  LaunchAgent install failed — run: groundctl doctor"));
        }
      } else {
        console.log(chalk.gray("  Skipped. You can install later: groundctl doctor"));
      }
    } else {
      console.log(chalk.green("  ✓ LaunchAgent already installed"));
    }
  }

  console.log(chalk.bold.green(`\n  ✓ groundctl initialized for ${projectName}\n`));

  if (!options.importFromGit) {
    console.log(chalk.gray("  Next steps:"));
    console.log(chalk.gray("    groundctl add feature -n 'my-feature' -p high"));
    console.log(chalk.gray("    groundctl status"));
    console.log(chalk.gray("    groundctl claim my-feature"));
    console.log(chalk.gray("\n  Or bootstrap from git history:"));
    console.log(chalk.gray("    groundctl init --import-from-git\n"));
  } else {
    console.log(chalk.gray("  Next steps:"));
    console.log(chalk.gray("    groundctl status"));
    console.log(chalk.gray("    groundctl next\n"));
  }
}
