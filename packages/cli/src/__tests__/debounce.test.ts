import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the debounce pattern used in the watch command.
 * The watcher delays ingest by DEBOUNCE_MS after the last file write,
 * so sessions are only ingested when they look "stable" (agent has stopped writing).
 */

const DEBOUNCE_MS = 8_000;

/** Minimal debounce implementation mirroring the watcher's schedule() function. */
function makeDebouncer(onFire: (file: string) => void) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const ingested = new Set<string>();

  return {
    schedule(file: string) {
      if (ingested.has(file)) return;
      const existing = pending.get(file);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        pending.delete(file);
        if (ingested.has(file)) return;
        ingested.add(file);
        onFire(file);
      }, DEBOUNCE_MS);
      pending.set(file, timer);
    },
    hasPending(file: string) { return pending.has(file); },
    hasIngested(file: string) { return ingested.has(file); },
  };
}

describe("watch debounce (8s stability threshold)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not fire before 8s", () => {
    const onFire = vi.fn();
    const d = makeDebouncer(onFire);

    d.schedule("session.jsonl");
    vi.advanceTimersByTime(7_999);

    expect(onFire).not.toHaveBeenCalled();
  });

  it("fires exactly at 8s of silence", () => {
    const onFire = vi.fn();
    const d = makeDebouncer(onFire);

    d.schedule("session.jsonl");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onFire).toHaveBeenCalledOnce();
    expect(onFire).toHaveBeenCalledWith("session.jsonl");
  });

  it("resets the timer on each new write (simulates agent still writing)", () => {
    const onFire = vi.fn();
    const d = makeDebouncer(onFire);

    // Agent writes at 0s, 3s, 6s, 9s — timer resets each time
    d.schedule("active.jsonl");
    vi.advanceTimersByTime(3_000);
    d.schedule("active.jsonl"); // reset

    vi.advanceTimersByTime(3_000);
    d.schedule("active.jsonl"); // reset again

    vi.advanceTimersByTime(3_000);
    d.schedule("active.jsonl"); // reset again

    // 9s elapsed, but timer was reset at 9s — 8s has not passed since last write
    vi.advanceTimersByTime(7_999);
    expect(onFire).not.toHaveBeenCalled();

    // Now 8s since last write
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("fires only once even if scheduled multiple times after firing", () => {
    const onFire = vi.fn();
    const d = makeDebouncer(onFire);

    d.schedule("once.jsonl");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(onFire).toHaveBeenCalledOnce();

    // Re-scheduling after ingestion should be a no-op
    d.schedule("once.jsonl");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(onFire).toHaveBeenCalledOnce(); // still only once
  });

  it("tracks separate files independently", () => {
    const onFire = vi.fn();
    const d = makeDebouncer(onFire);

    d.schedule("file-a.jsonl");
    vi.advanceTimersByTime(4_000);
    d.schedule("file-b.jsonl"); // B starts 4s later

    vi.advanceTimersByTime(4_000); // 8s for A, 4s for B
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("file-a.jsonl");

    vi.advanceTimersByTime(4_000); // now 8s for B too
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(onFire).toHaveBeenCalledWith("file-b.jsonl");
  });
});
