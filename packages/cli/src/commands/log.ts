import chalk from "../colors.js";
import { openDb, closeDb } from "../storage/db.js";
import { query, queryOne } from "../storage/query.js";

export async function logCommand(options: { session?: string }): Promise<void> {
  const db = await openDb();

  if (options.session) {
    const session = queryOne<{
      id: string;
      agent: string;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
    }>(db, "SELECT * FROM sessions WHERE id = ? OR id LIKE ?", [
      options.session,
      `%${options.session}%`,
    ]);

    if (!session) {
      console.log(chalk.red(`\n  Session "${options.session}" not found.\n`));
      closeDb();
      return;
    }

    console.log(chalk.bold(`\n  Session ${session.id}`));
    console.log(chalk.gray(`  Agent: ${session.agent}`));
    console.log(chalk.gray(`  Started: ${session.started_at}`));
    if (session.ended_at) {
      console.log(chalk.gray(`  Ended: ${session.ended_at}`));
    }
    if (session.summary) {
      console.log(`\n  ${session.summary}`);
    }

    const decisions = query<{ description: string; rationale: string | null }>(
      db,
      "SELECT description, rationale FROM decisions WHERE session_id = ?",
      [session.id]
    );

    if (decisions.length > 0) {
      console.log(chalk.bold("\n  Decisions:"));
      for (const d of decisions) {
        console.log(`    • ${d.description}`);
        if (d.rationale) {
          console.log(chalk.gray(`      ${d.rationale}`));
        }
      }
    }

    const files = query<{
      path: string;
      operation: string;
      lines_changed: number;
    }>(
      db,
      "SELECT path, operation, lines_changed FROM files_modified WHERE session_id = ? ORDER BY created_at",
      [session.id]
    );

    if (files.length > 0) {
      console.log(chalk.bold(`\n  Files modified (${files.length}):`));
      for (const f of files) {
        const op =
          f.operation === "created"
            ? chalk.green("+")
            : f.operation === "deleted"
              ? chalk.red("-")
              : chalk.yellow("~");
        console.log(`    ${op} ${f.path} (${f.lines_changed} lines)`);
      }
    }

    console.log("");
  } else {
    const sessions = query<{
      id: string;
      agent: string;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
    }>(db, "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20");

    if (sessions.length === 0) {
      console.log(chalk.yellow("\n  No sessions recorded yet.\n"));
      closeDb();
      return;
    }

    console.log(chalk.bold("\n  Session timeline:\n"));
    for (const s of sessions) {
      const status = s.ended_at ? chalk.green("done") : chalk.yellow("active");
      console.log(
        `  ${chalk.bold(s.id)}  ${chalk.gray(s.started_at)}  ${status}  ${chalk.gray(s.agent)}`
      );
      if (s.summary) {
        console.log(chalk.gray(`    ${s.summary}`));
      }
    }
    console.log("");
  }

  closeDb();
}
