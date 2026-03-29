import chalk from "chalk";
import { openDb, closeDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

interface DepRow {
  feature_id: string;
  dep_id: string;
  dep_name: string;
  dep_status: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const AGG_BAR_W  = 20;
const GRP_BAR_W  = 20;
const FEAT_BAR_W = 14;
const NAME_W     = 26;
const PROG_W     = 6;

// ── Bar helpers ──────────────────────────────────────────────────────────────

function progressBar(done: number, total: number, width: number): string {
  if (total <= 0) return chalk.gray("░".repeat(width));
  const filled = Math.min(width, Math.round((done / total) * width));
  return chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(width - filled));
}

function featureBar(status: string, pd: number | null, pt: number | null, width = FEAT_BAR_W): string {
  if (pt != null && pt > 0) return progressBar(pd ?? 0, pt, width);
  switch (status) {
    case "done":        return progressBar(1, 1, width);
    case "in_progress": return progressBar(1, 2, width);
    case "blocked":     return chalk.red("░".repeat(width));
    default:            return chalk.gray("░".repeat(width));
  }
}

function wrapItems(csv: string, maxWidth: number): string[] {
  const items = csv.split(",").map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const item of items) {
    const next = cur ? `${cur} · ${item}` : item;
    if (next.length > maxWidth && cur.length > 0) { lines.push(cur); cur = item; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso + "Z").getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60) > 0 ? String(m % 60).padStart(2, "0") : ""}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface FeatureRow {
  id: string; name: string; status: string; priority: string;
  description: string | null; progress_done: number | null;
  progress_total: number | null; items: string | null;
  group_id: number | null; group_name: string | null;
  group_label: string | null; group_order: number | null;
  claimed_session: string | null; claimed_at: string | null;
}

interface GroupRow { id: number; name: string; label: string; order_index: number; }

// ── Dependency helpers ────────────────────────────────────────────────────────

function buildDepsMap(deps: DepRow[]): Map<string, DepRow[]> {
  const map = new Map<string, DepRow[]>();
  for (const d of deps) {
    if (!map.has(d.feature_id)) map.set(d.feature_id, []);
    map.get(d.feature_id)!.push(d);
  }
  return map;
}

function unmetDeps(featureId: string, depsMap: Map<string, DepRow[]>): string[] {
  return (depsMap.get(featureId) ?? [])
    .filter((d) => d.dep_status !== "done")
    .map((d) => d.dep_name);
}

// ── Group summary view (default) ─────────────────────────────────────────────

function renderGroupSummary(
  features: FeatureRow[],
  groups: GroupRow[],
  sessionCount: number,
  projectName: string
): void {
  const total = features.length;
  const done  = features.filter((f) => f.status === "done").length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

  console.log("");
  console.log(
    chalk.bold(`  ${projectName} — ${pct}% implemented`) +
    chalk.gray(` (${sessionCount} session${sessionCount !== 1 ? "s" : ""})`)
  );
  console.log("");

  // Group label column width
  const maxLabelW = Math.max(...groups.map((g) => g.label.length), 14);

  for (const grp of groups) {
    const gFeatures = features.filter((f) => f.group_id === grp.id);
    if (gFeatures.length === 0) continue;

    const gDone   = gFeatures.filter((f) => f.status === "done").length;
    const gActive = gFeatures.filter((f) => f.status === "in_progress").length;
    const bar     = progressBar(gDone, gFeatures.length, GRP_BAR_W);
    const frac    = chalk.white(`  ${gDone}/${gFeatures.length} done`);
    const inProg  = gActive > 0 ? chalk.yellow(`  ${gActive} active`) : "";
    const label   = grp.label.padEnd(maxLabelW);

    console.log(`  ${chalk.bold(label)}  ${bar}${frac}${inProg}`);
  }

  // Ungrouped features
  const ungrouped = features.filter((f) => f.group_id == null);
  if (ungrouped.length > 0) {
    const uDone = ungrouped.filter((f) => f.status === "done").length;
    const bar   = progressBar(uDone, ungrouped.length, GRP_BAR_W);
    const label = "Other".padEnd(maxLabelW);
    console.log(`  ${chalk.gray(label)}  ${bar}  ${chalk.gray(`${uDone}/${ungrouped.length} done`)}`);
  }

  console.log("");

  // Active claims
  const claimed = features.filter((f) => f.status === "in_progress" && f.claimed_session);
  if (claimed.length > 0) {
    console.log(chalk.bold("  Claimed:"));
    for (const f of claimed) {
      const grpLabel = f.group_label ? chalk.gray(` (${f.group_label})`) : "";
      const elapsed  = f.claimed_at ? timeSince(f.claimed_at) : "";
      console.log(chalk.yellow(`    ● ${f.name}${grpLabel} → ${f.claimed_session}${elapsed ? ` (${elapsed})` : ""}`));
    }
    console.log("");
  }

  // Next available
  const next = features.find((f) => f.status === "pending" && !f.claimed_session);
  if (next) {
    const grpLabel = next.group_label ? chalk.gray(` (${next.group_label})`) : "";
    console.log(chalk.bold("  Next:    ") + chalk.white(`${next.name}${grpLabel}`));
    console.log("");
  }
}

// ── Detail / all view ────────────────────────────────────────────────────────

function renderDetail(
  features: FeatureRow[],
  groups: GroupRow[],
  sessionCount: number,
  projectName: string,
  depsMap: Map<string, DepRow[]>
): void {
  const total = features.length;
  const done  = features.filter((f) => f.status === "done").length;
  const pct   = Math.round((done / total) * 100);

  console.log("");
  console.log(
    chalk.bold(`  ${projectName} — ${pct}% implemented`) +
    chalk.gray(` (${sessionCount} session${sessionCount !== 1 ? "s" : ""})`)
  );
  console.log("");
  console.log(`  Features  ${progressBar(done, total, AGG_BAR_W)}  ${done}/${total} done`);
  console.log("");

  const nameW      = Math.min(NAME_W, Math.max(12, ...features.map((f) => f.name.length)));
  const contIndent = " ".repeat(4 + nameW + 1);
  const itemsMaxW  = Math.max(40, 76 - contIndent.length);

  const renderFeature = (f: FeatureRow, indent = "  ") => {
    const isDone    = f.status === "done";
    const isActive  = f.status === "in_progress";
    const isBlocked = f.status === "blocked";

    const icon      = isDone ? "✓" : isActive ? "●" : isBlocked ? "✗" : "○";
    const iconCh    = isDone ? chalk.green : isActive ? chalk.yellow : isBlocked ? chalk.red : chalk.gray;
    const nameCh    = isDone ? chalk.dim   : isActive ? chalk.white  : isBlocked ? chalk.red  : chalk.gray;
    const nameRaw   = f.name.slice(0, nameW).padEnd(nameW);
    const bar       = featureBar(f.status, f.progress_done ?? null, f.progress_total ?? null);
    const prog      = (f.progress_done != null ? `${f.progress_done}/${f.progress_total}` : "").padEnd(PROG_W);
    const descRaw   = f.description ?? "";
    const descStr   = descRaw ? chalk.gray(`  ${descRaw.length > 38 ? descRaw.slice(0, 36) + "…" : descRaw}`) : "";
    let   claimed   = "";
    if (isActive && f.claimed_session) {
      const el = f.claimed_at ? timeSince(f.claimed_at) : "";
      claimed = chalk.yellow(` → ${f.claimed_session}${el ? ` (${el})` : ""}`);
    }

    // Dependency annotation: show unmet blocking deps
    const waiting = unmetDeps(f.id, depsMap);
    const needsStr = waiting.length > 0 && !isDone
      ? chalk.red(`  (needs: ${waiting.slice(0, 3).join(", ")})`)
      : "";

    process.stdout.write(`${indent}${iconCh(icon)} ${nameCh(nameRaw)} ${bar}  ${prog}${descStr}${claimed}${needsStr}\n`);

    if (f.items) {
      for (const line of wrapItems(f.items, itemsMaxW)) {
        console.log(chalk.dim(`${indent}  ${" ".repeat(nameW + 2)}${line}`));
      }
    }
  };

  // Render grouped
  for (const grp of groups) {
    const gFeatures = features.filter((f) => f.group_id === grp.id);
    if (gFeatures.length === 0) continue;

    const gDone  = gFeatures.filter((f) => f.status === "done").length;
    const gActive = gFeatures.filter((f) => f.status === "in_progress").length;
    const bar    = progressBar(gDone, gFeatures.length, GRP_BAR_W);
    const inProg = gActive > 0 ? chalk.yellow(`  ${gActive} active`) : "";

    console.log(
      chalk.bold.white(`  ${grp.label.toUpperCase().padEnd(NAME_W + 1)} `) +
      `${bar}  ${gDone}/${gFeatures.length} done${inProg}`
    );
    for (const f of gFeatures) renderFeature(f, "    ");
    console.log("");
  }

  // Ungrouped features — only show "OTHER" label when there are real groups too
  const ungrouped = features.filter((f) => f.group_id == null);
  if (ungrouped.length > 0) {
    if (groups.length > 0) {
      console.log(chalk.bold.gray("  OTHER"));
      for (const f of ungrouped) renderFeature(f, "    ");
      console.log("");
    } else {
      // No groups at all — render flat without header
      for (const f of ungrouped) renderFeature(f, "  ");
      console.log("");
    }
  }
}

// ── Flat view (no groups) ────────────────────────────────────────────────────

function renderFlat(
  features: FeatureRow[],
  sessionCount: number,
  projectName: string,
  depsMap: Map<string, DepRow[]>
): void {
  const total   = features.length;
  const done    = features.filter((f) => f.status === "done").length;
  const inProg  = features.filter((f) => f.status === "in_progress").length;
  const blocked = features.filter((f) => f.status === "blocked").length;
  const pct     = Math.round((done / total) * 100);

  console.log("");
  console.log(
    chalk.bold(`  ${projectName} — ${pct}% implemented`) +
    chalk.gray(` (${sessionCount} session${sessionCount !== 1 ? "s" : ""})`)
  );
  console.log("");

  let aggSuffix = chalk.white(`  ${done}/${total} done`);
  if (inProg  > 0) aggSuffix += chalk.yellow(`  ${inProg} in progress`);
  if (blocked > 0) aggSuffix += chalk.red(`  ${blocked} blocked`);
  console.log(`  Features  ${progressBar(done, total, AGG_BAR_W)}${aggSuffix}`);
  console.log("");

  const nameW      = Math.min(NAME_W, Math.max(12, ...features.map((f) => f.name.length)));
  const contIndent = " ".repeat(4 + nameW + 1);
  const itemsMaxW  = Math.max(40, 76 - contIndent.length);

  for (const f of features) {
    const isDone    = f.status === "done";
    const isActive  = f.status === "in_progress";
    const isBlocked = f.status === "blocked";

    const icon    = isDone ? "✓" : isActive ? "●" : isBlocked ? "✗" : "○";
    const iconCh  = isDone ? chalk.green : isActive ? chalk.yellow : isBlocked ? chalk.red : chalk.gray;
    const nameCh  = isDone ? chalk.dim   : isActive ? chalk.white  : isBlocked ? chalk.red  : chalk.gray;
    const nameRaw = f.name.slice(0, nameW).padEnd(nameW);
    const bar     = featureBar(f.status, f.progress_done ?? null, f.progress_total ?? null);
    const prog    = (f.progress_done != null ? `${f.progress_done}/${f.progress_total}` : "").padEnd(PROG_W);
    const desc    = (f.description ?? "").slice(0, 38);
    const descStr = desc ? chalk.gray(`  ${desc.length < (f.description?.length ?? 0) ? desc + "…" : desc}`) : "";
    let   claimed = "";
    if (isActive && f.claimed_session) {
      const el = f.claimed_at ? timeSince(f.claimed_at) : "";
      claimed = chalk.yellow(` → ${f.claimed_session}${el ? ` (${el})` : ""}`);
    }

    const waiting = unmetDeps(f.id, depsMap);
    const needsStr = waiting.length > 0 && !isDone
      ? chalk.red(`  (needs: ${waiting.slice(0, 3).join(", ")})`)
      : "";

    console.log(`  ${iconCh(icon)} ${nameCh(nameRaw)} ${bar}  ${prog}${descStr}${claimed}${needsStr}`);

    if (f.items) {
      for (const line of wrapItems(f.items, itemsMaxW)) {
        console.log(chalk.dim(`${contIndent}${line}`));
      }
    }
  }
  console.log("");
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function statusCommand(opts?: { detail?: boolean; all?: boolean }): Promise<void> {
  const db          = await openDb();
  const projectName = process.cwd().split("/").pop() ?? "unknown";

  const features = query<FeatureRow>(
    db,
    `SELECT
       f.id, f.name, f.status, f.priority,
       f.description, f.progress_done, f.progress_total, f.items,
       f.group_id,
       g.name  AS group_name,
       g.label AS group_label,
       g.order_index AS group_order,
       c.session_id AS claimed_session,
       c.claimed_at AS claimed_at
     FROM features f
     LEFT JOIN feature_groups g ON f.group_id = g.id
     LEFT JOIN claims c ON c.feature_id = f.id AND c.released_at IS NULL
     ORDER BY
       COALESCE(g.order_index, 9999),
       CASE f.status
         WHEN 'in_progress' THEN 0
         WHEN 'blocked'     THEN 1
         WHEN 'pending'     THEN 2
         WHEN 'done'        THEN 3
       END,
       CASE f.priority
         WHEN 'critical' THEN 0 WHEN 'high' THEN 1
         WHEN 'medium'   THEN 2 WHEN 'low'  THEN 3
       END,
       f.created_at`
  );

  const groups = query<GroupRow>(
    db,
    "SELECT id, name, label, order_index FROM feature_groups ORDER BY order_index"
  );

  const sessionCount = queryOne<{ count: number }>(
    db, "SELECT COUNT(*) as count FROM sessions"
  )?.count ?? 0;

  // Load dependencies for visual annotation
  const rawDeps = query<DepRow>(
    db,
    `SELECT d.feature_id, d.depends_on_id as dep_id, f.name as dep_name, f.status as dep_status
     FROM feature_dependencies d
     JOIN features f ON f.id = d.depends_on_id
     WHERE d.type = 'blocks'`
  );
  const depsMap = buildDepsMap(rawDeps);

  closeDb();

  if (features.length === 0) {
    console.log("");
    console.log(chalk.bold(`  ${projectName} — no features tracked yet\n`));
    console.log(chalk.gray("  Add features: groundctl add feature -n 'my-feature'"));
    console.log(chalk.gray("  Add groups:   groundctl add group -n 'core' --label 'Core'\n"));
    return;
  }

  const hasGroups = groups.length > 0 && features.some((f) => f.group_id != null);

  if (opts?.detail || opts?.all) {
    renderDetail(features, groups, sessionCount, projectName, depsMap);
  } else if (hasGroups) {
    renderGroupSummary(features, groups, sessionCount, projectName);
  } else {
    renderFlat(features, sessionCount, projectName, depsMap);
  }
}
