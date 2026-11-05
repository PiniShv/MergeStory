/**
 * The text YouTube shows next to the video: title, description, tags and language.
 *
 * Everything here treats its input as untrusted text from a pull request. Control characters are
 * dropped, whitespace is collapsed, and the characters YouTube rejects (< and >) never get through.
 * Limits (checked 2026-11, see the current Google docs): title 100 characters, description 5,000
 * bytes, tags 500 characters in total.
 */
import type { PublishMeta } from '../../core/providers.ts';
import { cleanText, safeHttpUrl } from '../text.ts';

export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_BYTES = 5_000;
export const TAGS_MAX_CHARS = 500;
/** YouTube makes chapters from timestamps only when there are at least three of them. */
export const MIN_CHAPTERS = 3;
/** ... and every chapter lasts at least ten seconds. */
export const MIN_CHAPTER_SEC = 10;

export const MADE_WITH = 'Made with MergeStory - every change has a story.';
export const REVIEW_NOTE = 'This video explains the change; it does not replace code review.';

/** Each variable part gets its own budget, so the fixed lines always fit within 5,000 bytes. */
const SECTION_MAX_BYTES = 1_400;
const LINK_MAX_BYTES = 500;
const MAX_CHAPTERS = 20;
const MAX_CHECKLIST_ITEMS = 15;
const TAG_MAX_CHARS = 30;
const FALLBACK_TITLE = 'Pull request explainer';

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Plain single-line text that YouTube accepts. The real angle brackets are swapped for look-alike
 * quotation marks, so `Result<T>` stays readable as `Result‹T›`.
 */
export function youTubeText(value: unknown, maxChars: number): string {
  return cleanText(value, maxChars).replace(/</g, '‹').replace(/>/g, '›');
}

/** Cut text to at most `maxBytes` bytes of UTF-8, at a character boundary, and mark the cut. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  const ellipsis = '…';
  if (maxBytes <= utf8Length(ellipsis)) return '';
  let used = utf8Length(ellipsis);
  let out = '';
  for (const char of text) {
    const size = utf8Length(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return `${out.trimEnd()}${ellipsis}`;
}

/** The video title: at most 100 characters (counted in UTF-16 units, which is the strictest reading). */
export function buildTitle(meta: Pick<PublishMeta, 'title' | 'changeLabel'>): string {
  const title = youTubeText(meta.title, 300) || youTubeText(meta.changeLabel, 100) || FALLBACK_TITLE;
  if (title.length <= TITLE_MAX_CHARS) return title;
  let out = '';
  for (const char of title) {
    if (out.length + char.length > TITLE_MAX_CHARS - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** A language code YouTube understands (such as "en" or "pt-BR"), or null when the value is not one. */
export function youTubeLanguage(language: string | null | undefined): string | null {
  const code = (language ?? '').trim().replace(/_/g, '-');
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(code) ? code : null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "00:00", "01:05", or "1:02:05" from one hour on. */
export function chapterStamp(startSec: number): string {
  const total = Number.isFinite(startSec) ? Math.max(0, Math.floor(startSec)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * true when YouTube will turn the timestamps into chapters: the first one is 00:00, there are at
 * least three, they run in order, and every chapter lasts at least ten seconds. The last chapter
 * is measured against the video length; when the length is not known, it is not checked.
 */
export function chaptersQualify(
  chapters: readonly { startSec: number }[],
  durationSec: number | null,
): boolean {
  if (chapters.length < MIN_CHAPTERS) return false;
  const starts = chapters.map((chapter) =>
    Number.isFinite(chapter.startSec) ? Math.floor(chapter.startSec) : -1,
  );
  if (starts[0] !== 0) return false;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] as number;
    const end =
      i + 1 < starts.length
        ? (starts[i + 1] as number)
        : durationSec === null
          ? null
          : Math.floor(durationSec);
    if (start < 0) return false;
    if (end !== null && end - start < MIN_CHAPTER_SEC) return false;
  }
  return true;
}

interface Block {
  heading: string;
  lines: string[];
}

/** Heading plus as many lines as fit the byte budget. */
function fitBlock(block: Block, budget: number, minLines = 0): string[] {
  const kept: string[] = [];
  let used = utf8Length(block.heading);
  for (const line of block.lines) {
    const size = utf8Length(line) + 1;
    if (used + size > budget) break;
    kept.push(line);
    used += size;
  }
  return kept.length >= Math.max(1, minLines) ? kept : [];
}

function chapterTitles(meta: Pick<PublishMeta, 'chapters'>): string[] {
  return meta.chapters
    .slice(0, MAX_CHAPTERS)
    .map((chapter, i) => youTubeText(chapter.title, 100) || `Part ${i + 1}`);
}

/** The length of the video when it is a usable number, else null (the last chapter is then not checked). */
function knownLength(durationSec: number): number | null {
  return Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
}

/** The chapter lines: with timestamps when YouTube will make chapters from them, otherwise a plain list. */
function chapterSection(meta: Pick<PublishMeta, 'chapters' | 'durationSec'>): string | null {
  if (meta.chapters.length === 0) return null;
  const titles = chapterTitles(meta);
  const withStamps = chaptersQualify(meta.chapters, knownLength(meta.durationSec));
  const stamped = titles.map((title, i) => `${chapterStamp(meta.chapters[i]?.startSec ?? 0)} ${title}`);
  const plain = titles.map((title) => `- ${title}`);
  if (withStamps) {
    // Cutting the list short keeps it valid when at least three chapters remain.
    const kept = fitBlock({ heading: 'Chapters', lines: stamped }, SECTION_MAX_BYTES, MIN_CHAPTERS);
    if (kept.length > 0) return ['Chapters', ...kept].join('\n');
  }
  const kept = fitBlock({ heading: 'Chapters', lines: plain }, SECTION_MAX_BYTES);
  return kept.length > 0 ? ['Chapters', ...kept].join('\n') : null;
}

export interface DescriptionInput {
  meta: PublishMeta;
  /** true only when the repository is known to be public. */
  repoIsPublic: boolean;
}

/**
 * The description: summary, chapters, review checklist, the pull request link (public repositories
 * only), and two fixed lines. At most 5,000 bytes, without < or >.
 */
export function buildDescription(input: DescriptionInput): string {
  const { meta } = input;
  const sections: string[] = [];

  const summary = truncateBytes(youTubeText(meta.summary, 2_000), SECTION_MAX_BYTES);
  if (summary) sections.push(summary);

  const chapters = chapterSection(meta);
  if (chapters) sections.push(chapters);

  const items = meta.checklist
    .slice(0, MAX_CHECKLIST_ITEMS)
    .map((item) => youTubeText(item.title, 200))
    .filter((title) => title.length > 0)
    .map((title) => `- ${title}`);
  const checklist = fitBlock({ heading: 'Review checklist', lines: items }, SECTION_MAX_BYTES);
  if (checklist.length > 0) sections.push(['Review checklist', ...checklist].join('\n'));

  // A link to a private repository would tell everyone with the video link where it lives.
  const url = input.repoIsPublic ? safeHttpUrl(meta.changeUrl) : null;
  const link = url ? `Pull request: ${url}` : null;
  if (link && utf8Length(link) <= LINK_MAX_BYTES) sections.push(youTubeText(link, LINK_MAX_BYTES));

  sections.push(`${MADE_WITH}\n${REVIEW_NOTE}`);
  return truncateBytes(sections.join('\n\n'), DESCRIPTION_MAX_BYTES);
}

/** Length of a tag list as YouTube counts it: commas count, and a tag with a space counts two more. */
export function tagsLength(tags: readonly string[]): number {
  return (
    tags.reduce((sum, tag) => sum + tag.length + (tag.includes(' ') ? 2 : 0), 0) +
    Math.max(0, tags.length - 1)
  );
}

/** Clean the tags, drop duplicates, and keep as many as fit within 500 characters. */
export function fitTags(tags: readonly string[], maxChars: number = TAGS_MAX_CHARS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = youTubeText(raw, TAG_MAX_CHARS).replace(/[‹›]/g, '').trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    if (tagsLength([...out, tag]) > maxChars) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Short, generic tags. The repository name is added only for public repositories. */
export function buildTags(meta: Pick<PublishMeta, 'repoLabel'>, repoIsPublic: boolean): string[] {
  const tags = ['MergeStory', 'pull request', 'code review'];
  if (repoIsPublic) {
    const name = cleanText(meta.repoLabel, 120).split('/').pop() ?? '';
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{1,29}$/.test(name)) tags.push(name);
  }
  return fitTags(tags);
}
