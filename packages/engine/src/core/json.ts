/** Reading JSON of unknown shape (API answers, stored files) without casts. */

/** A JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A finite number, or null. NaN and Infinity are not numbers here. */
export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The array itself, or an empty one when the value is not an array. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
