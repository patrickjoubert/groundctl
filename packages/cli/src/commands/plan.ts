/**
 * plan.ts
 *
 * groundctl plan [description] [--replan]
 *
 * Mode 1 — with description arg: plan from scratch
 * Mode 2 — no args: prompt interactively
 * Mode 3 — --replan: suggest new features based on what's built
 *
 * Calls detect.groundctl.org/plan (proxy) or ANTHROPIC_API_KEY (fallback).
 * Imports features + dependencies to SQLite.
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import chalk from "../colors.js";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface PlannedFeature {
  name:        string;
  description: string;
  priority:    "critical" | "high" | "medium" | "low";
  depends_on:  string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const PROXY_PLAN_URL = "https://detect.groundctl.org/plan";
const USER_AGENT     = "groundctl-cli/0.6.0 Node.js";
const MODEL          = "claude-haiku-4-5-20251001";

const PLAN_SYSTEM =
  "You are a product architect. Break product goals into atomic, session-sized features with clear dependencies.";

// ── HTTP helper ───────────────────────────────────────────────────────────────

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
    req.setTimeout(20_000, () => { req.destroy(new Error("Request timeout")); });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Plan prompt builders ──────────────────────────────────────────────────────

function buildPlanPrompt(description: string): string {
  return `Break this product goal into 8-12 atomic features.
Each feature should be buildable in one Claude Code session (1-3 hours).
Identify dependencies: a feature depends_on another if it must be built first.
Use short kebab-case names (2-5 words).

Goal: ${description}

Respond ONLY with valid JSON, no markdown:
{"features":[{"name":"setup-project","description":"Initialize repo, install deps","priority":"high","depends_on":[]},{"name":"build-api","description":"REST endpoints","priority":"high","depends_on":["setup-project"]}]}`;
}

function buildReplanPrompt(done: string[], pending: string[], openCount: number): string {
  return `Given the features already built in this product, suggest what should be built next.
Propose 4-8 new features that complete the product vision.
Focus on features that are missing, not just variations of what's done.

Already built (${done.length}): ${done.join(", ")}
${openCount > 0 ? `In progress / planned (${openCount}): ${pending.slice(0, 10).join(", ")}` : ""}

Respond ONLY with valid JSON, no markdown:
{"features":[{"name":"...","description":"...","priority":"high","depends_on":[]}]}`;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parsePlanJson(text: string): PlannedFeature[] {
  const stripped = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
  let obj: { features?: unknown };
  try { obj = JSON.parse(stripped) as { features?: unknown }; }
  catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No JSON found in response");
    obj = JSON.parse(m[0]) as { features?: unknown };
  }
  if (!Array.isArray(obj.features)) throw new Error("Response missing 'features' array");

  return (obj.features as Array<Record<string, unknown>>)
    .filter((f) => typeof f.name === "string" && (f.name as string).length > 0)
    .map((f) => ({
      name:        normalise(String(f.name)),
      description: String(f.description ?? "").slice(0, 120),
      priority:    (["critical","high","medium","low"].includes(String(f.priority))
                    ? f.priority : "medium") as PlannedFeature["priority"],
      depends_on:  (Array.isArray(f.depends_on) ? f.depends_on as string[] : []).map(normalise),
    }))
    .filter((f) => f.name.length >= 2);
}

// ── API callers ───────────────────────────────────────────────────────────────

async function callProxy(prompt: string): Promise<PlannedFeature[]> {
  const raw  = await httpsPost(PROXY_PLAN_URL, { prompt });
  const resp = JSON.parse(raw) as { features?: unknown; error?: string };
  if (resp.error) throw new Error(resp.error);
  return parsePlanJson(raw);
}

async function callDirectApi(apiKey: string, prompt: string): Promise<PlannedFeature[]> {
  const raw = await httpsPost(
    "https://api.anthropic.com/v1/messages",
    {
      model:      MODEL,
      max_tokens: 1500,
      system:     PLAN_SYSTEM,
      messages:   [{ role: "user", content: prompt }],
    },
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
  );
  const resp = JSON.parse(raw) as {
    content?: Array<{ type: string; text: string }>;
    error?: { message: string };
  };
  if (resp.error) throw new Error(resp.error.message);
  const block = (resp.content ?? []).find((b) => b.type === "text");
  if (!block) throw new Error("Empty response from API");
  return parsePlanJson(block.text);
}

// ── Display ───────────────────────────────────────────────────────────────────

function renderPlan(features: PlannedFeature[]): void {
  console.log(chalk.bold(`\n  ${features.length} features planned:\n`));
  for (const f of features) {
    const priCh = f.priority === "critical" || f.priority === "high" ? chalk.red : chalk.gray;
    const depStr = f.depends_on.length > 0
      ? chalk.dim(`  ← ${f.depends_on.join(", ")}`)
      : "";
    console.log(
      `  ${chalk.gray("○")} ${chalk.white(f.name.padEnd(28))}${priCh(`(${f.priority})`.padEnd(12))}` +
      chalk.gray(f.description.slice(0, 40)) + depStr
    );
  }
  console.log("");
}

// ── Interactive helpers ───────────────────────────────────────────────────────

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function editInEditor(features: PlannedFeature[]): Promise<PlannedFeature[] | null> {
  const tmp = join(tmpdir(), `groundctl-plan-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify({ features }, null, 2), "utf-8");
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  try { execSync(`${editor} "${tmp}"`, { stdio: "inherit" }); } catch { return features; }
  try { return parsePlanJson(readFileSync(tmp, "utf-8")); }
  catch (e) { console.log(chalk.red(`  Parse error: ${(e as Error).message}`)); return null; }
}

// ── DB import ─────────────────────────────────────────────────────────────────

async function importPlan(features: PlannedFeature[], groupName?: string): Promise<void> {
  const db = await openDb();

  // Resolve group_id if a group name is provided
  let groupId: number | null = null;
  if (groupName) {
    const grp = queryOne<{ id: number }>(db,
      "SELECT id FROM feature_groups WHERE name = ? OR label = ? LIMIT 1",
      [groupName, groupName]
    );
    groupId = grp?.id ?? null;
  }

  // Import features
  let added = 0;
  let updated = 0;
  for (const f of features) {
    const exists = queryOne(db, "SELECT id FROM features WHERE id = ?", [f.name]);
    if (!exists) {
      db.run(
        `INSERT INTO features (id, name, status, priority, description, group_id)
         VALUES (?, ?, 'pending', ?, ?, ?)`,
        [f.name, f.name, f.priority, f.description, groupId]
      );
      added++;
    } else {
      db.run(
        "UPDATE features SET description = ?, priority = ?, updated_at = datetime('now') WHERE id = ?",
        [f.description, f.priority, f.name]
      );
      updated++;
    }
  }

  // Import dependencies (skip self-deps and unknowns)
  let depsAdded = 0;
  for (const f of features) {
    for (const dep of f.depends_on) {
      if (dep === f.name) continue;
      const depExists = queryOne(db, "SELECT id FROM features WHERE id = ?", [dep]);
      if (!depExists) continue;
      const dupDep = queryOne(db,
        "SELECT id FROM feature_dependencies WHERE feature_id = ? AND depends_on_id = ?",
        [f.name, dep]
      );
      if (!dupDep) {
        db.run(
          "INSERT INTO feature_dependencies (feature_id, depends_on_id, type) VALUES (?, ?, 'blocks')",
          [f.name, dep]
        );
        depsAdded++;
      }
    }
  }

  saveDb();
  closeDb();

  const parts: string[] = [];
  if (added > 0)    parts.push(`${added} added`);
  if (updated > 0)  parts.push(`${updated} updated`);
  if (depsAdded > 0) parts.push(`${depsAdded} dependencies`);
  console.log(chalk.green(`  ✓ Plan imported: ${parts.join(", ")}\n`));
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function planCommand(
  description: string | undefined,
  options: { replan?: boolean; group?: string }
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  let prompt: string;

  // ── Mode 3: --replan ────────────────────────────────────────────────────
  if (options.replan) {
    console.log(chalk.bold("\n  groundctl plan --replan\n"));
    const db = await openDb();
    const done    = query<{ name: string }>(db, "SELECT name FROM features WHERE status = 'done'").map(r => r.name);
    const pending = query<{ name: string }>(db, "SELECT name FROM features WHERE status != 'done'").map(r => r.name);
    closeDb();

    if (done.length === 0) {
      console.log(chalk.yellow("  No features built yet — use groundctl plan <description> to start.\n"));
      return;
    }
    console.log(chalk.gray(`  Analyzing ${done.length} built features to suggest what's next...\n`));
    prompt = buildReplanPrompt(done, pending, pending.length);

  // ── Mode 1 + 2: description or interactive ──────────────────────────────
  } else {
    if (!description) {
      console.log(chalk.bold("\n  groundctl plan\n"));
      description = await readLine(chalk.bold("  Describe what you want to build: "));
      if (!description.trim()) {
        console.log(chalk.yellow("  No description provided.\n"));
        return;
      }
    } else {
      console.log(chalk.bold("\n  groundctl plan\n"));
    }
    console.log(chalk.gray("  Planning features..."));
    prompt = buildPlanPrompt(description);
  }

  // ── Call API ────────────────────────────────────────────────────────────
  let features: PlannedFeature[] = [];
  let source = "";

  process.stdout.write(chalk.gray("  Calling planning API..."));

  try {
    features = await callProxy(prompt);
    source   = "proxy";
  } catch {
    if (apiKey) {
      try {
        features = await callDirectApi(apiKey, prompt);
        source   = "api";
      } catch (err) {
        process.stdout.write("\r" + " ".repeat(40) + "\r");
        console.log(chalk.red(`  ✗ Planning failed: ${(err as Error).message}\n`));
        return;
      }
    } else {
      process.stdout.write("\r" + " ".repeat(40) + "\r");
      console.log(chalk.yellow(
        "  ⚠  detect.groundctl.org unreachable and no ANTHROPIC_API_KEY set.\n" +
        "  Set ANTHROPIC_API_KEY or try again when online.\n"
      ));
      return;
    }
  }

  process.stdout.write("\r" + " ".repeat(40) + "\r");

  if (features.length === 0) {
    console.log(chalk.yellow("  No features generated. Try a more specific description.\n"));
    return;
  }

  const sourceLabel =
    source === "proxy" ? chalk.green("(via detect.groundctl.org)") :
                         chalk.green("(via ANTHROPIC_API_KEY)");
  console.log(chalk.gray(`  Source: ${sourceLabel}`));
  renderPlan(features);

  // ── Interactive confirm loop ────────────────────────────────────────────
  let pending = features;
  while (true) {
    const answer = await readLine(chalk.bold("  Import this plan? ") + chalk.gray("[y/n/edit] "));
    const a = answer.toLowerCase();

    if (a === "y" || a === "yes") {
      await importPlan(pending, options.group);
      break;
    }
    if (a === "n" || a === "no") {
      console.log(chalk.gray("  Skipped.\n"));
      break;
    }
    if (a === "e" || a === "edit") {
      const edited = await editInEditor(pending);
      if (edited && edited.length > 0) { pending = edited; renderPlan(pending); }
      else console.log(chalk.yellow("  No valid features after edit.\n"));
      continue;
    }
    console.log(chalk.gray("  Please answer y, n, or edit."));
  }
}
