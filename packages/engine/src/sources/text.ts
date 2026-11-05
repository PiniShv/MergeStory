/** Text helpers shared by the sources: privacy masking, commit messages and excerpts. */
import { maskPrivate } from '../core/secrets.ts';
import { COMMIT_BODY_MAX_CHARS, COMMIT_SUBJECT_MAX_CHARS } from './limits.ts';

export interface PrivacyOptions {
  maskEmails: boolean;
}

/** Cut text to at most `maxChars` characters without splitting a surrogate pair. */
export function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Mask secrets, and e-mail addresses when configured. Used for text that comes from the repository or the PR. */
export function sanitizeText(text: string, privacy: PrivacyOptions): string {
  return maskPrivate(text, { maskEmails: privacy.maskEmails });
}

/**
 * Split a commit message into subject and body, like git: the subject is the first paragraph
 * joined into one line, the body is the rest.
 */
export function splitCommitMessage(message: string): { subject: string; body: string } {
  const text = message.replace(/\r\n/g, '\n').trim();
  if (!text) return { subject: '', body: '' };
  const join = (part: string) =>
    part
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
  const blank = text.search(/\n[ \t]*\n/);
  if (blank < 0) return { subject: join(text), body: '' };
  return { subject: join(text.slice(0, blank)), body: text.slice(blank).trim() };
}

/** Trailer lines that name a person ("Co-authored-by: Name <mail@example.com>"). */
const PERSON_TRAILER = /^[ \t]*[A-Za-z][A-Za-z0-9-]*:[ \t].*<[^<>\s]+@[^<>\s]+>[ \t]*$/;

/**
 * Clean a commit message for a change set: drop trailer lines that name people, mask secrets
 * and e-mail addresses, and cap the length. Authors are never collected.
 */
export function cleanCommitMessage(
  message: string,
  privacy: PrivacyOptions,
): { subject: string; body: string } {
  const { subject, body } = splitCommitMessage(message);
  const keptBody = body
    .split('\n')
    .filter((line) => !PERSON_TRAILER.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    subject: cutText(sanitizeText(subject, privacy), COMMIT_SUBJECT_MAX_CHARS),
    body: cutText(sanitizeText(keptBody, privacy), COMMIT_BODY_MAX_CHARS),
  };
}

/** The first lines of a text, as whole lines, within a character budget. */
export function excerptLines(text: string, maxLines: number, maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n').slice(0, maxLines)) {
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      if (kept.length === 0) kept.push(cutText(line, maxChars));
      break;
    }
    kept.push(line);
    used += cost;
  }
  return kept.join('\n').trimEnd();
}
