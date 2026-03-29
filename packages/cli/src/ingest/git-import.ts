import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "sql.js";
import { saveDb } from "../storage/db.js";
import { queryOne } from "../storage/query.js";

interface GitCommit {
  hash: string;
  message: string;
  date: string;
  filesChanged: GitFileChange[];
}

interface GitFileChange {
  path: string;
  operation: "created" | "modified" | "deleted";
  insertions: number;
  deletions: number;
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function parseGitLog(cwd: string): GitCommit[] {
  // Get all commits with short hash, date, message
  const logOutput = run(
    'git log --format="%H|||%ai|||%s" --no-merges',
    cwd
  );
  if (!logOutput.trim()) return [];

  const commits: GitCommit[] = [];

  for (const line of logOutput.trim().split("\n")) {
    const parts = line.split("|||");
    if (parts.length < 3) continue;
    const [hash, date, ...messageParts] = parts;
    const message = messageParts.join("|||").trim();

    // Get files changed for this commit
    const diffOutput = run(
      `git diff-tree --no-commit-id -r --name-status "${hash.trim()}"`,
      cwd
    );
    const filesChanged: GitFileChange[] = [];

    for (const diffLine of diffOutput.trim().split("\n")) {
      if (!diffLine.trim()) continue;
      const [status, ...pathParts] = diffLine.trim().split(/\s+/);
      const filePath = pathParts.join(" ");
      if (!filePath) continue;

      let operation: GitFileChange["operation"] = "modified";
      if (status.startsWith("A")) operation = "created";
      else if (status.startsWith("D")) operation = "deleted";
      else if (status.startsWith("M") || status.startsWith("R")) operation = "modified";

      // Get line count changes
      const numstatLine = run(
        `git diff-tree --no-commit-id -r --numstat "${hash.trim()}" -- "${filePath}"`,
        cwd
      );
      let insertions = 0;
      let deletions = 0;
      if (numstatLine.trim()) {
        const [ins, del] = numstatLine.trim().split(/\s+/);
        insertions = parseInt(ins) || 0;
        deletions = parseInt(del) || 0;
      }

      filesChanged.push({ path: filePath, operation, insertions, deletions });
    }

    commits.push({
      hash: hash.trim(),
      message,
      date: date.trim(),
      filesChanged,
    });
  }

  return commits.reverse(); // chronological order
}

/**
 * Parse a PROJECT_STATE.md file to extract feature names and status.
 */
function parseProjectStateMd(content: string): Array<{ name: string; status: string; priority: string }> {
  const features: Array<{ name: string; status: string; priority: string }> = [];

  const lines = content.split("\n");
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      section = trimmed.toLowerCase();
      continue;
    }

    // Skip non-feature sections: decisions, recent sessions, debt notes
    if (
      section.includes("decision") ||
      section.includes("session") ||
      section.includes("debt") ||
      section.includes("note")
    ) continue;

    if (!trimmed.startsWith("- ") && !trimmed.startsWith("* ")) continue;

    const item = trimmed.slice(2).trim();
    if (!item || item.length < 3) continue;

    // Extract feature name (before any parenthetical)
    const name = item.split("(")[0].split("→")[0].split("—")[0].trim();
    // Reject obviously bad feature names: too short, too long, or looks like a date/sentence
    if (!name || name.length < 3 || name.length > 80) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(name)) continue; // date strings
    if (name.split(" ").length > 8) continue;        // too many words = sentence, not feature name

    let status = "pending";
    let priority = "medium";

    if (section.includes("built") || section.includes("done") || section.includes("complete")) {
      status = "done";
    } else if (section.includes("claimed") || section.includes("in progress") || section.includes("current")) {
      status = "in_progress";
    } else if (section.includes("available") || section.includes("next")) {
      status = "pending";
    } else if (section.includes("blocked")) {
      status = "blocked";
    }

    // Extract priority from item text
    if (/priority:\s*critical|critical\)/i.test(item)) priority = "critical";
    else if (/priority:\s*high|high\)/i.test(item)) priority = "high";
    else if (/priority:\s*low|low\)/i.test(item)) priority = "low";

    features.push({ name, status, priority });
  }

  return features;
}

function featureIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Import git history into groundctl SQLite database.
 * Creates sessions from commits and populates files_modified.
 */
export function importFromGit(db: Database, projectPath: string): {
  sessionsCreated: number;
  featuresImported: number;
} {
  let sessionsCreated = 0;
  let featuresImported = 0;

  // 1. Import features from PROJECT_STATE.md if it exists
  const psMdPath = join(projectPath, "PROJECT_STATE.md");
  if (existsSync(psMdPath)) {
    const content = readFileSync(psMdPath, "utf-8");
    const features = parseProjectStateMd(content);

    for (const feat of features) {
      const id = featureIdFromName(feat.name);
      if (!id) continue;

      const exists = queryOne(db, "SELECT id FROM features WHERE id = ?", [id]);
      if (!exists) {
        db.run(
          "INSERT INTO features (id, name, status, priority) VALUES (?, ?, ?, ?)",
          [id, feat.name, feat.status, feat.priority]
        );
        featuresImported++;
      }
    }
  }

  // 2. Import git commits as sessions
  const commits = parseGitLog(projectPath);
  if (commits.length === 0) return { sessionsCreated, featuresImported };

  // Group commits into "sessions" — heuristic: commits within 4 hours = same session
  const SESSION_GAP_MS = 4 * 60 * 60 * 1000;
  const sessions: GitCommit[][] = [];
  let currentSession: GitCommit[] = [];
  let lastDate: Date | null = null;

  for (const commit of commits) {
    const commitDate = new Date(commit.date);
    if (lastDate && commitDate.getTime() - lastDate.getTime() > SESSION_GAP_MS) {
      if (currentSession.length > 0) sessions.push(currentSession);
      currentSession = [];
    }
    currentSession.push(commit);
    lastDate = commitDate;
  }
  if (currentSession.length > 0) sessions.push(currentSession);

  // Create sessions S1, S2, ... Sn
  for (let i = 0; i < sessions.length; i++) {
    const sessionCommits = sessions[i];
    const sessionId = `S${i + 1}`;
    const firstCommit = sessionCommits[0];
    const lastCommit = sessionCommits[sessionCommits.length - 1];

    const exists = queryOne(db, "SELECT id FROM sessions WHERE id = ?", [sessionId]);
    if (exists) continue;

    // Build summary from commit messages
    const summary = sessionCommits
      .map((c) => c.message)
      .slice(0, 3)
      .join("; ")
      .slice(0, 200);

    db.run(
      "INSERT INTO sessions (id, agent, started_at, ended_at, summary) VALUES (?, 'claude-code', ?, ?, ?)",
      [sessionId, firstCommit.date, lastCommit.date, summary]
    );
    sessionsCreated++;

    // Insert files modified for this session
    const filesInSession = new Map<string, GitFileChange>();
    for (const commit of sessionCommits) {
      for (const file of commit.filesChanged) {
        const existing = filesInSession.get(file.path);
        if (!existing) {
          filesInSession.set(file.path, { ...file });
        } else {
          existing.insertions += file.insertions;
          existing.deletions += file.deletions;
          // If file was created then later modified, keep "created"
          if (file.operation === "deleted") existing.operation = "deleted";
        }
      }
    }

    for (const [, file] of filesInSession) {
      db.run(
        "INSERT INTO files_modified (session_id, path, operation, lines_changed) VALUES (?, ?, ?, ?)",
        [
          sessionId,
          file.path,
          file.operation,
          file.insertions + file.deletions,
        ]
      );
    }
  }

  saveDb();

  return { sessionsCreated, featuresImported };
}
