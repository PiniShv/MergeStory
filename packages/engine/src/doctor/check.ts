/** Small helpers that every group of checks uses. */
import type { CheckStatus, DoctorCheck } from './types.ts';

export function check(
  id: string,
  name: string,
  status: CheckStatus,
  detail: string,
  fix: string | null = null,
): DoctorCheck {
  return { id, name, status, detail, fix };
}

/** The host (with the port, if any) of an address, or null when it is not one. */
export function urlHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
