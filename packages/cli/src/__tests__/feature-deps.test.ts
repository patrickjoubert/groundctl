import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "sql.js";
import {
  createTestDb,
  insertFeature,
  queryNextAvailable,
} from "./helpers/db.js";

/** Add a 'blocks' dependency: doing featureId requires dependsOnId to be done first. */
function addDep(db: Database, featureId: string, dependsOnId: string): void {
  db.run(
    `INSERT INTO feature_dependencies (feature_id, depends_on_id, type) VALUES (?, ?, 'blocks')`,
    [featureId, dependsOnId]
  );
}

describe("feature_dependencies — blocked features", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("blocked feature is not returned by next when blocker is pending", () => {
    const idA = insertFeature(db, { name: "foundation" });      // blocker
    const idB = insertFeature(db, { name: "blocked-feature" }); // depends on A
    addDep(db, idB, idA);

    const next = queryNextAvailable(db);
    const names = next.map(f => f.name);

    expect(names).toContain("foundation");         // blocker is available
    expect(names).not.toContain("blocked-feature"); // blocked is not
  });

  it("blocked feature becomes available once blocker is done", () => {
    const idA = insertFeature(db, { name: "auth" });
    const idB = insertFeature(db, { name: "user-profile" });
    addDep(db, idB, idA);

    // Mark A as done
    db.run(`UPDATE features SET status = 'done' WHERE id = ?`, [idA]);

    const next = queryNextAvailable(db);
    const names = next.map(f => f.name);

    // A is done → no longer pending → not in next
    expect(names).not.toContain("auth");
    // B is now unblocked
    expect(names).toContain("user-profile");
  });

  it("feature with multiple deps is blocked until all are done", () => {
    const idA = insertFeature(db, { name: "dep-a" });
    const idB = insertFeature(db, { name: "dep-b" });
    const idC = insertFeature(db, { name: "requires-both" });
    addDep(db, idC, idA);
    addDep(db, idC, idB);

    // Only A done — C still blocked by B
    db.run(`UPDATE features SET status = 'done' WHERE id = ?`, [idA]);

    let next = queryNextAvailable(db);
    expect(next.map(f => f.name)).not.toContain("requires-both");

    // B also done — C now available
    db.run(`UPDATE features SET status = 'done' WHERE id = ?`, [idB]);

    next = queryNextAvailable(db);
    expect(next.map(f => f.name)).toContain("requires-both");
  });

  it("suggests dependency (non-blocking) does not prevent feature from appearing", () => {
    const idA = insertFeature(db, { name: "nice-to-have" });
    const idB = insertFeature(db, { name: "soft-dep-feature" });
    // 'suggests' type — does not block
    db.run(
      `INSERT INTO feature_dependencies (feature_id, depends_on_id, type) VALUES (?, ?, 'suggests')`,
      [idB, idA]
    );

    const next = queryNextAvailable(db);
    const names = next.map(f => f.name);
    expect(names).toContain("nice-to-have");
    expect(names).toContain("soft-dep-feature"); // still available
  });
});
