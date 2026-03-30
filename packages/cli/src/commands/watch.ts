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
import { syncCommand } from "./sync.js";
import { queryOne } from "../storage/query.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** ms of silence after last write before we treat a session as finished */
const DEBOUNCE_MS = 8_000;

/** ms between polls when waiting for the transcript dir to appear */
const DIR_POLL_MS = 5_000;

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
 */
async function runIngest(transcriptPath: string, projectPath: string): Promise<void> {
  const filename = transcriptPath.split("/").slice(-2).join("/");
  console.log(
    chalk.gray(`\n  [${new Date().toLocaleTimeString()}] `) +
    chalk.cyan(`Transcript stable → ingesting ${filename}`)
  );

  try {
    const parsed = parseTranscript(transcriptPath, "auto", projectPath);
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
        [sessionId, "claude-code", parsed.startedAt, parsed.endedAt, parsed.summary]
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

    console.log(chalk.green(`  ✓ Session ingested — ${summary}`));

    await syncCommand({ silent: true });
    console.log(chalk.gray("  ↳ PROJECT_STATE.md + AGENTS.md updated"));
  } catch (err) {
    console.log(chalk.red(`  ✗ Ingest failed: ${(err as Error).message}`));
  }
}

// ── Core watcher logic ───────────────────────────────────────────────────────

function startWatcher(transcriptDir: string, projectPath: string): void {
  // Timers waiting to fire per file
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  // Files we've already ingested in this watcher session (prevents double-ingest)
  const ingested = new Set<string>();
  // Per-file fs.FSWatcher instances
  const fileWatchers = new Map<string, FSWatcher>();

  /**
   * Schedule (or re-schedule) an ingest for a transcript file.
   * Resets on every detected write so we only fire when the file is stable
   * for DEBOUNCE_MS — meaning the session has likely ended.
   */
  function schedule(filePath: string): void {
    if (ingested.has(filePath)) return;

    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      pending.delete(filePath);
      if (ingested.has(filePath)) return; // raced with another trigger

      // Skip empty files (session opened but nothing written yet)
      if (fileSize(filePath) === 0) return;

      ingested.add(filePath);
      fileWatchers.get(filePath)?.close();
      fileWatchers.delete(filePath);

      await runIngest(filePath, projectPath);
    }, DEBOUNCE_MS);

    pending.set(filePath, timer);
  }

  /**
   * Start watching a specific JSONL file for content changes.
   * Avoids duplicating watchers.
   */
  function watchFile(filePath: string): void {
    if (fileWatchers.has(filePath) || ingested.has(filePath)) return;
    try {
      const w = fsWatch(filePath, () => {
        schedule(filePath); // every write resets the debounce clock
      });
      fileWatchers.set(filePath, w);
    } catch {
      // File might have disappeared — ignore
    }
  }

  // ── Seed: mark all existing JSONL files as already-seen ──────────────────
  // We don't re-ingest files that existed before the watcher started.
  if (existsSync(transcriptDir)) {
    for (const f of readdirSync(transcriptDir)) {
      if (f.endsWith(".jsonl")) {
        ingested.add(join(transcriptDir, f));
      }
    }
  }

  // ── Watch directory for new JSONL files ───────────────────────────────────
  fsWatch(transcriptDir, (_event, filename) => {
    if (!filename?.endsWith(".jsonl")) return;
    const fp = join(transcriptDir, filename);
    if (!existsSync(fp) || ingested.has(fp)) return;

    // First time we see this file — attach a per-file watcher and arm debounce
    if (!fileWatchers.has(fp)) {
      watchFile(fp);
      schedule(fp);
    }
  });

  console.log(chalk.bold("\n  groundctl watch") + chalk.gray(" — auto-ingest on session end\n"));
  console.log(
    chalk.gray("  Watching: ") +
    chalk.blue(transcriptDir.replace(homedir(), "~"))
  );
  console.log(chalk.gray("  Stability threshold: ") + chalk.white(`${DEBOUNCE_MS / 1000}s`));
  console.log(chalk.gray("  Press Ctrl+C to stop.\n"));
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

    // Store PID in .groundctl/watch.pid
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

  // ── Find transcript directory, waiting if it doesn't exist yet ───────────
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

  startWatcher(transcriptDir!, projectPath);

  // Keep process alive
  await new Promise<void>(() => {
    // Never resolves — we live until Ctrl+C
    process.on("SIGINT", () => {
      console.log(chalk.gray("\n  Watcher stopped.\n"));
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      process.exit(0);
    });
  });
}
