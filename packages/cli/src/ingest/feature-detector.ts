/**
 * feature-detector.ts
 *
 * Uses Claude API (haiku) to analyse a project's git history + file tree
 * and propose meaningful product features, then prompts the user to confirm.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";
import type { Database } from "sql.js";
import chalk from "chalk";
import { saveDb } from "../storage/db.js";
import { queryOne } from "../storage/query.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DetectedFeature {
  name:        string;
  status:      "done" | "open";
  priority:    "critical" | "high" | "medium" | "low";
  description: string;
}

// ── Context collection ───────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function collectContext(projectPath: string): string {
  const parts: string[] = [];

  // 1. Git log (commit messages, up to 150 lines)
  const gitLog = run("git log --oneline --no-merges", projectPath);
  if (gitLog.trim()) {
    const lines = gitLog.trim().split("\n").slice(0, 150).join("\n");
    parts.push(`## Git history (${lines.split("\n").length} commits)\n${lines}`);
  }

  // 2. Files modified per session (git diff --stat recent commits)
  const diffStat = run("git log --stat --no-merges --oneline -30", projectPath);
  if (diffStat.trim()) {
    parts.push(`## Recent commit file changes\n${diffStat.trim().slice(0, 3000)}`);
  }

  // 3. File tree — source files only, skip noise
  const find = run(
    [
      "find . -type f",
      "-not -path '*/node_modules/*'",
      "-not -path '*/.git/*'",
      "-not -path '*/dist/*'",
      "-not -path '*/.groundctl/*'",
      "-not -path '*/build/*'",
      "-not -path '*/coverage/*'",
      "-not -path '*/.venv/*'",
      "-not -path '*/__pycache__/*'",
      "-not -path '*/.pytest_cache/*'",
      "-not -path '*/vendor/*'",
      "-not -path '*/.next/*'",
      "-not -name '*.lock'",
      "-not -name '*.log'",
      "-not -name '*.pyc'",
      "| sort | head -120",
    ].join(" "),
    projectPath
  );
  if (find.trim()) {
    parts.push(`## Project file structure\n${find.trim()}`);
  }

  // 4. README.md (first 3 000 chars)
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, "utf-8").slice(0, 3_000);
    parts.push(`## README.md\n${readme}`);
  }

  // 5. Existing PROJECT_STATE.md context (if any)
  const psPath = join(projectPath, "PROJECT_STATE.md");
  if (existsSync(psPath)) {
    const ps = readFileSync(psPath, "utf-8").slice(0, 2_000);
    parts.push(`## Existing PROJECT_STATE.md\n${ps}`);
  }

  return parts.join("\n\n");
}

// ── Claude API call ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a product analyst. Analyze this project and identify the main product features.";

const USER_TEMPLATE = (context: string) => `Based on this git history and project structure, identify the product features with their status and priority.

Rules:
- Features are functional capabilities, not technical tasks
- Maximum 12 features
- status: "done" if all related commits are old and nothing is open, otherwise "open"
- priority: critical/high/medium/low
- name: short, kebab-case, human-readable (e.g. "user-auth", "data-pipeline")
- description: one sentence, what the feature does for the user

Respond ONLY with valid JSON, no markdown, no explanation:
{"features":[{"name":"...","status":"done","priority":"high","description":"..."}]}

Project context:
${context}`;

function httpsPost(opts: {
  apiKey: string;
  model: string;
  system: string;
  userMessage: string;
  maxTokens?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: "user", content: opts.userMessage }],
    });

    const req = httpsRequest(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => { resolve(data); });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Extract the text of the first content block from a Messages API response. */
function extractText(raw: string): string {
  const json = JSON.parse(raw) as {
    content?: Array<{ type: string; text: string }>;
    error?:   { type: string; message: string };
  };
  if (json.error) throw new Error(`API error: ${json.error.message}`);
  const block = (json.content ?? []).find((b) => b.type === "text");
  if (!block) throw new Error("No text block in API response");
  return block.text;
}

/** Pull valid JSON out of the model reply, tolerating stray markdown fences. */
function parseFeatureJson(text: string): DetectedFeature[] {
  // Strip markdown code fences if present
  const stripped = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();

  let obj: { features?: unknown };
  try {
    obj = JSON.parse(stripped) as { features?: unknown };
  } catch {
    // Try to extract the first {...} block
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Could not parse JSON from model response");
    obj = JSON.parse(match[0]) as { features?: unknown };
  }

  if (!Array.isArray(obj.features)) throw new Error("Response missing 'features' array");

  return (obj.features as Array<Record<string, string>>).map((f) => ({
    name:        String(f.name        ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    status:      (f.status === "done" ? "done" : "open") as DetectedFeature["status"],
    priority:    (["critical","high","medium","low"].includes(f.priority)
                    ? f.priority : "medium") as DetectedFeature["priority"],
    description: String(f.description ?? "").slice(0, 120),
  })).filter((f) => f.name.length >= 2);
}

async function callClaude(apiKey: string, context: string): Promise<DetectedFeature[]> {
  const raw = await httpsPost({
    apiKey,
    model: "claude-haiku-4-5-20251001",
    system: SYSTEM_PROMPT,
    userMessage: USER_TEMPLATE(context),
    maxTokens: 1024,
  });
  const text = extractText(raw);
  return parseFeatureJson(text);
}

// ── Interactive confirmation ──────────────────────────────────────────────────

function renderFeatureList(features: DetectedFeature[]): void {
  console.log(chalk.bold(`\n  Detected ${features.length} features:\n`));
  for (const f of features) {
    const statusIcon = f.status === "done" ? chalk.green("✓") : chalk.gray("○");
    const prioColor  = f.priority === "critical" || f.priority === "high"
      ? chalk.red : chalk.gray;
    console.log(
      `  ${statusIcon} ${chalk.white(f.name.padEnd(28))}` +
      prioColor(`(${f.priority}, ${f.status})`.padEnd(18)) +
      chalk.gray(f.description)
    );
  }
  console.log("");
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

async function editInEditor(features: DetectedFeature[]): Promise<DetectedFeature[] | null> {
  const tmpPath = join(tmpdir(), `groundctl-features-${Date.now()}.json`);
  writeFileSync(tmpPath, JSON.stringify({ features }, null, 2), "utf-8");

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  try {
    execSync(`${editor} "${tmpPath}"`, { stdio: "inherit" });
  } catch {
    console.log(chalk.red("  Editor exited with error — using original features."));
    return features;
  }

  try {
    const edited = readFileSync(tmpPath, "utf-8");
    return parseFeatureJson(edited);
  } catch (err) {
    console.log(chalk.red(`  Could not parse edited JSON: ${(err as Error).message}`));
    return null;
  }
}

// ── DB import ────────────────────────────────────────────────────────────────

function importFeatures(db: Database, features: DetectedFeature[]): void {
  // Remove features that have no active claims and are still pending
  // (i.e., auto-detected junk from previous PROJECT_STATE.md parsing)
  db.run(
    `DELETE FROM features
     WHERE id NOT IN (SELECT DISTINCT feature_id FROM claims)
       AND status = 'pending'`
  );

  for (const f of features) {
    const id = f.name;
    const status = f.status === "done" ? "done" : "pending";
    const exists = queryOne(db, "SELECT id FROM features WHERE id = ?", [id]);
    if (!exists) {
      db.run(
        "INSERT INTO features (id, name, status, priority, description) VALUES (?, ?, ?, ?, ?)",
        [id, f.name, status, f.priority, f.description]
      );
    } else {
      // Update description/priority but don't downgrade status if already done
      db.run(
        `UPDATE features
         SET description = ?, priority = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [f.description, f.priority, id]
      );
    }
  }
  saveDb();
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Detect features using Claude API, prompt for confirmation, import to DB.
 * Returns true when features were imported.
 */
export async function detectAndImportFeatures(
  db: Database,
  projectPath: string
): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log(chalk.yellow(
      "\n  Smart feature detection disabled — ANTHROPIC_API_KEY not set."
    ));
    console.log(chalk.gray("  To enable:"));
    console.log(chalk.gray("    export ANTHROPIC_API_KEY=sk-ant-..."));
    console.log(chalk.gray(
      "\n  Or add features manually:\n" +
      "    groundctl add feature -n 'my-feature'\n"
    ));
    return false;
  }

  console.log(chalk.gray("  Collecting project context..."));
  const context = collectContext(projectPath);

  console.log(chalk.gray("  Asking Claude to detect features..."));

  let features: DetectedFeature[];
  try {
    features = await callClaude(apiKey, context);
  } catch (err) {
    console.log(chalk.red(`  ✗ Feature detection failed: ${(err as Error).message}`));
    console.log(chalk.gray("  Add features manually with: groundctl add feature -n 'my-feature'\n"));
    return false;
  }

  if (features.length === 0) {
    console.log(chalk.yellow("  No features detected — add them manually.\n"));
    return false;
  }

  renderFeatureList(features);

  // Interactive loop — retry on "edit" until user confirms or cancels
  let pending = features;
  while (true) {
    const answer = await readLine(
      chalk.bold("  Import these features? ") + chalk.gray("[y/n/edit] ") + ""
    );

    if (answer === "y" || answer === "yes") {
      importFeatures(db, pending);
      console.log(chalk.green(`\n  ✓ ${pending.length} features imported\n`));
      return true;
    }

    if (answer === "n" || answer === "no") {
      console.log(chalk.gray("  Skipped — no features imported.\n"));
      return false;
    }

    if (answer === "e" || answer === "edit") {
      const edited = await editInEditor(pending);
      if (edited && edited.length > 0) {
        pending = edited;
        renderFeatureList(pending);
      } else {
        console.log(chalk.yellow("  No valid features after edit — try again.\n"));
      }
      continue;
    }

    // Unknown answer — re-prompt
    console.log(chalk.gray("  Please answer y, n, or edit."));
  }
}
