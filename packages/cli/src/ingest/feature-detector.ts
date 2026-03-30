/**
 * feature-detector.ts
 *
 * Detects product features from project context using:
 *   1. detect.groundctl.org proxy (zero config, default)
 *   2. Direct ANTHROPIC_API_KEY (fallback if proxy fails)
 *   3. Basic git-log heuristic (offline fallback)
 *
 * Then prompts for confirmation before importing to SQLite.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";
import type { Database } from "sql.js";
import chalk from "../colors.js";
import { saveDb } from "../storage/db.js";
import { queryOne } from "../storage/query.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DetectedFeature {
  name:        string;
  status:      "done" | "open";
  priority:    "critical" | "high" | "medium" | "low";
  description: string;
}

interface ContextParts {
  gitLog?:       string;
  fileTree?:     string;
  readme?:       string;
  projectState?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PROXY_URL    = "https://detect.groundctl.org/detect";
const USER_AGENT   = "groundctl-cli/0.5.0 Node.js"; // updated with package version
const MODEL        = "claude-haiku-4-5-20251001";
const SYSTEM_PROMPT =
  "You are a product analyst. Analyze this project and identify the main product features.";

// ── Context collection ───────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function collectContextParts(projectPath: string): ContextParts {
  const gitLog = run("git log --oneline --no-merges", projectPath);
  const fileTree = run(
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

  const readmePath = join(projectPath, "README.md");
  const readme = existsSync(readmePath)
    ? readFileSync(readmePath, "utf-8").slice(0, 3_000)
    : undefined;

  const psPath = join(projectPath, "PROJECT_STATE.md");
  const projectState = existsSync(psPath)
    ? readFileSync(psPath, "utf-8").slice(0, 2_000)
    : undefined;

  return {
    gitLog:       gitLog.trim().split("\n").slice(0, 150).join("\n") || undefined,
    fileTree:     fileTree.trim() || undefined,
    readme,
    projectState,
  };
}

function buildContextString(parts: ContextParts): string {
  const sections: string[] = [];
  if (parts.gitLog)       sections.push(`## Git history\n${parts.gitLog}`);
  if (parts.fileTree)     sections.push(`## File structure\n${parts.fileTree}`);
  if (parts.readme)       sections.push(`## README\n${parts.readme}`);
  if (parts.projectState) sections.push(`## Existing PROJECT_STATE.md\n${parts.projectState}`);
  return sections.join("\n\n");
}

// ── JSON parsing ──────────────────────────────────────────────────────────────

function normaliseFeatures(raw: Array<Record<string, string>>): DetectedFeature[] {
  return raw.map((f) => ({
    name:        String(f.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    status:      (f.status === "done" ? "done" : "open") as DetectedFeature["status"],
    priority:    (["critical","high","medium","low"].includes(f.priority) ? f.priority : "medium") as DetectedFeature["priority"],
    description: String(f.description ?? "").slice(0, 120),
  })).filter((f) => f.name.length >= 2);
}

function parseFeatureJson(text: string): DetectedFeature[] {
  const stripped = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
  let obj: { features?: unknown };
  try { obj = JSON.parse(stripped) as { features?: unknown }; }
  catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No JSON found in response");
    obj = JSON.parse(m[0]) as { features?: unknown };
  }
  if (!Array.isArray(obj.features)) throw new Error("Response missing 'features' array");
  return normaliseFeatures(obj.features as Array<Record<string, string>>);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsPost(url: string, body: object, extraHeaders?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed  = new URL(url);
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers: {
          "content-type":   "application/json",
          "content-length": Buffer.byteLength(bodyStr),
          "user-agent":     USER_AGENT,
          ...extraHeaders,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          if ((res.statusCode ?? 200) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.setTimeout(15_000, () => { req.destroy(new Error("Request timeout")); });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Detection strategies ──────────────────────────────────────────────────────

/** Strategy 1: call detect.groundctl.org proxy (zero config). */
async function callProxy(parts: ContextParts): Promise<DetectedFeature[]> {
  const raw = await httpsPost(PROXY_URL, parts);
  const resp = JSON.parse(raw) as { features?: Array<Record<string, string>>; error?: string };
  if (resp.error) throw new Error(resp.error);
  if (!Array.isArray(resp.features)) throw new Error("No features in proxy response");
  return normaliseFeatures(resp.features);
}

/** Strategy 2: call Anthropic API directly with ANTHROPIC_API_KEY. */
async function callDirectApi(apiKey: string, parts: ContextParts): Promise<DetectedFeature[]> {
  const userMsg = `Based on this project context, identify the product features.

Rules:
- Features are functional capabilities, not technical tasks
- Maximum 12 features
- status: "done" if clearly shipped, otherwise "open"
- priority: critical/high/medium/low
- name: short, kebab-case

Respond ONLY with valid JSON, no markdown:
{"features":[{"name":"...","status":"done","priority":"high","description":"..."}]}

${buildContextString(parts)}`;

  const raw = await httpsPost(
    "https://api.anthropic.com/v1/messages",
    { model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: "user", content: userMsg }] },
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
  );
  const resp = JSON.parse(raw) as {
    content?: Array<{ type: string; text: string }>;
    error?: { message: string };
  };
  if (resp.error) throw new Error(resp.error.message);
  const block = (resp.content ?? []).find((b) => b.type === "text");
  if (!block) throw new Error("Empty response from API");
  return parseFeatureJson(block.text);
}

/** Strategy 3: basic heuristic from git commit messages (offline fallback). */
function basicHeuristic(projectPath: string): DetectedFeature[] {
  const log = run("git log --oneline --no-merges", projectPath);
  if (!log.trim()) return [];

  const seen = new Set<string>();
  const features: DetectedFeature[] = [];

  for (const line of log.trim().split("\n").slice(0, 60)) {
    const msg = line.replace(/^[a-f0-9]+ /, "").toLowerCase();
    // Match patterns like "feat: user-auth", "add user auth", "implement data pipeline"
    const m = msg.match(/(?:feat(?:ure)?[:,\s]+|add\s+|implement\s+|build\s+|create\s+|setup\s+)([a-z][\w\s-]{2,40})/);
    if (!m) continue;
    const raw  = m[1].trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const name = raw.slice(0, 30);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    features.push({ name, status: "done", priority: "medium", description: `Detected from: ${line.slice(8, 80)}` });
    if (features.length >= 10) break;
  }
  return features;
}

// ── Interactive confirmation ──────────────────────────────────────────────────

function renderFeatureList(features: DetectedFeature[]): void {
  console.log(chalk.bold(`\n  Detected ${features.length} features:\n`));
  for (const f of features) {
    const icon    = f.status === "done" ? chalk.green("✓") : chalk.gray("○");
    const prioCh  = f.priority === "critical" || f.priority === "high" ? chalk.red : chalk.gray;
    const meta    = prioCh(`(${f.priority}, ${f.status})`.padEnd(16));
    console.log(`  ${icon} ${chalk.white(f.name.padEnd(28))}${meta}  ${chalk.gray(f.description)}`);
  }
  console.log("");
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

async function editInEditor(features: DetectedFeature[]): Promise<DetectedFeature[] | null> {
  const tmp = join(tmpdir(), `groundctl-features-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify({ features }, null, 2), "utf-8");
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  try { execSync(`${editor} "${tmp}"`, { stdio: "inherit" }); }
  catch { return features; }
  try { return parseFeatureJson(readFileSync(tmp, "utf-8")); }
  catch (e) { console.log(chalk.red(`  Parse error: ${(e as Error).message}`)); return null; }
}

// ── DB import ─────────────────────────────────────────────────────────────────

function importFeatures(db: Database, features: DetectedFeature[]): void {
  // Remove unclaimed pending features (cleanup from old heuristic imports)
  db.run(`DELETE FROM features WHERE id NOT IN (SELECT DISTINCT feature_id FROM claims) AND status = 'pending'`);

  for (const f of features) {
    const status = f.status === "done" ? "done" : "pending";
    if (!queryOne(db, "SELECT id FROM features WHERE id = ?", [f.name])) {
      db.run(
        "INSERT INTO features (id, name, status, priority, description) VALUES (?, ?, ?, ?, ?)",
        [f.name, f.name, status, f.priority, f.description]
      );
    } else {
      db.run(
        "UPDATE features SET description = ?, priority = ?, updated_at = datetime('now') WHERE id = ?",
        [f.description, f.priority, f.name]
      );
    }
  }
  saveDb();
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function detectAndImportFeatures(
  db: Database,
  projectPath: string
): Promise<boolean> {
  process.stdout.write(chalk.gray("  Detecting features..."));

  const parts  = collectContextParts(projectPath);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let features: DetectedFeature[] = [];
  let source   = "";

  // ── Try proxy first ───────────────────────────────────────────────────────
  try {
    features = await callProxy(parts);
    source   = "proxy";
  } catch {
    // ── Fallback: direct API key ────────────────────────────────────────────
    if (apiKey) {
      try {
        features = await callDirectApi(apiKey, parts);
        source   = "api";
      } catch {
        // ── Fallback: basic heuristic ─────────────────────────────────────
        features = basicHeuristic(projectPath);
        source   = "heuristic";
      }
    } else {
      features = basicHeuristic(projectPath);
      source   = "heuristic";
    }
  }

  // Clear the "Detecting features..." line
  process.stdout.write("\r" + " ".repeat(30) + "\r");

  if (features.length === 0) {
    console.log(chalk.yellow("  No features detected — add them manually with groundctl add feature.\n"));
    return false;
  }

  const sourceLabel =
    source === "proxy"     ? chalk.green("(via detect.groundctl.org)") :
    source === "api"       ? chalk.green("(via ANTHROPIC_API_KEY)") :
    chalk.yellow("(basic heuristic — set ANTHROPIC_API_KEY for better results)");

  renderFeatureList(features);
  console.log(chalk.gray(`  Source: ${sourceLabel}\n`));

  // Interactive loop
  let pending = features;
  while (true) {
    const answer = await readLine(chalk.bold("  Import these features? ") + chalk.gray("[y/n/edit] "));

    if (answer === "y" || answer === "yes") {
      importFeatures(db, pending);
      console.log(chalk.green(`\n  ✓ ${pending.length} features imported\n`));
      return true;
    }
    if (answer === "n" || answer === "no") {
      console.log(chalk.gray("  Skipped.\n"));
      return false;
    }
    if (answer === "e" || answer === "edit") {
      const edited = await editInEditor(pending);
      if (edited && edited.length > 0) { pending = edited; renderFeatureList(pending); }
      else console.log(chalk.yellow("  No valid features after edit.\n"));
      continue;
    }
    console.log(chalk.gray("  Please answer y, n, or edit."));
  }
}
