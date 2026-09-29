import type { GeneratedImageDto } from "../shared/contracts.js";

/**
 * Bounded in-process delivery cache (CONTRACTS §4.3).
 *
 * Exists so an idempotent replay after a dropped response can still hand back
 * the bytes the user was billed for. It is a best-effort convenience, not a
 * download service:
 *
 * - memory only — never written to disk or the database, gone on restart;
 * - LRU eviction is expected behaviour, so the TTL is not a promise;
 * - a miss is reported as `unavailable/cache-miss`, never as a new generation.
 */

type Entry = { userId: string; submissionId: string; images: GeneratedImageDto[]; bytes: number; expiresAt: number };

export class ResultCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  private key(userId: string, submissionId: string) {
    return `${userId}\u0000${submissionId}`;
  }

  /** Publishes a successful result. Must run before the run is marked success. */
  publish(userId: string, submissionId: string, images: GeneratedImageDto[]): void {
    const bytes = images.reduce((sum, image) => sum + image.byteSize, 0);
    if (bytes > this.maxBytes) return; // never admit one entry that alone exceeds the budget
    const key = this.key(userId, submissionId);
    this.evict(key);
    this.entries.set(key, { userId, submissionId, images, bytes, expiresAt: this.now() + this.ttlMs });
    this.totalBytes += bytes;
    this.trim();
  }

  /** A hit stays readable for the rest of its TTL; replays are repeatable. */
  get(userId: string, submissionId: string): GeneratedImageDto[] | null {
    const key = this.key(userId, submissionId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.evict(key);
      return null;
    }
    // Refresh recency for LRU ordering.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.images;
  }

  /** Called when run history is deleted (CONTRACTS §6.3). */
  clear(userId: string, submissionId: string): void {
    this.evict(this.key(userId, submissionId));
  }

  private evict(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  private trim() {
    // Map preserves insertion order, which is recency after `get` refreshes.
    for (const [key, entry] of this.entries) {
      if (this.totalBytes <= this.maxBytes) break;
      if (entry.expiresAt <= this.now() || this.totalBytes > this.maxBytes) this.evict(key);
    }
  }
}
