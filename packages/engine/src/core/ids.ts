import { createHash, randomBytes } from 'node:crypto';

/** JSON.stringify with sorted object keys, so equal values always hash the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Content hash for cache keys. */
export function hashKey(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Unguessable random token (hex). 16 bytes = 128 bits by default. */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/** What newRunId() returns. Job ids have the same form. */
export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{4}$/;

/** Sortable run id: UTC timestamp plus a short random suffix, e.g. "20261103-214501-a3f9". */
export function newRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${iso}-${randomToken(2)}`;
}
