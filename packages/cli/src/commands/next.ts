import chalk from "../colors.js";
import { openDb, closeDb } from "../storage/db.js";
import { query } from "../storage/query.js";

export async function nextCommand(): Promise<void> {
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
    console.log(chalk.yellow("\n  No available features to claim.\n"));
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
