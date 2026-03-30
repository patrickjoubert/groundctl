import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import chalk from "../colors.js";
import type { Database } from "sql.js";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { parseTranscript } from "../ingest/claude-parser.js";
import { syncCommand } from "./sync.js";
import { queryOne } from "../storage/query.js";
import type { ParsedPlannedFeature } from "../ingest/types.js";

interface IngestOptions {
  source: string;
  sessionId?: string;
  transcript?: string;
  projectPath?: string;
  noSync?: boolean;
}

/**
 * Claude Code encodes project paths as directory names by replacing every
 * non-alphanumeric character with "-".
 * e.g. /Users/patrick/EVSpec.io → -Users-patrick-EVSpec-io
 */
function claudeEncode(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Find the most recent transcript file for the current project.
 */
function findLatestTranscript(projectPath: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  let transcriptDir: string | null = null;

  // 1. Exact encoded match
  const projectKey = claudeEncode(projectPath);
  const directMatch = join(projectsDir, projectKey);
  if (existsSync(directMatch)) {
    transcriptDir = directMatch;
  } else {
    // 2. Fuzzy: find dir that ends with the encoded project folder name
    const projectName = projectPath.split("/").pop() ?? "";
    const encodedName = claudeEncode(projectName);
    const dirs = readdirSync(projectsDir);
    for (const d of dirs) {
      if (d.endsWith(`-${encodedName}`) || d.includes(encodedName)) {
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

  // ── Planned features from Claude's plan ─────────────────────────────────
  if (parsed.plannedFeatures.length > 0) {
    const db2 = await openDb();
    // Store in planned_features table regardless of interactive mode
    for (const pf of parsed.plannedFeatures) {
      const dup = queryOne(db2,
        "SELECT id FROM planned_features WHERE session_id = ? AND name = ?",
        [sessionId, pf.name]
      );
      if (!dup) {
        db2.run(
          "INSERT INTO planned_features (session_id, name, raw_text, confidence) VALUES (?, ?, ?, ?)",
          [sessionId, pf.name, pf.rawText, pf.confidence]
        );
      }
    }
    saveDb();

    // Only prompt when running interactively
    if (process.stdout.isTTY) {
      await promptPlannedFeatures(db2, sessionId, parsed.plannedFeatures);
    } else {
      console.log(chalk.gray(
        `  ↳ ${parsed.plannedFeatures.length} planned features detected — run groundctl ingest interactively to import`
      ));
    }
    closeDb();
  }

  if (!options.noSync) {
    console.log("");
    await syncCommand();
  }
}

// ── Planned features prompt ───────────────────────────────────────────────────

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

async function promptPlannedFeatures(
  db: Database,
  sessionId: string,
  features: ParsedPlannedFeature[]
): Promise<void> {
  console.log(chalk.bold(`\n  Detected ${features.length} planned features from Claude's plan:`));
  console.log("");
  for (const f of features) {
    console.log(chalk.gray(`  ○ ${f.name.padEnd(28)}`) + chalk.dim(`${f.rawText.slice(0, 48)}`));
  }
  console.log("");

  const answer = await readLine(chalk.bold("  Import as features? ") + chalk.gray("[y/n] "));
  if (answer !== "y" && answer !== "yes") {
    console.log(chalk.gray("  Skipped.\n"));
    return;
  }

  let imported = 0;
  for (const pf of features) {
    const exists = queryOne(db, "SELECT id FROM features WHERE id = ?", [pf.name]);
    if (!exists) {
      db.run(
        "INSERT INTO features (id, name, status, priority, description) VALUES (?, ?, ?, ?, ?)",
        [pf.name, pf.name, "pending", "medium", `Planned: ${pf.rawText.slice(0, 100)}`]
      );
      imported++;
    }
  }
  // Mark as imported in planned_features
  db.run(
    "UPDATE planned_features SET imported = 1 WHERE session_id = ?",
    [sessionId]
  );
  saveDb();
  console.log(chalk.green(`  ✓ ${imported} features imported\n`));
}
