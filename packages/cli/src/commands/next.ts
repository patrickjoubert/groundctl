import chalk from "../colors.js";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { openDb, closeDb, saveDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

const SUGGEST_URL = "https://detect.groundctl.org/suggest";

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

async function runSuggest(cwd: string): Promise<void> {
  const db = await openDb();

  const completed = query<{ name: string; description: string | null }>(
    db,
    `SELECT name, description FROM features WHERE status = 'done' ORDER BY name`
  );

  closeDb();

  process.stdout.write(chalk.gray("\n  Asking Claude for suggestions..."));

  const gitLog = tryGitLog(cwd);

  let suggestions: SuggestedFeature[] = [];
  try {
    const res = await fetch(SUGGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "groundctl-cli",
      },
      body: JSON.stringify({
        completedFeatures: completed.map(f => ({ name: f.name, description: f.description ?? undefined })),
        gitLog,
      }),
    });
    if (!res.ok) {
      const err = await res.json() as { error?: string };
      process.stdout.write("\n");
      console.log(chalk.red(`\n  Suggestion failed: ${err.error ?? res.statusText}\n`));
      return;
    }
    const data = await res.json() as { features?: SuggestedFeature[] };
    suggestions = (data.features ?? []).slice(0, 3);
  } catch (err) {
    process.stdout.write("\n");
    console.log(chalk.red(`\n  Could not reach suggest API: ${(err as Error).message}\n`));
    return;
  }

  process.stdout.write("\r" + " ".repeat(40) + "\r"); // clear spinner line

  if (suggestions.length === 0) {
    console.log(chalk.yellow("\n  No suggestions returned.\n"));
    return;
  }

  const parallel = suggestions.filter(f => f.parallel_safe);
  const sequential = suggestions.filter(f => !f.parallel_safe);

  console.log(chalk.bold("\n  No open features — here are 3 suggestions:\n"));

  if (parallel.length > 0) {
    console.log(chalk.gray("  Ready to launch in parallel:"));
    for (const f of parallel) {
      const pColor = f.priority === "critical" || f.priority === "high" ? chalk.red : chalk.gray;
      console.log(`  ${chalk.green("○")} ${chalk.white(f.name)} ${pColor(`(${f.priority})`)} — ${f.description}`);
      console.log(chalk.gray("    No dependencies — launch now"));
    }
    console.log();
  }

  if (sequential.length > 0) {
    console.log(chalk.gray("  After those:"));
    for (const f of sequential) {
      const pColor = f.priority === "critical" || f.priority === "high" ? chalk.red : chalk.gray;
      console.log(`  ${chalk.yellow("○")} ${chalk.white(f.name)} ${pColor(`(${f.priority})`)} — ${f.description}`);
      if (f.depends_on.length > 0) {
        console.log(chalk.gray(`    Needs: ${f.depends_on.join(" + ")}`));
      }
    }
    console.log();
  }

  const answer = await readLine(
    chalk.bold("  Import these features? ") + chalk.gray("[y/n] ")
  );

  if (answer.toLowerCase() !== "y") {
    console.log(chalk.gray("\n  Skipped.\n"));
    return;
  }

  const db2 = await openDb();

  for (const f of suggestions) {
    const name = f.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    const exists = queryOne(db2, "SELECT id FROM features WHERE name = ?", [name]);
    if (exists) continue;
    const id = randomUUID();
    const priority = ["critical", "high", "medium", "low"].includes(f.priority) ? f.priority : "medium";
    db2.run(
      `INSERT INTO features (id, name, priority, description) VALUES (?, ?, ?, ?)`,
      [id, name, priority, f.description ?? null]
    );
  }

  saveDb();
  closeDb();

  console.log(chalk.green(`\n  ✓ ${suggestions.length} features imported\n`));
  console.log(chalk.gray(`  Run: groundctl next\n`));
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

  if (available.length === 0) {
    if (options.suggest) {
      await runSuggest(process.cwd());
      return;
    }
    console.log(chalk.yellow("\n  No available features to claim."));
    console.log(chalk.gray("  Tip: groundctl next --suggest to get AI-powered suggestions\n"));
    return;
  }

  console.log(chalk.bold("\n  Next available features:\n"));
  for (let i = 0; i < available.length; i++) {
    const feat = available[i];
    const pColor =
      feat.priority === "critical" || feat.priority === "high"
        ? chalk.red
        : chalk.gray;
    const marker = i === 0 ? chalk.green("→") : " ";
    console.log(`  ${marker} ${feat.name} ${pColor(`(${feat.priority})`)}`);
    if (feat.description) {
      console.log(chalk.gray(`      ${feat.description}`));
    }
  }

  console.log(chalk.gray(`\n  Claim with: groundctl claim "${available[0].name}"\n`));
}
