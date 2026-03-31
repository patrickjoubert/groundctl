import {
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  watch as fsWatch,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import chalk from "../colors.js";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { parseTranscript } from "../ingest/claude-parser.js";
import { parseCodexTranscript, readCodexSessionCwd } from "../ingest/codex-parser.js";
import { syncCommand } from "./sync.js";
import { queryOne } from "../storage/query.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** ms of silence after last write before we treat a session as finished */
const DEBOUNCE_MS = 8_000;

/** ms between polls when waiting for the transcript dir to appear */
const DIR_POLL_MS = 5_000;

/** ms between polls for date-directory rollover (Codex) */
const DATE_POLL_MS = 60_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Claude Code encodes project paths as directory names by replacing every
 * non-alphanumeric character (/, ., space, etc.) with "-".
 * e.g.  /Users/patrick/EVSpec.io  →  -Users-patrick-EVSpec-io
 */
function claudeEncode(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Find the Claude Code transcript directory for a given project path.
 * Returns null when no matching directory exists yet.
 */
function findTranscriptDir(projectPath: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  // 1. Exact encoded match  e.g. "-Users-patrick-EVSpec-io"
  const projectKey = claudeEncode(projectPath);
  const direct = join(projectsDir, projectKey);
  if (existsSync(direct)) return direct;

  // 2. Fuzzy: directory ends with the encoded project folder name
  const projectName = projectPath.split("/").pop() ?? "";
  const encodedName = claudeEncode(projectName);
  const dirs = readdirSync(projectsDir);
  for (const d of dirs) {
    if (d.endsWith(`-${encodedName}`) || d.includes(encodedName)) {
      return join(projectsDir, d);
    }
  }
  return null;
}

/**
 * Find the Codex sessions base directory.
 * Checks known locations and returns the first that exists.
 */
function findCodexSessionsDir(): string | null {
  const candidates = [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), "Library", "Application Support", "Codex", "sessions"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Return the path for today's Codex session directory (YYYY/MM/DD).
 * Uses local date to match Codex's naming convention.
 */
function todayCodexDir(sessionsBaseDir: string): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(sessionsBaseDir, String(y), m, day);
}

/** Return file size in bytes, or 0 if the file doesn't exist. */
function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Persist daemon PID so the user can find/kill it. */
function writePidFile(groundctlDir: string, pid: number): void {
  try {
    mkdirSync(groundctlDir, { recursive: true });
    writeFileSync(join(groundctlDir, "watch.pid"), String(pid), "utf8");
  } catch {
    // non-fatal
  }
}

/** Read a previously written PID, or null. */
function readPidFile(groundctlDir: string): number | null {
  try {
    const raw = readFileSync(join(groundctlDir, "watch.pid"), "utf8").trim();
    return parseInt(raw) || null;
  } catch {
    return null;
  }
}

/** Return true when a process with the given PID is still alive. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Ingest runner ────────────────────────────────────────────────────────────

/**
 * Run ingest + sync for a single transcript file and print a one-line summary.
 * For Codex sessions, filters out sessions not belonging to projectPath.
 */
async function runIngest(
  transcriptPath: string,
  projectPath: string,
  source: "claude-code" | "codex" = "claude-code"
): Promise<void> {
  const filename = transcriptPath.split("/").slice(-2).join("/");
  console.log(
    chalk.gray(`\n  [${new Date().toLocaleTimeString()}] `) +
    chalk.cyan(`Transcript stable → ingesting ${filename}`)
  );

  try {
    const parsed = source === "codex"
      ? parseCodexTranscript(transcriptPath, projectPath)
      : parseTranscript(transcriptPath, "auto", projectPath);

    // Codex: null means session belongs to a different project — skip silently
    if (!parsed) {
      return;
    }

    const db = await openDb();

    const sessionId = parsed.sessionId;
    const exists = queryOne(db, "SELECT id FROM sessions WHERE id = ?", [sessionId]);

    if (exists) {
      db.run("UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?", [
        parsed.endedAt, parsed.summary, sessionId,
      ]);
    } else {
      db.run(
        "INSERT INTO sessions (id, agent, started_at, ended_at, summary) VALUES (?, ?, ?, ?, ?)",
        [sessionId, parsed.agent, parsed.startedAt, parsed.endedAt, parsed.summary]
      );
    }

    let newFiles = 0;
    for (const file of parsed.filesModified) {
      const dup = queryOne(
        db,
        "SELECT id FROM files_modified WHERE session_id = ? AND path = ?",
        [sessionId, file.path]
      );
      if (!dup) {
        db.run(
          "INSERT INTO files_modified (session_id, path, operation, lines_changed) VALUES (?, ?, ?, ?)",
          [sessionId, file.path, file.operation, file.linesChanged]
        );
        newFiles++;
      }
    }

    let newDecisions = 0;
    for (const d of parsed.decisions) {
      const dup = queryOne(
        db,
        "SELECT id FROM decisions WHERE session_id = ? AND description = ?",
        [sessionId, d.description]
      );
      if (!dup) {
        db.run(
          "INSERT INTO decisions (session_id, description, rationale) VALUES (?, ?, ?)",
          [sessionId, d.description, d.rationale ?? null]
        );
        newDecisions++;
      }
    }

    saveDb();
    closeDb();

    const parts: string[] = [];
    if (newFiles > 0) parts.push(`${newFiles} file${newFiles !== 1 ? "s" : ""}`);
    if (parsed.commits.length > 0) parts.push(`${parsed.commits.length} commit${parsed.commits.length !== 1 ? "s" : ""}`);
    if (newDecisions > 0) parts.push(`${newDecisions} decision${newDecisions !== 1 ? "s" : ""} captured`);
    const summary = parts.length > 0 ? parts.join(", ") : "no new data";
    const agentLabel = source === "codex" ? chalk.blue("[codex] ") : "";

    console.log(chalk.green(`  ✓ ${agentLabel}Session ingested — ${summary}`));

    await syncCommand({ silent: true });
    console.log(chalk.gray("  ↳ PROJECT_STATE.md + AGENTS.md updated"));
  } catch (err) {
    console.log(chalk.red(`  ✗ Ingest failed: ${(err as Error).message}`));
  }
}

// ── Claude Code watcher ──────────────────────────────────────────────────────

function startClaudeWatcher(transcriptDir: string, projectPath: string): void {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const ingested = new Set<string>();
  const fileWatchers = new Map<string, FSWatcher>();

  function schedule(filePath: string): void {
    if (ingested.has(filePath)) return;

    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      pending.delete(filePath);
      if (ingested.has(filePath)) return;
      if (fileSize(filePath) === 0) return;

      ingested.add(filePath);
      fileWatchers.get(filePath)?.close();
      fileWatchers.delete(filePath);

      await runIngest(filePath, projectPath, "claude-code");
    }, DEBOUNCE_MS);

    pending.set(filePath, timer);
  }

  function watchFile(filePath: string): void {
    if (fileWatchers.has(filePath) || ingested.has(filePath)) return;
    try {
      const w = fsWatch(filePath, () => schedule(filePath));
      fileWatchers.set(filePath, w);
    } catch {
      // File might have disappeared — ignore
    }
  }

  // Seed: mark all existing JSONL files as already-seen
  if (existsSync(transcriptDir)) {
    for (const f of readdirSync(transcriptDir)) {
      if (f.endsWith(".jsonl")) ingested.add(join(transcriptDir, f));
    }
  }

  // Watch directory for new JSONL files
  fsWatch(transcriptDir, (_event, filename) => {
    if (!filename?.endsWith(".jsonl")) return;
    const fp = join(transcriptDir, filename);
    if (!existsSync(fp) || ingested.has(fp)) return;

    if (!fileWatchers.has(fp)) {
      watchFile(fp);
      schedule(fp);
    }
  });

  console.log(
    chalk.gray("  Claude Code: ") +
    chalk.blue(transcriptDir.replace(homedir(), "~")) +
    chalk.green(" ✓")
  );
}

// ── Codex watcher ─────────────────────────────────────────────────────────────

function startCodexWatcher(sessionsBaseDir: string, projectPath: string): void {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const ingested = new Set<string>();
  const fileWatchers = new Map<string, FSWatcher>();

  let currentDateDir: string | null = null;
  let dirWatcher: FSWatcher | null = null;

  function schedule(filePath: string): void {
    if (ingested.has(filePath)) return;

    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      pending.delete(filePath);
      if (ingested.has(filePath)) return;
      if (fileSize(filePath) === 0) return;

      ingested.add(filePath);
      fileWatchers.get(filePath)?.close();
      fileWatchers.delete(filePath);

      await runIngest(filePath, projectPath, "codex");
    }, DEBOUNCE_MS);

    pending.set(filePath, timer);
  }

  function watchFile(filePath: string): void {
    if (fileWatchers.has(filePath) || ingested.has(filePath)) return;
    // Lightweight project-match check: read session_meta cwd
    // (file may be empty right after creation — that's fine, we'll check in runIngest)
    if (fileSize(filePath) > 0) {
      const cwd = readCodexSessionCwd(filePath);
      if (cwd && cwd !== projectPath) return; // different project
    }
    try {
      const w = fsWatch(filePath, () => schedule(filePath));
      fileWatchers.set(filePath, w);
      schedule(filePath); // arm debounce immediately
    } catch {
      // ignore
    }
  }

  function hookDateDir(dateDir: string): void {
    if (currentDateDir === dateDir) return;

    // Close previous dir watcher
    dirWatcher?.close();
    currentDateDir = dateDir;

    // Seed: mark all existing JSONL files as already-seen
    if (existsSync(dateDir)) {
      for (const f of readdirSync(dateDir)) {
        if (f.endsWith(".jsonl")) ingested.add(join(dateDir, f));
      }
    }

    // Watch the date dir for new JSONL files
    try {
      dirWatcher = fsWatch(dateDir, (_event, filename) => {
        if (!filename?.endsWith(".jsonl")) return;
        const fp = join(dateDir, filename);
        if (!existsSync(fp) || ingested.has(fp)) return;
        if (!fileWatchers.has(fp)) watchFile(fp);
      });
    } catch {
      // Date dir doesn't exist yet — that's fine, the poller will retry
    }
  }

  // Initial setup for today's dir
  hookDateDir(todayCodexDir(sessionsBaseDir));

  // Poll for midnight rollover (new date dir)
  const datePoller = setInterval(() => {
    const newDir = todayCodexDir(sessionsBaseDir);
    if (newDir !== currentDateDir) hookDateDir(newDir);
  }, DATE_POLL_MS);

  process.on("exit", () => {
    clearInterval(datePoller);
    dirWatcher?.close();
  });

  console.log(
    chalk.gray("  Codex:       ") +
    chalk.blue(sessionsBaseDir.replace(homedir(), "~")) +
    chalk.green(" ✓")
  );
}

// ── Export ───────────────────────────────────────────────────────────────────

export async function watchCommand(options: { daemon?: boolean; projectPath?: string }): Promise<void> {
  const projectPath = options.projectPath
    ? resolve(options.projectPath)
    : process.cwd();

  // ── Daemon mode: fork self without --daemon and exit ──────────────────────
  if (options.daemon) {
    const args = [process.argv[1], "watch", "--project-path", projectPath];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const groundctlDir = join(projectPath, ".groundctl");
    writePidFile(groundctlDir, child.pid!);

    console.log(chalk.green(`\n  ✓ groundctl watch running in background (PID ${child.pid})`));
    console.log(chalk.gray(`  PID saved to .groundctl/watch.pid`));
    console.log(chalk.gray(`  To stop: kill ${child.pid}\n`));
    process.exit(0);
  }

  // ── Check for an already-running watcher ─────────────────────────────────
  const groundctlDir = join(projectPath, ".groundctl");
  const existingPid = readPidFile(groundctlDir);
  if (existingPid && processAlive(existingPid)) {
    console.log(chalk.yellow(`\n  ⚠  A watcher is already running (PID ${existingPid}).`));
    console.log(chalk.gray(`  To stop it: kill ${existingPid}\n`));
    process.exit(1);
  }

  // ── Find Claude Code transcript directory ─────────────────────────────────
  let transcriptDir = findTranscriptDir(projectPath);

  if (!transcriptDir) {
    console.log(chalk.bold("\n  groundctl watch\n"));
    console.log(
      chalk.yellow("  No Claude Code transcript directory found for this project yet.")
    );
    console.log(chalk.gray("  Waiting for first session to start...\n"));

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const dir = findTranscriptDir(projectPath);
        if (dir) {
          clearInterval(interval);
          transcriptDir = dir;
          resolve();
        }
      }, DIR_POLL_MS);
    });
  }

  // ── Print header ──────────────────────────────────────────────────────────
  console.log(chalk.bold("\n  groundctl watch") + chalk.gray(" — auto-ingest on session end\n"));
  console.log(chalk.gray("  Watching:"));

  // ── Start Claude Code watcher ─────────────────────────────────────────────
  startClaudeWatcher(transcriptDir!, projectPath);

  // ── Start Codex watcher (best-effort) ─────────────────────────────────────
  const codexDir = findCodexSessionsDir();
  if (codexDir) {
    startCodexWatcher(codexDir, projectPath);
  } else {
    console.log(
      chalk.gray("  Codex:       ") +
      chalk.gray("~/.codex/sessions not found") +
      chalk.yellow(" ✗")
    );
  }

  console.log(chalk.gray(`\n  Stability threshold: `) + chalk.white(`${DEBOUNCE_MS / 1000}s`));
  console.log(chalk.gray("  Press Ctrl+C to stop.\n"));

  // Keep process alive
  await new Promise<void>(() => {
    process.on("SIGINT", () => {
      console.log(chalk.gray("\n  Watcher stopped.\n"));
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      process.exit(0);
    });
  });
}
