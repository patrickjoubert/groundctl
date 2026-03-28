import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { openDb, closeDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

interface ReportOptions {
  session?: string;
  all?: boolean;
}

interface SessionRow {
  id: string;
  agent: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

interface FileRow {
  path: string;
  operation: string;
  lines_changed: number;
}

interface DecisionRow {
  description: string;
  rationale: string | null;
}

interface FeatureRow {
  name: string;
  status: string;
}

interface ClaimRow {
  feature_name: string;
  session_id: string;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "ongoing";
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return "unknown";
  const ms = endMs - startMs;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h${m}min` : `${h}h`;
}

function buildSessionReport(
  sessionRow: SessionRow,
  files: FileRow[],
  decisions: DecisionRow[],
  completedFeatures: FeatureRow[],
  nextAvailable: FeatureRow[],
  activeClaims: ClaimRow[]
): string {
  const date = sessionRow.started_at.slice(0, 10);
  const duration = formatDuration(sessionRow.started_at, sessionRow.ended_at);

  let md = `# Session ${sessionRow.id} — ${date}\n`;
  md += `Date: ${date} | Duration: ${duration} | Agent: ${sessionRow.agent}\n\n`;

  if (sessionRow.summary) {
    md += `## Summary\n${sessionRow.summary}\n\n`;
  }

  // What was built / completed
  if (completedFeatures.length > 0) {
    md += "## What was built\n";
    for (const f of completedFeatures) {
      md += `- ${f.name}\n`;
    }
    md += "\n";
  }

  // Files touched
  if (files.length > 0) {
    const created = files.filter((f) => f.operation === "created");
    const modified = files.filter((f) => f.operation === "modified");
    const deleted = files.filter((f) => f.operation === "deleted");

    md += `## Files touched (${files.length})\n`;
    for (const f of created) {
      md += `- ${f.path} (created, ${f.lines_changed} lines)\n`;
    }
    for (const f of modified) {
      md += `- ${f.path} (modified, ${f.lines_changed} lines)\n`;
    }
    for (const f of deleted) {
      md += `- ${f.path} (deleted)\n`;
    }
    md += "\n";
  }

  // Decisions
  if (decisions.length > 0) {
    md += "## Decisions\n";
    for (const d of decisions) {
      md += `- ${d.description}`;
      if (d.rationale) md += ` — ${d.rationale}`;
      md += "\n";
    }
    md += "\n";
  }

  // Active claims (in progress)
  if (activeClaims.length > 0) {
    md += "## In progress\n";
    for (const c of activeClaims) {
      md += `- ${c.feature_name} (session ${c.session_id})\n`;
    }
    md += "\n";
  }

  // Next available
  if (nextAvailable.length > 0) {
    md += "## Next available\n";
    for (const f of nextAvailable.slice(0, 5)) {
      md += `- feature/${f.name.toLowerCase().replace(/\s+/g, "-")}\n`;
    }
    md += "\n";
  }

  return md;
}

export async function reportCommand(options: ReportOptions): Promise<void> {
  const db = await openDb();
  const cwd = process.cwd();

  let sessions: SessionRow[];

  if (options.all) {
    sessions = query<SessionRow>(db, "SELECT * FROM sessions ORDER BY started_at");
  } else if (options.session) {
    const s = queryOne<SessionRow>(
      db,
      "SELECT * FROM sessions WHERE id = ? OR id LIKE ?",
      [options.session, `%${options.session}%`]
    );
    if (!s) {
      console.log(chalk.red(`\n  Session "${options.session}" not found.\n`));
      closeDb();
      return;
    }
    sessions = [s];
  } else {
    // Current / most recent session
    const s = queryOne<SessionRow>(
      db,
      "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1"
    );
    if (!s) {
      console.log(chalk.yellow("\n  No sessions found. Run groundctl init first.\n"));
      closeDb();
      return;
    }
    sessions = [s];
  }

  const nextAvailable = query<FeatureRow>(
    db,
    `SELECT name, status FROM features
     WHERE status = 'pending'
     AND id NOT IN (SELECT feature_id FROM claims WHERE released_at IS NULL)
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
       WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END
     LIMIT 5`
  );

  const activeClaims = query<ClaimRow>(
    db,
    `SELECT f.name as feature_name, c.session_id
     FROM claims c JOIN features f ON c.feature_id = f.id
     WHERE c.released_at IS NULL`
  );

  closeDb();

  if (options.all) {
    // Multi-session report
    const allDb = await openDb();
    let fullReport = `# Session History\n\n`;
    for (const s of sessions) {
      const files = query<FileRow>(allDb, "SELECT * FROM files_modified WHERE session_id = ?", [s.id]);
      const decisions = query<DecisionRow>(allDb, "SELECT description, rationale FROM decisions WHERE session_id = ?", [s.id]);
      const completedFeatures = query<FeatureRow>(
        allDb,
        `SELECT f.name, f.status FROM features f
         JOIN claims c ON c.feature_id = f.id
         WHERE c.session_id = ? AND f.status = 'done'`,
        [s.id]
      );
      fullReport += buildSessionReport(s, files, decisions, completedFeatures, nextAvailable, []);
      fullReport += "---\n\n";
    }
    closeDb();
    const outPath = join(cwd, "SESSION_HISTORY.md");
    writeFileSync(outPath, fullReport);
    console.log(chalk.green(`\n  ✓ SESSION_HISTORY.md written (${sessions.length} sessions)\n`));
    return;
  }

  const db2 = await openDb();
  const session = sessions[0];
  const files = query<FileRow>(db2, "SELECT * FROM files_modified WHERE session_id = ?", [session.id]);
  const decisions = query<DecisionRow>(db2, "SELECT description, rationale FROM decisions WHERE session_id = ?", [session.id]);
  const completedFeatures = query<FeatureRow>(
    db2,
    `SELECT f.name, f.status FROM features f
     JOIN claims c ON c.feature_id = f.id
     WHERE c.session_id = ? AND f.status = 'done'`,
    [session.id]
  );
  closeDb();

  const report = buildSessionReport(
    session,
    files,
    decisions,
    completedFeatures,
    nextAvailable,
    activeClaims
  );

  const outPath = join(cwd, "SESSION_REPORT.md");
  writeFileSync(outPath, report);

  console.log(chalk.green(`\n  ✓ SESSION_REPORT.md written (session ${session.id})\n`));
  console.log(chalk.gray(`  ${files.length} files · ${decisions.length} decisions · ${completedFeatures.length} features completed`));
  console.log("");
}
