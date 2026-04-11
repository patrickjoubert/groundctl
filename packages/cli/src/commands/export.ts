/**
 * export.ts
 *
 * groundctl export --conductor      → .conductor/tasks.md
 * groundctl export --agent-teams    → .claude/tasks/groundctl-export.json
 * groundctl export --json           → groundctl-export.json (generic)
 *
 * Bridge between groundctl's product plan and agent orchestrators.
 * Tagline: "Conductor runs your agents. groundctl tells them what to build."
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "../colors.js";
import { openDb, closeDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

interface FeatureRow {
  id: string;
  name: string;
  priority: string;
  description: string | null;
  parallel_safe: number;
}

interface DepRow {
  feature_id: string;
  depends_on_name: string;
}

interface FileRow {
  path: string;
}

interface EnrichedFeature extends FeatureRow {
  blockingDeps: string[];    // dep names that are not yet done
  allDeps: string[];         // all blocking dep names
  isReady: boolean;          // true if no blocking unresolved deps
}

// ── Context injected into every task ─────────────────────────────────────────

const CONTEXT_LINES = [
  "Read PROJECT_STATE.md before starting.",
  "Read AGENTS.md for workflow instructions.",
];

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadFeatures(projectPath: string): Promise<{
  ready: EnrichedFeature[];
  blocked: EnrichedFeature[];
  projectName: string;
}> {
  const db = await openDb();

  // Project name from last path segment
  const projectName = projectPath.split("/").pop() ?? "project";

  // Open (non-done) features
  const features = query<FeatureRow>(
    db,
    `SELECT id, name, priority, description, parallel_safe
     FROM features
     WHERE status != 'done'
     ORDER BY
       CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       name`
  );

  // All blocking deps for open features (dep not done)
  const blockingDeps = query<DepRow>(
    db,
    `SELECT d.feature_id, dep.name as depends_on_name
     FROM feature_dependencies d
     JOIN features dep ON dep.id = d.depends_on_id
     WHERE d.type = 'blocks'
       AND dep.status != 'done'`
  );

  // All declared blocking deps (regardless of dep status — for display)
  const allDeps = query<DepRow>(
    db,
    `SELECT d.feature_id, dep.name as depends_on_name
     FROM feature_dependencies d
     JOIN features dep ON dep.id = d.depends_on_id
     WHERE d.type = 'blocks'`
  );

  closeDb();

  // Build lookup maps
  const blockingMap = new Map<string, string[]>();
  for (const d of blockingDeps) {
    const list = blockingMap.get(d.feature_id) ?? [];
    list.push(d.depends_on_name);
    blockingMap.set(d.feature_id, list);
  }

  const allDepMap = new Map<string, string[]>();
  for (const d of allDeps) {
    const list = allDepMap.get(d.feature_id) ?? [];
    list.push(d.depends_on_name);
    allDepMap.set(d.feature_id, list);
  }

  const enriched: EnrichedFeature[] = features.map((f) => ({
    ...f,
    blockingDeps: blockingMap.get(f.id) ?? [],
    allDeps: allDepMap.get(f.id) ?? [],
    isReady: (blockingMap.get(f.id) ?? []).length === 0,
  }));

  return {
    ready:   enriched.filter((f) => f.isReady),
    blocked: enriched.filter((f) => !f.isReady),
    projectName,
  };
}

/** Fetch recently touched file paths from the DB for a feature (best-effort). */
async function topFilesForFeature(featureName: string, projectPath: string): Promise<string[]> {
  // We don't have a direct feature→files mapping yet, so return empty here.
  // Placeholder for future enrichment.
  void featureName; void projectPath;
  return [];
}

// ── Conductor format ──────────────────────────────────────────────────────────

function conductorTask(
  n: number,
  f: EnrichedFeature,
  files: string[]
): string {
  const depLine = f.allDeps.length > 0
    ? `Dependencies: ${f.allDeps.join(" + ")}`
    : "Dependencies: none — launch now";
  const statusLine = f.isReady
    ? ""
    : `Status: blocked — do not start yet\n`;

  const fileLines = files.length > 0
    ? `\nFiles likely involved:\n${files.map((p) => `- ${p}`).join("\n")}\n`
    : "";

  const desc = f.description ?? f.name;
  const contextLines = CONTEXT_LINES.map((l) => l).join("\n");

  return [
    `### Task ${n}: ${f.name}`,
    `Priority: ${f.priority}`,
    depLine,
    statusLine,
    desc,
    contextLines,
    fileLines,
  ]
    .filter((l) => l !== undefined)
    .join("\n")
    .trimEnd();
}

async function exportConductor(
  projectPath: string,
  { ready, blocked, projectName }: Awaited<ReturnType<typeof loadFeatures>>
): Promise<string> {
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `# groundctl export — ${projectName}`,
    `# Generated: ${now}`,
    `# Import this into Conductor as your task list`,
    "",
  ];

  if (ready.length > 0) {
    lines.push("## READY TO LAUNCH (parallel safe)", "");
    let n = 1;
    for (const f of ready) {
      const files = await topFilesForFeature(f.name, projectPath);
      lines.push(conductorTask(n++, f, files), "");
    }
  }

  if (blocked.length > 0) {
    lines.push("## BLOCKED (waiting for dependencies)", "");
    let n = (ready.length + 1);
    for (const f of blocked) {
      const files = await topFilesForFeature(f.name, projectPath);
      lines.push(conductorTask(n++, f, files), "");
    }
  }

  if (ready.length === 0 && blocked.length === 0) {
    lines.push("## No open features", "", "All features are done. Run `groundctl next --suggest` to plan what to build next.", "");
  }

  return lines.join("\n");
}

// ── Agent Teams format ────────────────────────────────────────────────────────

function agentTeamsPayload(
  projectName: string,
  ready: EnrichedFeature[],
  blocked: EnrichedFeature[]
): object {
  const toTask = (f: EnrichedFeature) => ({
    id: f.name,
    title: f.description
      ? (f.description.split(".")[0] ?? f.description).slice(0, 100).trim()
      : f.name.replace(/-/g, " "),
    description: f.description ?? f.name,
    priority: f.priority,
    parallel_safe: f.parallel_safe === 1,
    blockedBy: f.allDeps,
    status: f.isReady ? "ready" : "blocked",
    context: CONTEXT_LINES.join(" "),
  });

  return {
    version: "1.0",
    source: "groundctl",
    project: projectName,
    exported_at: new Date().toISOString(),
    tasks: [...ready.map(toTask), ...blocked.map(toTask)],
  };
}

// ── Generic JSON format ───────────────────────────────────────────────────────

function genericJsonPayload(
  projectName: string,
  ready: EnrichedFeature[],
  blocked: EnrichedFeature[]
): object {
  // Same structure as agent-teams — generic enough for any consumer
  return agentTeamsPayload(projectName, ready, blocked);
}

// ── File writers ──────────────────────────────────────────────────────────────

function writeFile(filePath: string, content: string): void {
  const dir = filePath.split("/").slice(0, -1).join("/");
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

// ── Main export command ───────────────────────────────────────────────────────

export async function exportCommand(options: {
  conductor?: boolean;
  agentTeams?: boolean;
  json?: boolean;
}): Promise<void> {
  const projectPath = process.cwd();

  if (!options.conductor && !options.agentTeams && !options.json) {
    // Default: show guidance for all integrations
    options.conductor = true;
    options.agentTeams = true;
  }

  const data = await loadFeatures(projectPath);
  const { ready, blocked, projectName } = data;
  const total = ready.length + blocked.length;

  if (total === 0 && !data) {
    console.log(chalk.yellow("\n  No open features to export.\n"));
    console.log(chalk.gray("  Run: groundctl add feature -n \"my-feature\" -p high\n"));
    return;
  }

  console.log(chalk.bold("\n  groundctl export\n"));

  // ── Conductor ───────────────────────────────────────────────────────────────
  if (options.conductor) {
    const conductorDir = join(projectPath, ".conductor");
    const outPath = join(conductorDir, "tasks.md");

    const md = await exportConductor(projectPath, data);
    writeFile(outPath, md);

    const readyCount   = ready.length;
    const blockedCount = blocked.length;
    const taskSummary  = [
      readyCount   > 0 ? `${readyCount} task${readyCount !== 1 ? "s" : ""} ready` : "",
      blockedCount > 0 ? `${blockedCount} blocked` : "",
    ].filter(Boolean).join(", ") || "no tasks";

    console.log(chalk.green("  ✓ .conductor/tasks.md generated") + chalk.gray(` (${taskSummary})`));
    console.log();
    console.log(chalk.gray("  Import into Conductor:"));
    console.log(chalk.gray("  Open Conductor → New workspace → paste task descriptions."));
    console.log();
    console.log(chalk.gray("  Note: this is a formatted task list, not a native"));
    console.log(chalk.gray("  Conductor import format."));
    console.log();
  }

  // ── Claude Code Agent Teams ─────────────────────────────────────────────────
  if (options.agentTeams) {
    console.log(chalk.green("  ✓ Agent Teams reads PROJECT_STATE.md + AGENTS.md automatically."));
    console.log();
    console.log(chalk.gray("  Every teammate loads them on startup — no export needed."));
    console.log();
    console.log(chalk.gray("  To start:"));
    console.log(chalk.gray("  1. Add to .claude/settings.json:"));
    console.log(chalk.white('     {"env": {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"}}'));
    console.log();
    console.log(chalk.gray("  2. Tell Claude Code:"));
    console.log(chalk.white("     'Create an agent team. Each teammate should read AGENTS.md"));
    console.log(chalk.white("      first, then claim a feature using groundctl claim <feature>'"));
    console.log();
    console.log(chalk.gray("  groundctl watch auto-ingests every teammate session."));
    console.log();
  }

  // ── Generic JSON ─────────────────────────────────────────────────────────────
  if (options.json) {
    const outPath = join(projectPath, "groundctl-export.json");
    const payload = genericJsonPayload(projectName, ready, blocked);
    writeFile(outPath, JSON.stringify(payload, null, 2) + "\n");

    console.log(chalk.green("  ✓ Generic JSON export ready"));
    console.log(chalk.gray(`  → groundctl-export.json`));
    console.log();
  }

  // ── Tagline ──────────────────────────────────────────────────────────────────
  console.log(chalk.gray("  ─────────────────────────────────────────────"));
  console.log(chalk.gray("  Conductor runs your agents."));
  console.log(chalk.bold("  groundctl tells them what to build."));
  console.log(chalk.gray("  ─────────────────────────────────────────────\n"));
}
