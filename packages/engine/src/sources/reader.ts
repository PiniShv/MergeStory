/** A read-only RepoReader with the privacy rules and a small in-memory cache built in. */
import { safeRepoPath } from '../core/paths.ts';
import type { RepoReader, Side } from '../core/types.ts';

export interface GuardedReaderOptions {
  isProtected(path: string): boolean;
  /** Reads one file; null when it is missing, binary or too large. Errors are passed on. */
  load(path: string, side: Side): Promise<string | null>;
  /** Upper bound for the text kept in memory (characters). Default 16 million. */
  maxCachedChars?: number;
}

/**
 * Wrap a loader so that unsafe paths and protected files read as null, repeated and concurrent
 * reads of one file share a single load, and memory stays bounded. Failed loads are not cached.
 */
export function createGuardedReader(options: GuardedReaderOptions): RepoReader {
  const maxChars = options.maxCachedChars ?? 16_000_000;
  const entries = new Map<string, { promise: Promise<string | null>; size: number }>();
  let total = 0;

  const evict = () => {
    for (const [key, entry] of entries) {
      if (total <= maxChars || entries.size <= 1) break;
      if (entry.size === 0) continue;
      total -= entry.size;
      entries.delete(key);
    }
  };

  return {
    readFile(path: string, side: Side): Promise<string | null> {
      const safe = safeRepoPath(path);
      if (safe === null || options.isProtected(safe)) return Promise.resolve(null);
      const key = `${side}:${safe}`;
      const hit = entries.get(key);
      if (hit) return hit.promise;
      const entry = { promise: Promise.resolve<string | null>(null), size: 0 };
      entry.promise = options.load(safe, side).then(
        (value) => {
          entry.size = value?.length ?? 0;
          total += entry.size;
          evict();
          return value;
        },
        (error: unknown) => {
          entries.delete(key);
          throw error;
        },
      );
      entries.set(key, entry);
      return entry.promise;
    },
  };
}
