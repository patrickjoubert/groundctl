import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "sql.js";
import {
  createTestDb,
  insertFeature,
  insertSession,
  claimFeature,
  queryNextAvailable,
} from "./helpers/db.js";

describe("next available features", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
    insertSession(db, "sess-1");
  });

  it("returns pending features ordered by priority", () => {
    insertFeature(db, { name: "low-prio",    priority: "low" });
    insertFeature(db, { name: "high-prio",   priority: "high" });
    insertFeature(db, { name: "medium-prio", priority: "medium" });
    insertFeature(db, { name: "critical",    priority: "critical" });

    const next = queryNextAvailable(db);
    expect(next.map(f => f.name)).toEqual([
      "critical", "high-prio", "medium-prio", "low-prio",
    ]);
  });

  it("excludes features with active claims", () => {
    const id = insertFeature(db, { name: "claimed-feature" });
    claimFeature(db, id, "sess-1");

    const next = queryNextAvailable(db);
    expect(next.find(f => f.name === "claimed-feature")).toBeUndefined();
  });

  it("excludes done features", () => {
    insertFeature(db, { name: "done-feature", status: "done" });
    insertFeature(db, { name: "open-feature" });

    const next = queryNextAvailable(db);
    expect(next.map(f => f.name)).toEqual(["open-feature"]);
  });

  it("returns empty list when no features exist", () => {
    const next = queryNextAvailable(db);
    expect(next).toHaveLength(0);
  });

  it("returns empty list when all features are claimed or done", () => {
    const id1 = insertFeature(db, { name: "f1" });
    insertFeature(db, { name: "f2", status: "done" });
    claimFeature(db, id1, "sess-1");

    const next = queryNextAvailable(db);
    expect(next).toHaveLength(0);
  });

  it("caps results at 5", () => {
    for (let i = 1; i <= 8; i++) {
      insertFeature(db, { name: `feature-${i}` });
    }
    const next = queryNextAvailable(db);
    expect(next).toHaveLength(5);
  });
});
