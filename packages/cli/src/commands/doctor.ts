/**
 * doctor.ts
 *
 * Checks groundctl health:
 *  1. Version vs npm latest
 *  2. Watch daemon PID alive
 *  3. detect.groundctl.org reachable
 *  4. Feature groups configured
 *  5. LaunchAgent installed (macOS)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { request as httpsRequest } from "node:https";
import chalk from "../colors.js";
import { openDb, closeDb } from "../storage/db.js";
import { queryOne } from "../storage/query.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Path is relative to the bundled dist/index.js output, not this source file
const pkg = require("../package.json") as { version: string };

const LAUNCH_AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", "org.groundctl.watch.plist");

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(msg: string)   { console.log(chalk.green("  ✓ ") + msg); }
function warn(msg: string) { console.log(chalk.yellow("  ⚠  ") + msg); }
function fail(msg: string) { console.log(chalk.red("  ✗ ") + msg); }
function info(msg: string) { console.log(chalk.gray("    " + msg)); }

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getWatchPid(projectPath: string): number | null {
  try {
    const raw = readFileSync(join(projectPath, ".groundctl", "watch.pid"), "utf8").trim();
    return parseInt(raw) || null;
  } catch { return null; }
}

function httpsGet(url: string, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { method: "HEAD" }, (res) => {
      resolve(res.statusCode ?? 0);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
    req.end();
  });
}

function fetchNpmVersion(pkgName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`;
    const req = httpsRequest(url, { headers: { accept: "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        try {
          const obj = JSON.parse(data) as { version?: string };
          resolve(obj.version ?? null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(8_000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function doctorCommand(): Promise<void> {
  const cwd = process.cwd();
  const current = pkg.version;

  console.log(chalk.bold("\n  groundctl doctor\n"));

  // 1. Version check
  const [latest, proxyStatus] = await Promise.all([
    fetchNpmVersion("groundctl"),
    httpsGet("https://detect.groundctl.org/health"),
  ]);

  // ── Version ──────────────────────────────────────────────────────────────
  if (!latest) {
    warn(`Version: ${current} (could not reach npm registry)`);
  } else if (compareVersions(current, latest) < 0) {
    warn(`Version: ${current} — update available: ${chalk.cyan(latest)}`);
    info(`npm install -g groundctl@latest`);
  } else {
    ok(`Version: ${current} (up to date)`);
  }

  // 2. Watch daemon
  const pid = getWatchPid(cwd);
  if (!pid) {
    warn("Watch daemon: not started");
    info("groundctl watch --daemon");
  } else if (!processAlive(pid)) {
    warn(`Watch daemon: PID ${pid} is no longer running`);
    info("groundctl watch --daemon");
  } else {
    ok(`Watch daemon: running (PID ${pid})`);
  }

  // 3. Proxy reachability
  if (proxyStatus === 200) {
    ok("detect.groundctl.org: reachable");
  } else if (proxyStatus === 0) {
    warn("detect.groundctl.org: unreachable (no internet or proxy down)");
    info("Feature detection will fall back to ANTHROPIC_API_KEY or heuristic");
  } else {
    warn(`detect.groundctl.org: HTTP ${proxyStatus}`);
  }

  // 4. Feature groups
  const groundctlDir = join(cwd, ".groundctl");
  if (!existsSync(groundctlDir)) {
    warn("Not initialized in this directory — run: groundctl init");
  } else {
    const db = await openDb();
    const groupCount = queryOne<{ n: number }>(db, "SELECT COUNT(*) as n FROM feature_groups")?.n ?? 0;
    const featureCount = queryOne<{ n: number }>(db, "SELECT COUNT(*) as n FROM features")?.n ?? 0;
    closeDb();

    if (featureCount === 0) {
      warn("No features tracked — run: groundctl init --import-from-git");
    } else {
      ok(`Features: ${featureCount} tracked`);
    }

    if (groupCount === 0) {
      warn("No feature groups configured");
      info(`groundctl add group -n "core" --label "Core"`);
    } else {
      ok(`Feature groups: ${groupCount} configured`);
    }
  }

  // 5. Codex integration
  const codexSessionsDir = join(homedir(), ".codex", "sessions");
  const codexHooksPath   = join(cwd, ".codex", "hooks", "post-session.sh");

  if (existsSync(codexSessionsDir)) {
    ok(`Codex sessions: found (${codexSessionsDir.replace(homedir(), "~")})`);
  } else {
    warn("Codex sessions: ~/.codex/sessions not found — Codex not installed or never run");
  }

  if (existsSync(codexHooksPath)) {
    ok(`Codex hooks: post-session.sh installed`);
  } else {
    warn("Codex hooks: not installed — groundctl won't auto-ingest Codex sessions");
    info("Re-run: groundctl init   to install hooks");
  }

  // 6. LaunchAgent (macOS only)
  if (process.platform === "darwin") {
    if (existsSync(LAUNCH_AGENT_PLIST)) {
      ok(`LaunchAgent: installed (${LAUNCH_AGENT_PLIST.replace(homedir(), "~")})`);
    } else {
      warn("LaunchAgent: not installed (watch won't auto-start on login)");
      info("Re-run: groundctl init   to install");
    }
  }

  console.log("");
}
