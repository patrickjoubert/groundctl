import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { parseTranscript } from "../ingest/claude-parser.js";
import { syncCommand } from "./sync.js";
import { queryOne } from "../storage/query.js";

interface IngestOptions {
  source: string;
  sessionId?: string;
  transcript?: string;
  projectPath?: string;
  noSync?: boolean;
}

/**
 * Find the most recent transcript file for the current project.
 */
function findLatestTranscript(projectPath: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  // Convert path to Claude project dir name (replaces / with -)
  const projectKey = projectPath.replace(/\//g, "-");

  let transcriptDir: string | null = null;

  // Direct match
  const directMatch = join(projectsDir, projectKey);
  if (existsSync(directMatch)) {
    transcriptDir = directMatch;
  } else {
    // Fuzzy: find dir that ends with the project folder name
    const projectName = projectPath.split("/").pop() ?? "";
    const dirs = readdirSync(projectsDir);
    for (const d of dirs) {
      if (d.endsWith(`-${projectName}`) || d.includes(projectName.replace(/\//g, "-"))) {
        transcriptDir = join(projectsDir, d);
        break;
      }
    }
  }

  if (!transcriptDir || !existsSync(transcriptDir)) return null;

  // Find most recent .jsonl file
  const jsonlFiles = readdirSync(transcriptDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      path: join(transcriptDir!, f),
    }));

  if (jsonlFiles.length === 0) return null;

  // Sort by filename (UUIDs sort chronologically enough for our purposes)
  jsonlFiles.sort((a, b) => b.name.localeCompare(a.name));
  return jsonlFiles[0].path;
}

export async function ingestCommand(options: IngestOptions): Promise<void> {
  const projectPath = options.projectPath
    ? resolve(options.projectPath)
    : process.cwd();

  const source = options.source ?? "claude-code";

  // Find transcript
  let transcriptPath = options.transcript;
  if (!transcriptPath) {
    transcriptPath = findLatestTranscript(projectPath) ?? undefined;
  }

  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.log(chalk.yellow("\n  No transcript found. Skipping ingest.\n"));
    if (!options.noSync) await syncCommand();
    return;
  }

  console.log(chalk.gray(`\n  Parsing transcript: ${transcriptPath.split("/").slice(-2).join("/")}`));

  const parsed = parseTranscript(transcriptPath, options.sessionId ?? "auto", projectPath);

  const db = await openDb();

  // Upsert session
  const sessionId = options.sessionId ?? parsed.sessionId;
  const sessionExists = queryOne(db, "SELECT id FROM sessions WHERE id = ?", [sessionId]);

  if (sessionExists) {
    db.run(
      "UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?",
      [parsed.endedAt, parsed.summary, sessionId]
    );
  } else {
    db.run(
      "INSERT INTO sessions (id, agent, started_at, ended_at, summary) VALUES (?, ?, ?, ?, ?)",
      [sessionId, source, parsed.startedAt, parsed.endedAt, parsed.summary]
    );
  }

  // Insert files modified (skip duplicates by path+session)
  let newFiles = 0;
  for (const file of parsed.filesModified) {
    const exists = queryOne(
      db,
      "SELECT id FROM files_modified WHERE session_id = ? AND path = ?",
      [sessionId, file.path]
    );
    if (!exists) {
      db.run(
        "INSERT INTO files_modified (session_id, path, operation, lines_changed) VALUES (?, ?, ?, ?)",
        [sessionId, file.path, file.operation, file.linesChanged]
      );
      newFiles++;
    }
  }

  // Insert decisions
  let newDecisions = 0;
  for (const d of parsed.decisions) {
    const exists = queryOne(
      db,
      "SELECT id FROM decisions WHERE session_id = ? AND description = ?",
      [sessionId, d.description]
    );
    if (!exists) {
      db.run(
        "INSERT INTO decisions (session_id, description, rationale) VALUES (?, ?, ?)",
        [sessionId, d.description, d.rationale ?? null]
      );
      newDecisions++;
    }
  }

  saveDb();
  closeDb();

  console.log(
    chalk.green(
      `  ✓ Ingested session ${sessionId}: ` +
        `${newFiles} files, ${parsed.commits.length} commits, ${newDecisions} decisions`
    )
  );

  if (parsed.decisions.length > 0 && newDecisions > 0) {
    console.log(chalk.gray(`\n  Decisions captured:`));
    for (const d of parsed.decisions.slice(0, 5)) {
      const conf = d.confidence === "low" ? chalk.gray(" (low confidence)") : "";
      console.log(chalk.gray(`    • ${d.description.slice(0, 80)}${conf}`));
    }
  }

  if (!options.noSync) {
    console.log("");
    await syncCommand();
  }
}
