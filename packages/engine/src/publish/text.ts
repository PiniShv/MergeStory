/**
 * Helpers for text that comes from pull requests and models. Everything here treats its
 * input as hostile: control characters are dropped, URLs are checked, markup is escaped.
 */
import { stripInvisible, truncate } from '../core/text.ts';

/**
 * Single-line plain text: invisible and direction-control characters removed, whitespace
 * collapsed, length capped. Anything that is not a string becomes an empty string.
 */
export function cleanText(value: unknown, max = 500): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return truncate(stripInvisible(text, 'white-space').replace(/\s+/g, ' ').trim(), max);
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for use in HTML content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

/** Escape a value for a double-quoted HTML attribute. Single quotes stay readable. */
export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

/** Clean, cap and HTML-escape in one step. */
export function htmlText(value: unknown, max = 500): string {
  return escapeHtml(cleanText(value, max));
}

/** A normalised http(s) URL without embedded credentials, or null. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

// A plain relative path such as "video.mp4": no scheme, no leading slash, no "..", no escapes.
const RELATIVE_ASSET = /^[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*(?:\/[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*)*$/;

/** An http(s) URL or a plain relative file path (used by the local watch page), or null. */
export function safeAssetUrl(value: unknown): string | null {
  const absolute = safeHttpUrl(value);
  if (absolute) return absolute;
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!RELATIVE_ASSET.test(path)) return null;
  return path.split('/').some((segment) => segment === '..' || segment === '.') ? null : path;
}

/** "m:ss", or "h:mm:ss" from one hour up. Negative and invalid values count as zero. */
export function formatTimestamp(totalSec: number): string {
  const total = Number.isFinite(totalSec) ? Math.max(0, Math.floor(totalSec)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** "2026-11-03", or null when the value is not a valid date. */
export function formatDate(iso: unknown): string | null {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** "2026-11-03 14:05 UTC", or null when the value is not a valid date. */
export function formatDateTime(iso: unknown): string | null {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** First seven characters of a commit id, or null when it does not look like one. */
export function shortSha(sha: unknown): string | null {
  return typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha.trim())
    ? sha.trim().slice(0, 7).toLowerCase()
    : null;
}
