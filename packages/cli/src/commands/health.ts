import chalk from "../colors.js";
import { openDb, closeDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

interface CountRow { count: number }
interface FeatureCountRow { status: string; count: number }

export async function healthCommand(): Promise<void> {
  const db = await openDb();
  const projectName = process.cwd().split("/").pop() ?? "unknown";

  // 1. Feature completion (40 pts max)
  const featureCounts = query<FeatureCountRow>(
    db,
    "SELECT status, COUNT(*) as count FROM features GROUP BY status"
  );
  const counts: Record<string, number> = { pending: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const row of featureCounts) counts[row.status] = row.count;
  const total = counts.pending + counts.in_progress + counts.done + counts.blocked;
  const featurePct = total > 0 ? counts.done / total : 0;
  const featureScore = Math.round(featurePct * 40);

  // 2. Tests written (20 pts max)
  // Look for .test. or .spec. files in files_modified
  const testFiles = queryOne<CountRow>(
    db,
    `SELECT COUNT(*) as count FROM files_modified
     WHERE path LIKE '%.test.%' OR path LIKE '%.spec.%'
        OR path LIKE '%/test/%' OR path LIKE '%/tests/%'
        OR path LIKE '%/__tests__/%'`
  )?.count ?? 0;
  const testScore = testFiles > 0 ? Math.min(20, Math.round((testFiles / Math.max(1, total)) * 40)) : 0;

  // 3. Decisions documented (20 pts max)
  const decisionCount = queryOne<CountRow>(db, "SELECT COUNT(*) as count FROM decisions")?.count ?? 0;
  // Expect at least 1 decision per session
  const sessionCount = queryOne<CountRow>(db, "SELECT COUNT(*) as count FROM sessions")?.count ?? 0;
  const decisionRatio = sessionCount > 0 ? Math.min(1, decisionCount / sessionCount) : 0;
  const decisionScore = Math.round(decisionRatio * 20);

  // 4. Claims health — no stale claims open > 24h (10 pts max)
  const staleClaims = queryOne<CountRow>(
    db,
    `SELECT COUNT(*) as count FROM claims
     WHERE released_at IS NULL
     AND datetime(claimed_at, '+24 hours') < datetime('now')`
  )?.count ?? 0;
  const claimScore = staleClaims === 0 ? 10 : Math.max(0, 10 - staleClaims * 5);

  // 5. Deploy status (10 pts max) — heuristic: look for deploy/railway/fly/heroku in files or decisions
  const deployMentions = queryOne<CountRow>(
    db,
    `SELECT COUNT(*) as count FROM decisions
     WHERE lower(description) LIKE '%deploy%'
        OR lower(description) LIKE '%railway%'
        OR lower(description) LIKE '%fly.io%'
        OR lower(description) LIKE '%heroku%'`
  )?.count ?? 0;
  const deployFiles = queryOne<CountRow>(
    db,
    `SELECT COUNT(*) as count FROM files_modified
     WHERE lower(path) LIKE '%railway%' OR lower(path) LIKE '%fly.toml%'
        OR lower(path) LIKE '%heroku%' OR lower(path) LIKE 'procfile%'
        OR lower(path) LIKE '%dockerfile%' OR lower(path) LIKE '%deploy%'`
  )?.count ?? 0;
  const deployScore = (deployMentions > 0 || deployFiles > 0) ? 10 : 0;

  closeDb();

  const totalScore = featureScore + testScore + decisionScore + claimScore + deployScore;

  // Render
  console.log("");
  console.log(chalk.bold(`  ${projectName} — Health Score: ${totalScore}/100\n`));

  // Feature completion
  const featureColor = featurePct >= 0.7 ? chalk.green : featurePct >= 0.4 ? chalk.yellow : chalk.red;
  const featureMark = featurePct >= 0.4 ? "✅" : "⚠️ ";
  console.log(
    `  ${featureMark} Features    ${String(counts.done).padStart(2)}/${total} complete` +
    featureColor(`  (${Math.round(featurePct * 100)}%)`) +
    chalk.gray(`  +${featureScore}pts`)
  );

  // Tests
  const testMark = testFiles > 0 ? "✅" : "⚠️ ";
  const testColor = testFiles > 0 ? chalk.green : chalk.red;
  console.log(
    `  ${testMark} Tests       ${testColor(String(testFiles) + " test files")}` +
    (testFiles === 0 ? chalk.red("  (-20pts)") : chalk.gray(`  +${testScore}pts`))
  );

  // Architecture log
  const decMark = decisionCount > 0 ? "✅" : "⚠️ ";
  const decColor = decisionCount > 0 ? chalk.green : chalk.yellow;
  console.log(
    `  ${decMark} Arch log    ${decColor(decisionCount + " entries")}` +
    chalk.gray(`  +${decisionScore}pts`)
  );

  // Claims
  const claimMark = staleClaims === 0 ? "✅" : "⚠️ ";
  const claimColor = staleClaims === 0 ? chalk.green : chalk.red;
  console.log(
    `  ${claimMark} Claims      ${claimColor(staleClaims > 0 ? staleClaims + " stale (>24h)" : "0 stale")}` +
    chalk.gray(`  +${claimScore}pts`)
  );

  // Deploy
  const deployMark = deployScore > 0 ? "✅" : "⚠️ ";
  const deployLabel = deployScore > 0 ? chalk.green("detected") : chalk.gray("not detected");
  console.log(
    `  ${deployMark} Deploy      ${deployLabel}` +
    (deployScore > 0 ? chalk.gray(`  +${deployScore}pts`) : chalk.gray("  +0pts"))
  );

  console.log("");

  // Recommendations
  const recommendations: string[] = [];
  if (testFiles === 0) recommendations.push("Write tests before your next feature (0 test files found).");
  if (staleClaims > 0) recommendations.push(`Release ${staleClaims} stale claim(s) with groundctl complete <feature>.`);
  if (decisionCount === 0) recommendations.push("Log architecture decisions during sessions so agents understand the why.");
  if (featurePct < 0.5 && total > 0) recommendations.push(`${counts.pending} features pending — run groundctl next to pick one.`);

  if (recommendations.length > 0) {
    console.log(chalk.bold("  Recommendations:"));
    for (const r of recommendations) {
      console.log(chalk.yellow(`    → ${r}`));
    }
    console.log("");
  }
}
