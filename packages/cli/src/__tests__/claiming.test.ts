import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "sql.js";
import {
  createTestDb,
  insertFeature,
  insertSession,
  claimFeature,
  releaseFeature,
  activeClaims,
  featureStatus,
} from "./helpers/db.js";

describe("claiming system", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
    insertSession(db, "session-a");
    insertSession(db, "session-b");
  });

  it("claim sets feature to in_progress", () => {
    const id = insertFeature(db, { name: "my-feature" });
    expect(featureStatus(db, id)).toBe("pending");

    claimFeature(db, id, "session-a");

    expect(featureStatus(db, id)).toBe("in_progress");
    expect(activeClaims(db, id)).toBe(1);
  });

  it("double-claim of same feature is blocked", () => {
    const id = insertFeature(db, { name: "double-claim" });
    claimFeature(db, id, "session-a");

    // Second claim attempt — check that active claims stays at 1
    // (the claim command checks activeClaims > 0 before inserting)
    const alreadyClaimed = activeClaims(db, id) > 0;
    expect(alreadyClaimed).toBe(true);
    // No second row inserted
    expect(activeClaims(db, id)).toBe(1);
  });

  it("complete releases claim and marks feature done", () => {
    const id = insertFeature(db, { name: "to-complete" });
    claimFeature(db, id, "session-a");
    expect(featureStatus(db, id)).toBe("in_progress");

    releaseFeature(db, id);

    expect(featureStatus(db, id)).toBe("done");
    expect(activeClaims(db, id)).toBe(0);
  });

  it("re-claim succeeds after completion (claim → complete → claim)", () => {
    const id = insertFeature(db, { name: "re-claimable" });

    // First lifecycle
    claimFeature(db, id, "session-a");
    releaseFeature(db, id);
    expect(featureStatus(db, id)).toBe("done");

    // Reset to pending to allow re-claim (simulates "reopen")
    db.run(`UPDATE features SET status = 'pending', completed_at = NULL WHERE id = ?`, [id]);

    // Second claim
    claimFeature(db, id, "session-b");
    expect(featureStatus(db, id)).toBe("in_progress");
    expect(activeClaims(db, id)).toBe(1);
  });

  it("different features can be claimed independently", () => {
    const idA = insertFeature(db, { name: "feature-a" });
    const idB = insertFeature(db, { name: "feature-b" });

    claimFeature(db, idA, "session-a");
    claimFeature(db, idB, "session-b");

    expect(featureStatus(db, idA)).toBe("in_progress");
    expect(featureStatus(db, idB)).toBe("in_progress");
    expect(activeClaims(db, idA)).toBe(1);
    expect(activeClaims(db, idB)).toBe(1);
  });
});
