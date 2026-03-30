import chalk from "../colors.js";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";
import type { Database } from "sql.js";

const SUGGEST_URL = "https://detect.groundctl.org/suggest";
const LOW_BACKLOG_THRESHOLD = 3;

interface SuggestedFeature {
  name: string;
  description: string;
  priority: string;
  parallel_safe: boolean;
  depends_on: string[];
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function tryGitLog(cwd: string): string {
  try {
    return execSync("git log --oneline -30", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function printGroup(label: string, features: SuggestedFeature[]): void {
  console.log(chalk.bold(`  ${label}`));
  const parallel = features.filter(f => f.parallel_safe);
  const sequential = features.filter(f => !f.parallel_safe);

  if (parallel.length > 0) {
    for (const f of parallel) {
      const pColor = f.priority === "critical" || f.priority === "high" ? chalk.red : chalk.gray;
      console.log(`  ${chalk.green("○")} ${chalk.white(f.name)} ${pColor(`(${f.priority})`)} — ${f.description}`);
      console.log(chalk.gray("    No dependencies — launch now"));
    }
  }

  if (sequential.length > 0) {
    for (const f of sequential) {
      const pColor = f.priority === "critical" || f.priority === "high" ? chalk.red : chalk.gray;
      console.log(`  ${chalk.yellow("○")} ${chalk.white(f.name)} ${pColor(`(${f.priority})`)} — ${f.description}`);
      if (f.depends_on.length > 0) {
        console.log(chalk.gray(`    Needs: ${f.depends_on.join(" + ")}`));
      }
    }
  }
  console.log();
}

function printHint(): void {
  console.log(chalk.gray("  Or add your own:"));
  console.log(chalk.gray(`  groundctl add feature -n "my-feature" -p high`));
  console.log(chalk.gray(`  groundctl plan "describe what you want to build"\n`));
}

function claimInDb(db: Database, name: string): boolean {
  const feat = queryOne<{ id: string; status: string }>(
    db, "SELECT id, status FROM features WHERE name = ?", [name]
  );
  if (!feat || feat.status === "done") return false;

  const already = queryOne<{ c: number }>(
    db, "SELECT COUNT(*) as c FROM claims WHERE feature_id = ? AND released_at IS NULL", [feat.id]
  );
  if ((already?.c ?? 0) > 0) return true;

  const sess = queryOne<{ id: string }>(db, "SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1");
  const sessionId = sess?.id ?? "cli";

  db.run(
    "INSERT INTO claims (feature_id, session_id, claimed_at) VALUES (?, ?, datetime('now'))",
    [feat.id, sessionId]
  );
  db.run(
    "UPDATE features SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?",
    [feat.id]
  );
  return true;
}

function printLaunchInstructions(claimedNames: string[], projectDir: string): void {
  if (claimedNames.length === 0) return;

  console.log(chalk.bold(`\n  ${claimedNames.length} feature${claimedNames.length > 1 ? "s" : ""} ready to launch in parallel:`));
  for (const name of claimedNames) {
    console.log(`  ${chalk.green("✓")} ${chalk.white(name)} ${chalk.gray("— claimed")}`);
  }

  console.log(chalk.bold("\n  Launch in separate terminals:\n"));
  claimedNames.forEach((_, i) => {
    console.log(chalk.gray(`  Terminal ${i + 1}:`));
    console.log(`    cd ${projectDir}`);
    console.log(`    claude\n`);
  });

  console.log(chalk.gray("  Both agents will read AGENTS.md and know what to build.\n"));
  console.log(chalk.gray("  groundctl agents     → monitor progress"));
  console.log(chalk.gray("  groundctl stale      → detect if an agent stops"));
  console.log(chalk.gray("  groundctl dashboard  → visual cockpit at :4242\n"));
}

async function importAndClaim(features: SuggestedFeature[], projectDir: string): Promise<void> {
  const db = await openDb();
  const names: string[] = [];

  for (const f of features) {
    const name = f.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    const exists = queryOne(db, "SELECT id FROM features WHERE name = ?", [name]);
    if (!exists) {
      const id = randomUUID();
      const priority = ["critical", "high", "medium", "low"].includes(f.priority) ? f.priority : "medium";
      db.run(
        `INSERT INTO features (id, name, priority, description) VALUES (?, ?, ?, ?)`,
        [id, name, priority, f.description ?? null]
      );
    }
    names.push(name);
  }

  const parallelNames = features
    .filter(f => f.parallel_safe)
    .map(f => f.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""));

  const claimed: string[] = [];
  for (const name of parallelNames) {
    if (claimInDb(db, name)) claimed.push(name);
  }

  saveDb();
  closeDb();

  const total = new Set(names).size;
  console.log(chalk.green(`\n  ✓ ${total} feature${total !== 1 ? "s" : ""} imported\n`));

  printLaunchInstructions(claimed, projectDir);
  printHint();
}

// mode: "empty" = no open features at all; "low" = low backlog, already printed available
async function runSuggest(cwd: string, mode: "empty" | "low" = "empty"): Promise<void> {
  const db = await openDb();
  const completed = query<{ name: string; description: string | null }>(
    db, `SELECT name, description FROM features WHERE status = 'done' ORDER BY name`
  );
  closeDb();

  process.stdout.write(chalk.gray("  Fetching suggestions..."));

  const gitLog = tryGitLog(cwd);
  let incremental: SuggestedFeature[] = [];
  let expand: SuggestedFeature[] = [];

  try {
    const res = await fetch(SUGGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "groundctl-cli" },
      body: JSON.stringify({
        completedFeatures: completed.map(f => ({ name: f.name, description: f.description ?? undefined })),
        gitLog,
      }),
    });
    if (!res.ok) {
      const err = await res.json() as { error?: string };
      process.stdout.write("\n");
      console.log(chalk.red(`\n  Suggestion failed: ${err.error ?? res.statusText}\n`));
      printHint();
      return;
    }
    const data = await res.json() as { incremental?: SuggestedFeature[]; expand?: SuggestedFeature[] };
    incremental = (data.incremental ?? []).slice(0, 3);
    expand = (data.expand ?? []).slice(0, 3);
  } catch (err) {
    process.stdout.write("\n");
    console.log(chalk.red(`\n  Could not reach suggest API: ${(err as Error).message}\n`));
    printHint();
    return;
  }

  process.stdout.write("\r" + " ".repeat(42) + "\r");

  if (incremental.length === 0 && expand.length === 0) {
    console.log(chalk.yellow("  No suggestions returned.\n"));
    printHint();
    return;
  }

  if (mode === "empty") {
    console.log(chalk.bold("\n  No open features — here are suggestions:\n"));
  } else {
    console.log();
  }

  if (incremental.length > 0) printGroup("INCREMENTAL — build on what exists", incremental);
  if (expand.length > 0)      printGroup("EXPAND — new capabilities", expand);

  const answer = await readLine(
    chalk.bold("  Import incremental / expand / both / none? ") + chalk.gray("[i/e/b/n] ")
  );

  const choice = answer.toLowerCase();
  const toImport =
    choice === "i" ? incremental :
    choice === "e" ? expand :
    choice === "b" ? [...incremental, ...expand] :
    [];

  if (toImport.length === 0) {
    console.log(chalk.gray("\n  Skipped.\n"));
    printHint();
    return;
  }

  await importAndClaim(toImport, cwd);
}

export async function nextCommand(options: { suggest?: boolean }): Promise<void> {
  const db = await openDb();

  const available = query<{
    id: string;
    name: string;
    priority: string;
    description: string | null;
  }>(
    db,
    `SELECT f.id, f.name, f.priority, f.description
     FROM features f
     WHERE f.status = 'pending'
     AND f.id NOT IN (SELECT feature_id FROM claims WHERE released_at IS NULL)
     AND f.id NOT IN (
       SELECT d.feature_id
       FROM feature_dependencies d
       JOIN features dep ON dep.id = d.depends_on_id
       WHERE dep.status != 'done' AND d.type = 'blocks'
     )
     ORDER BY
       CASE f.priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
       END
     LIMIT 5`
  );

  closeDb();

  // ── No features at all ───────────────────────────────────────────────────────
  if (available.length === 0) {
    await runSuggest(process.cwd(), "empty");
    return;
  }

  // ── Show available features ──────────────────────────────────────────────────
  console.log(chalk.bold("\n  Next available:\n"));
  for (let i = 0; i < available.length; i++) {
    const feat = available[i];
    const pColor = feat.priority === "critical" || feat.priority === "high" ? chalk.red : chalk.gray;
    const marker = i === 0 ? chalk.green("→") : " ";
    console.log(`  ${marker} ${feat.name} ${pColor(`(${feat.priority})`)}`);
    if (feat.description) console.log(chalk.gray(`      ${feat.description}`));
  }

  // ── Low backlog: auto-suggest ────────────────────────────────────────────────
  if (available.length < LOW_BACKLOG_THRESHOLD || options.suggest) {
    if (available.length < LOW_BACKLOG_THRESHOLD) {
      console.log(chalk.yellow(`\n  ⚠ Low backlog (${available.length} feature${available.length > 1 ? "s" : ""} open)`));
    }
    await runSuggest(process.cwd(), "low");
    return;
  }

  console.log(chalk.gray(`\n  Claim with: groundctl claim "${available[0].name}"\n`));
}
