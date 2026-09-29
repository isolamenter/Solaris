import { describe, expect, it } from "vitest";
import type { GeneratedImageDto } from "../shared/contracts.js";
import { ResultCache } from "./resultCache.js";

/**
 * B05 — bounded in-process delivery cache (CONTRACTS §4.3).
 *
 * The cache only ever decides whether a successful run's bytes can still be
 * handed back. It must be per `(userId, submissionId)`, bounded by LRU and TTL,
 * gone on restart, and a miss — never a new generation.
 */

const image = (byteSize: number): GeneratedImageDto => ({ mimeType: "image/png", byteSize, dataBase64: "AAAA" });

/** Controllable clock, so TTL behaviour is asserted rather than slept through. */
function testClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("ResultCache", () => {
  it("returns the bytes published for the same user and submission", () => {
    const cache = new ResultCache(60_000, 1024);
    cache.publish("user-a", "sub-1", [image(10)]);
    expect(cache.get("user-a", "sub-1")).toEqual([image(10)]);
  });

  it("is scoped to (userId, submissionId): the same submission id does not cross users", () => {
    const cache = new ResultCache(60_000, 1024);
    cache.publish("user-a", "sub-1", [image(10)]);
    expect(cache.get("user-b", "sub-1")).toBeNull();
    expect(cache.get("user-a", "sub-2")).toBeNull();
  });

  it("misses once the entry's TTL has passed", () => {
    const clock = testClock();
    const cache = new ResultCache(1_000, 1024, clock.now);
    cache.publish("user-a", "sub-1", [image(10)]);

    clock.advance(999);
    expect(cache.get("user-a", "sub-1")).not.toBeNull();

    clock.advance(2);
    expect(cache.get("user-a", "sub-1")).toBeNull();
  });

  it("does not extend the TTL when an entry is read", () => {
    const clock = testClock();
    const cache = new ResultCache(1_000, 1024, clock.now);
    cache.publish("user-a", "sub-1", [image(10)]);

    clock.advance(900);
    expect(cache.get("user-a", "sub-1")).not.toBeNull();
    // A hit is readable for the rest of its TTL, not a fresh TTL.
    clock.advance(200);
    expect(cache.get("user-a", "sub-1")).toBeNull();
  });

  it("evicts the least recently used entry when the byte budget is exceeded", () => {
    const cache = new ResultCache(60_000, 10, testClock().now);
    cache.publish("user-a", "oldest", [image(5)]);
    cache.publish("user-a", "newer", [image(5)]);

    // Reading `oldest` makes `newer` the least recently used one.
    expect(cache.get("user-a", "oldest")).not.toBeNull();
    cache.publish("user-a", "newest", [image(5)]);

    expect(cache.get("user-a", "newer")).toBeNull();
    expect(cache.get("user-a", "oldest")).not.toBeNull();
    expect(cache.get("user-a", "newest")).not.toBeNull();
  });

  it("never admits a single entry larger than the whole budget", () => {
    const cache = new ResultCache(60_000, 10, testClock().now);
    cache.publish("user-a", "huge", [image(11)]);
    expect(cache.get("user-a", "huge")).toBeNull();
  });

  it("reclaims expired entries when it needs the budget back", () => {
    const clock = testClock();
    const cache = new ResultCache(1_000, 10, clock.now);
    cache.publish("user-a", "stale", [image(8)]);
    clock.advance(2_000);

    cache.publish("user-a", "fresh", [image(8)]);
    expect(cache.get("user-a", "stale")).toBeNull();
    expect(cache.get("user-a", "fresh")).not.toBeNull();
  });

  it("re-publishing the same key replaces the entry without double-counting", () => {
    const cache = new ResultCache(60_000, 10, testClock().now);
    cache.publish("user-a", "sub-1", [image(4)]);
    cache.publish("user-a", "sub-1", [image(4)]);
    cache.publish("user-a", "sub-2", [image(4)]);

    // 4 + 4 bytes: the budget still fits both, so the replacement was not
    // counted twice and did not evict anything.
    expect(cache.get("user-a", "sub-1")).not.toBeNull();
    expect(cache.get("user-a", "sub-2")).not.toBeNull();
  });

  it("clear removes exactly one submission's entry", () => {
    const cache = new ResultCache(60_000, 1024);
    cache.publish("user-a", "sub-1", [image(10)]);
    cache.publish("user-a", "sub-2", [image(10)]);

    cache.clear("user-a", "sub-1");
    expect(cache.get("user-a", "sub-1")).toBeNull();
    expect(cache.get("user-a", "sub-2")).not.toBeNull();
  });

  it("has nothing after a restart: a fresh instance holds no entry", () => {
    const first = new ResultCache(60_000, 1024);
    first.publish("user-a", "sub-1", [image(10)]);
    expect(first.get("user-a", "sub-1")).not.toBeNull();

    // Nothing is written to disk or the database, so a new process starts empty.
    const restarted = new ResultCache(60_000, 1024);
    expect(restarted.get("user-a", "sub-1")).toBeNull();
  });
});
