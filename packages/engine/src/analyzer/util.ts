/** Small helpers shared by the analyzer modules. */
import { trimTrailingSlashes } from '../core/text.ts';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** File link at a commit with optional line anchors, or null when the repository has no web URL. */
export function blobUrl(
  webUrl: string | null,
  sha: string,
  path: string,
  startLine?: number,
  endLine?: number,
): string | null {
  if (!webUrl || !sha) return null;
  const base = trimTrailingSlashes(webUrl);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  let url = `${base}/blob/${sha}/${encoded}`;
  if (startLine !== undefined && startLine > 0) {
    url += endLine !== undefined && endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  }
  return url;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
