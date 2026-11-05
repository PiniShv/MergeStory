/**
 * Markdown for the pull request comment and the description section.
 *
 * Titles, summaries and checklist items come from a pull request or a model, so they are
 * neutralised before they are written: markup is stripped or escaped, nobody gets pinged,
 * issue references and bare links do not turn into live links, and lengths are capped.
 */
import { MergeStoryError } from '../core/errors.ts';
import { maskEmails } from '../core/secrets.ts';
import { SEVERITY_LABEL, severityOf, severityRank } from './severity.ts';
import { cleanText, formatDateTime, formatTimestamp, safeHttpUrl, shortSha } from './text.ts';
import {
  COMMENT_MARKER,
  type CommentData,
  DESCRIPTION_END,
  DESCRIPTION_START,
  type EvidenceLink,
} from './types.ts';

const MAX_CHECKLIST_ITEMS = 5;
const MAX_CHAPTERS = 12;

/** Zero-width space: invisible, but it stops GitHub from linking what follows. */
const ZWSP = '\u200B';

const HTML_ELEMENTS =
  'a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|frame|frameset|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|marquee|math|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr';
const HTML_TAG = new RegExp(`</?(?:${HTML_ELEMENTS})(?:\\s[^<>]*)?/?>`, 'gi');
const HTML_OTHER = /<!--[\s\S]*?(?:-->|$)|<![A-Za-z[][^<>]*>|<\?[^<>]*>/g;

/** Remove HTML tags, comments and declarations. Anything left that looks like markup is escaped later. */
function stripHtml(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(HTML_OTHER, '').replace(HTML_TAG, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

function escapeMarkdown(text: string): string {
  return (
    text
      // Escape the escape character first, then everything that can start a link, image,
      // emphasis, code, table, heading or entity.
      .replace(/\\/g, '\\\\')
      .replace(/[`*_~[\]()!|#&]/g, '\\$&')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Rendered text is scanned for mentions, issue references and bare links, so break them.
      .replace(/@/g, `@${ZWSP}`)
      .replace(/#(?=\d)/g, `#${ZWSP}`)
      .replace(/\bGH-(?=\d)/gi, `GH-${ZWSP}`)
      .replace(/\b(https?|ftp):\/\//gi, `$1:${ZWSP}//`)
      .replace(/\bwww\./gi, `www${ZWSP}.`)
      // A line that starts like a list item would open a nested list.
      .replace(/^([-+])(?=\s|$)/, '\\$1')
      .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
  );
}

/**
 * Turn untrusted text into one line of inert Markdown: no HTML, no mentions, no live links,
 * at most `max` characters before escaping.
 */
export function neutralizeMarkdown(value: unknown, max: number): string {
  const single = cleanText(value, max * 3);
  return escapeMarkdown(cleanText(stripHtml(maskEmails(single)), max));
}

const URL_ESCAPES: Record<string, string> = {
  '(': '%28',
  ')': '%29',
  '[': '%5B',
  ']': '%5D',
  '<': '%3C',
  '>': '%3E',
  '`': '%60',
  '\\': '%5C',
  ' ': '%20',
};

/** A validated URL made safe for the destination part of a Markdown link. */
function markdownUrl(url: string): string {
  return url.replace(/[()[\]<>`\\ ]/g, (ch) => URL_ESCAPES[ch] ?? ch);
}

/**
 * A file label as an inline code span. Code spans render literally and ping nobody, so only
 * markup (which could carry the comment marker) and backticks are removed.
 */
function evidenceLink(ref: EvidenceLink | null): string {
  if (!ref || typeof ref !== 'object') return '';
  const label = cleanText(stripHtml(maskEmails(cleanText(ref.label, 300))), 100).replace(/`/g, "'");
  if (!label) return '';
  const url = safeHttpUrl(ref.url);
  return url ? `[\`${label}\`](${markdownUrl(url)})` : `\`${label}\``;
}

/** "Watch the 2-minute MergeStory", or "Watch the 75-second MergeStory" under 90 seconds. */
function watchLabel(durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 'Watch the MergeStory';
  if (durationSec < 90) return `Watch the ${Math.max(1, Math.round(durationSec))}-second MergeStory`;
  return `Watch the ${Math.round(durationSec / 60)}-minute MergeStory`;
}

function requireWatchUrl(value: string): string {
  const url = safeHttpUrl(value);
  if (!url) {
    throw new MergeStoryError(
      'NOTIFY_FAILED',
      'The video link is not an http(s) URL, so it cannot be shared in a pull request.',
      {
        hint: 'Publish with the s3 provider to get a link that others can open.',
      },
    );
  }
  return markdownUrl(url);
}

function watchLine(data: CommentData): string {
  return `**Not sure what changed? [${watchLabel(data.durationSec)}](${requireWatchUrl(data.watchUrl)})**`;
}

/**
 * The small print under the link. A private link says when it expires. A protected link says that
 * it needs a team sign-in, so nobody is surprised by a login page. A private YouTube video says that
 * only its owner can watch it.
 */
function footerText(data: CommentData): string {
  const sha = shortSha(data.headSha);
  const expires = formatDateTime(data.linkExpiresAt);
  const parts = [
    sha ? `Commit \`${sha}\`.` : '',
    'The video explains the change; it does not replace code review.',
    expires ? `The link expires on ${expires}.` : '',
    data.visibility === 'protected' ? 'The link needs a team sign-in.' : '',
    data.provider === 'youtube' && data.visibility === 'private'
      ? 'Only the channel owner can watch this video.'
      : '',
  ];
  return parts.filter(Boolean).join(' ');
}

function checklistLines(checklist: CommentData['checklist']): string[] {
  return (Array.isArray(checklist) ? checklist : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, order) => ({ item, order }))
    .sort((a, b) => severityRank(a.item.severity) - severityRank(b.item.severity) || a.order - b.order)
    .slice(0, MAX_CHECKLIST_ITEMS)
    .map(({ item }) => {
      const severity = SEVERITY_LABEL[severityOf(item.severity)];
      const rawTitle = cleanText(item.title, 120) || 'Review item';
      const title = neutralizeMarkdown(rawTitle, 120);
      const detail = neutralizeMarkdown(item.detail, 140);
      const joiner = /[.!?:]$/.test(rawTitle) ? ' ' : '. ';
      const ref = evidenceLink(item.ref);
      return `- **${severity}:** ${title}${detail ? `${joiner}${detail}` : ''}${ref ? ` (${ref})` : ''}`;
    });
}

function chapterMarkdownLines(chapters: CommentData['chapters']): string[] {
  const items = (Array.isArray(chapters) ? chapters : [])
    .filter((c) => c && typeof c.startSec === 'number' && Number.isFinite(c.startSec))
    .sort((a, b) => a.startSec - b.startSec);
  const lines = items
    .slice(0, MAX_CHAPTERS)
    .map(
      (c, i) =>
        `- \`${formatTimestamp(c.startSec)}\` ${neutralizeMarkdown(c.title, 80) || `Chapter ${i + 1}`}`,
    );
  if (items.length > MAX_CHAPTERS) lines.push(`- and ${items.length - MAX_CHAPTERS} more in the video`);
  return lines;
}

/** Markdown for the PR comment. Starts with COMMENT_MARKER. Untrusted text is neutralised (no @mentions, no HTML). */
export function buildPrComment(data: CommentData): string {
  const title = neutralizeMarkdown(data.title, 100);
  const summary = neutralizeMarkdown(data.summary, 280);
  const lines: string[] = [
    COMMENT_MARKER,
    title ? `### MergeStory: ${title}` : '### MergeStory',
    '',
    watchLine(data),
  ];

  // GitHub's image proxy cannot sign in, and signed links expire, so only links that anyone can
  // open (public, or unlisted on YouTube) get a preview image.
  const poster =
    data.visibility === 'public' || data.visibility === 'unlisted' ? safeHttpUrl(data.posterUrl) : null;
  if (poster)
    lines.push(
      '',
      `[![MergeStory video preview](${markdownUrl(poster)})](${requireWatchUrl(data.watchUrl)})`,
    );
  if (summary) lines.push('', summary);

  const chapters = chapterMarkdownLines(data.chapters);
  if (chapters.length > 0) lines.push('', '**Chapters**', '', ...chapters);
  const checklist = checklistLines(data.checklist);
  if (checklist.length > 0) lines.push('', '**What to review**', '', ...checklist);

  lines.push('', '---', `<sub>${footerText(data)}</sub>`);
  return lines.join('\n');
}

/** Short Markdown section for the PR description, wrapped in DESCRIPTION_START / DESCRIPTION_END. */
export function buildDescriptionSection(data: CommentData): string {
  const summary = neutralizeMarkdown(data.summary, 200);
  return [DESCRIPTION_START, watchLine(data), summary, `<sub>${footerText(data)}</sub>`, DESCRIPTION_END]
    .filter(Boolean)
    .join('\n');
}
