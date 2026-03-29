import chalk from "chalk";
import { openDb, closeDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

// ── Layout constants ────────────────────────────────────────────────────────

const BAR_W  = 14;   // per-feature bar width
const NAME_W = 22;   // name column max width (truncate + pad)
const PROG_W = 6;    // "11/11" column width

// ── Helpers ─────────────────────────────────────────────────────────────────

function progressBar(done: number, total: number, width: number): string {
  if (total <= 0) return chalk.gray("░".repeat(width));
  const filled = Math.min(width, Math.round((done / total) * width));
  return chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(width - filled));
}

function featureBar(
  status: string,
  progressDone: number | null,
  progressTotal: number | null
): string {
  if (progressTotal != null && progressTotal > 0) {
    return progressBar(progressDone ?? 0, progressTotal, BAR_W);
  }
  switch (status) {
    case "done":        return progressBar(1, 1, BAR_W);
    case "in_progress": return progressBar(1, 2, BAR_W);
    case "blocked":     return chalk.red("░".repeat(BAR_W));
    default:            return chalk.gray("░".repeat(BAR_W));  // pending
  }
}

function featureProgress(
  progressDone: number | null,
  progressTotal: number | null
): string {
  if (progressDone != null && progressTotal != null) {
    return `${progressDone}/${progressTotal}`;
  }
  return "";
}

/** Wrap items CSV into display lines of at most maxWidth chars, "·"-separated. */
function wrapItems(itemsCsv: string, maxWidth: number): string[] {
  const items = itemsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current ? `${current} · ${item}` : item;
    if (next.length > maxWidth && current.length > 0) {
      lines.push(current);
      current = item;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function timeSince(isoDate: string): string {
  const then = new Date(isoDate + "Z").getTime();
  const ms = Date.now() - then;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m > 0 ? String(m).padStart(2, "0") : ""}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface FeatureRow {
  id: string;
  name: string;
  status: string;
  priority: string;
  description: string | null;
  progress_done: number | null;
  progress_total: number | null;
  items: string | null;
  claimed_session: string | null;
  claimed_at: string | null;
}

// ── Command ──────────────────────────────────────────────────────────────────

export async function statusCommand(): Promise<void> {
  const db = await openDb();
  const projectName = process.cwd().split("/").pop() ?? "unknown";

  const features = query<FeatureRow>(
    db,
    `SELECT
       f.id, f.name, f.status, f.priority,
       f.description, f.progress_done, f.progress_total, f.items,
       c.session_id  AS claimed_session,
       c.claimed_at  AS claimed_at
     FROM features f
     LEFT JOIN claims c
       ON c.feature_id = f.id AND c.released_at IS NULL
     ORDER BY
       CASE f.status
         WHEN 'in_progress' THEN 0
         WHEN 'blocked'     THEN 1
         WHEN 'pending'     THEN 2
         WHEN 'done'        THEN 3
       END,
       CASE f.priority
         WHEN 'critical' THEN 0
         WHEN 'high'     THEN 1
         WHEN 'medium'   THEN 2
         WHEN 'low'      THEN 3
       END,
       f.created_at`
  );

  const sessionCount = queryOne<{ count: number }>(
    db,
    "SELECT COUNT(*) as count FROM sessions"
  )?.count ?? 0;

  closeDb();

  console.log("");

  if (features.length === 0) {
    console.log(chalk.bold(`  ${projectName} — no features tracked yet\n`));
    console.log(chalk.gray("  Add features with: groundctl add feature -n 'my-feature'"));
    console.log(chalk.gray("  Then run: groundctl status\n"));
    return;
  }

  const total   = features.length;
  const done    = features.filter((f) => f.status === "done").length;
  const inProg  = features.filter((f) => f.status === "in_progress").length;
  const blocked = features.filter((f) => f.status === "blocked").length;
  const pct     = Math.round((done / total) * 100);

  // ── Header ───────────────────────────────────────────────────────────────
  console.log(
    chalk.bold(`  ${projectName} — ${pct}% implemented`) +
    chalk.gray(` (${sessionCount} session${sessionCount !== 1 ? "s" : ""})`)
  );
  console.log("");

  // Aggregate bar
  const aggBar = progressBar(done, total, 20);
  let aggSuffix = chalk.white(`  ${done}/${total} done`);
  if (inProg  > 0) aggSuffix += chalk.yellow(`  ${inProg} in progress`);
  if (blocked > 0) aggSuffix += chalk.red(`  ${blocked} blocked`);
  console.log(`  Features  ${aggBar}${aggSuffix}`);
  console.log("");

  // ── Per-feature table ─────────────────────────────────────────────────────

  // Dynamic name column: at most NAME_W, at least longest name (min 12)
  const maxNameLen = Math.min(NAME_W, Math.max(...features.map((f) => f.name.length)));
  const nameW      = Math.max(maxNameLen, 12);

  // Continuation indent: "  ● " (4 chars) + name col + " " (1 char)
  const contIndent = " ".repeat(4 + nameW + 1);
  const itemsMaxW  = Math.max(40, 76 - contIndent.length);

  for (const f of features) {
    const isDone    = f.status === "done";
    const isActive  = f.status === "in_progress";
    const isBlocked = f.status === "blocked";

    // Icon + colour
    const icon =
      isDone    ? "✓" :
      isActive  ? "●" :
      isBlocked ? "✗" : "○";
    const iconChalk =
      isDone    ? chalk.green  :
      isActive  ? chalk.yellow :
      isBlocked ? chalk.red    : chalk.gray;

    // Name
    const nameRaw   = f.name.slice(0, nameW).padEnd(nameW);
    const nameChalk =
      isDone    ? chalk.dim   :
      isActive  ? chalk.white :
      isBlocked ? chalk.red   : chalk.gray;

    // Bar + progress fraction
    const pd   = f.progress_done  ?? null;
    const pt   = f.progress_total ?? null;
    const bar  = featureBar(f.status, pd, pt);
    const prog = featureProgress(pd, pt).padEnd(PROG_W);

    // Description (truncate)
    const descRaw   = f.description ?? "";
    const descTrunc = descRaw.length > 38 ? descRaw.slice(0, 36) + "…" : descRaw;
    const descStr   = descTrunc ? chalk.gray(`  ${descTrunc}`) : "";

    // Claimed annotation for in-progress features
    let claimedStr = "";
    if (isActive && f.claimed_session) {
      const elapsed = f.claimed_at ? timeSince(f.claimed_at) : "";
      claimedStr = chalk.yellow(` → ${f.claimed_session}${elapsed ? ` (${elapsed})` : ""}`);
    }

    console.log(
      `  ${iconChalk(icon)} ${nameChalk(nameRaw)} ${bar}  ${prog}${descStr}${claimedStr}`
    );

    // Items continuation lines
    if (f.items) {
      const lines = wrapItems(f.items, itemsMaxW);
      for (const line of lines) {
        console.log(chalk.dim(`${contIndent}${line}`));
      }
    }
  }

  console.log("");
}
