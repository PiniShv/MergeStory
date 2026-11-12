/**
 * The name and the description of the video file in Google Drive. Both are plain text built from
 * pull request text, so they are cleaned like every other untrusted value.
 */
import type { PublishMeta } from '../../core/providers.ts';
import { truncate } from '../../core/text.ts';
import { cleanText, formatTimestamp, safeHttpUrl } from '../text.ts';
import { MADE_WITH, REVIEW_NOTE } from '../youtube/description.ts';

export const NAME_MAX_CHARS = 150;
export const DESCRIPTION_MAX_CHARS = 3_000;
const MAX_CHAPTERS = 20;
const MAX_CHECKLIST_ITEMS = 15;

/** One line without control characters, and without / or \, which read as folders. */
function nameText(value: unknown, max: number): string {
  return cleanText(cleanText(value, max * 2).replace(/[/\\]/g, ' '), max);
}

/** "<title> (<change label>).mp4", at most 150 characters before the extension. */
export function buildFileName(meta: Pick<PublishMeta, 'title' | 'changeLabel'>): string {
  const title = nameText(meta.title, NAME_MAX_CHARS) || 'MergeStory video';
  const label = nameText(meta.changeLabel, 60);
  return `${truncate(label ? `${title} (${label})` : title, NAME_MAX_CHARS)}.mp4`;
}

/** Cut at the last line end that fits, so no line is cut in half. */
function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = head.lastIndexOf('\n');
  return (end > 0 ? head.slice(0, end) : truncate(text, max)).trimEnd();
}

/**
 * Summary, pull request link, chapters with their start times, and the review checklist. The link is
 * kept for private repositories too: the file is only public when the user chose that, and that path
 * has its own guard.
 */
export function buildDriveDescription(meta: PublishMeta): string {
  const sections: string[] = [];
  const summary = cleanText(meta.summary, 2_000);
  if (summary) sections.push(summary);
  const url = safeHttpUrl(meta.changeUrl);
  if (url) sections.push(`Pull request: ${url}`);
  const chapters = meta.chapters
    .slice(0, MAX_CHAPTERS)
    .map((c, i) => `${formatTimestamp(c.startSec)} ${cleanText(c.title, 100) || `Part ${i + 1}`}`);
  if (chapters.length > 0) sections.push(['Chapters', ...chapters].join('\n'));
  const checklist = meta.checklist
    .slice(0, MAX_CHECKLIST_ITEMS)
    .map((item) => cleanText(item.title, 200))
    .filter(Boolean)
    .map((title) => `- ${title}`);
  if (checklist.length > 0) sections.push(['Review checklist', ...checklist].join('\n'));
  sections.push(`${MADE_WITH}\n${REVIEW_NOTE}`);
  return cutAtLine(sections.join('\n\n'), DESCRIPTION_MAX_CHARS);
}
