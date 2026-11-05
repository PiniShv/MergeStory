/** Writing back to a pull request: one comment, or one section of the description. */
import type { RunContext } from '../core/context.ts';
import { isMergeStoryError, MergeStoryError } from '../core/errors.ts';
import { GitHubClient } from './client.ts';
import type { PullRequestRef } from './pr-url.ts';

export interface CommentResult {
  url: string;
  created: boolean;
}

export const DESCRIPTION_START = '<!-- mergestory:start -->';
export const DESCRIPTION_END = '<!-- mergestory:end -->';

/** GitHub rejects comments and descriptions longer than this. */
const MAX_BODY_CHARS = 65_536;

function refuseInDryRun(ctx: RunContext, what: string): void {
  if (!ctx.dryRun) return;
  throw new MergeStoryError('NOTIFY_FAILED', `Not going to ${what}: this is a dry run.`, {
    hint: 'Run again without --dry-run to post to GitHub.',
  });
}

function assertFits(text: string, what: string): void {
  if (text.length <= MAX_BODY_CHARS) return;
  throw new MergeStoryError(
    'NOTIFY_FAILED',
    `The ${what} is ${text.length} characters; GitHub allows ${MAX_BODY_CHARS}.`,
    {
      hint: 'Shorten the text, or turn the GitHub write off and share the video link another way.',
    },
  );
}

/** Report every GitHub failure of the notify stage as NOTIFY_FAILED, keeping GitHub's hint. */
function asNotifyError(error: unknown): unknown {
  if (!isMergeStoryError(error) || error.code === 'ABORTED' || error.code === 'NOTIFY_FAILED') return error;
  return new MergeStoryError('NOTIFY_FAILED', `Could not write to GitHub. ${error.message}`, {
    hint: error.hint,
    details: { ...error.details, reason: error.code },
    cause: error,
  });
}

/** A write that GitHub refused because the comment is not ours to edit, or is gone. */
function isUneditable(error: unknown): boolean {
  if (!isMergeStoryError(error)) return false;
  const status = error.details?.status;
  return (
    (error.code === 'GITHUB_AUTH' || error.code === 'SOURCE_NOT_FOUND') && (status === 403 || status === 404)
  );
}

/** The bot account that GitHub Actions' GITHUB_TOKEN writes as (that token cannot read /user). */
function actionsBotLogin(): string | null {
  return process.env.GITHUB_ACTIONS === 'true' ? 'github-actions[bot]' : null;
}

/**
 * Create or update the single MergeStory comment on a pull request (found by its HTML marker).
 * The marker is added to the top of the text when it is missing, so the next run finds the
 * comment again. Refuses to run in a dry run.
 */
export async function upsertPullRequestComment(
  ref: PullRequestRef,
  body: string,
  marker: string,
  ctx: RunContext,
): Promise<CommentResult> {
  refuseInDryRun(ctx, 'post a comment');
  if (!marker.trim()) throw new MergeStoryError('NOTIFY_FAILED', 'The comment marker is empty.');
  const text = body.includes(marker) ? body : `${marker}\n${body}`;
  assertFits(text, 'comment');
  try {
    const client = await GitHubClient.create(ref, ctx, { stage: 'notify' });
    // Only a comment this same account wrote may be updated. When the account cannot be told,
    // a new comment is posted instead of guessing.
    const author = (await client.getAuthenticatedLogin()) ?? actionsBotLogin();
    const existing = author ? await client.findCommentByMarker(marker, author) : null;
    if (existing) {
      try {
        const updated = await client.updateComment(existing.id, text);
        return { url: updated.url || existing.url, created: false };
      } catch (error) {
        // Someone else's comment, or one that was deleted meanwhile: post a new one instead.
        if (!isUneditable(error)) throw error;
      }
    }
    const created = await client.createComment(text);
    return { url: created.url, created: true };
  } catch (error) {
    throw asNotifyError(error);
  }
}

/**
 * Put `section` between the MergeStory markers in a pull request description. An existing marked
 * section is replaced; otherwise the section is added at the end after a blank line. Everything
 * else is left as it was, including the description's line endings.
 */
export function replaceMarkedSection(description: string, section: string): string {
  const newline = description.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = section.trim();
  const content = trimmed.replace(/\r?\n/g, newline);
  const wrapped = trimmed.startsWith(DESCRIPTION_START) && trimmed.endsWith(DESCRIPTION_END);
  const block = wrapped ? content : `${DESCRIPTION_START}${newline}${content}${newline}${DESCRIPTION_END}`;

  // Pair the first end marker with the closest start marker before it, so a stray start marker
  // earlier in the text never swallows the text between the two.
  const end = description.indexOf(DESCRIPTION_END);
  const start = end < 0 ? -1 : description.lastIndexOf(DESCRIPTION_START, end);
  if (start >= 0 && start < end) {
    return description.slice(0, start) + block + description.slice(end + DESCRIPTION_END.length);
  }
  const base = description.trimEnd();
  return base ? `${base}${newline}${newline}${block}` : block;
}

/**
 * Replace the MergeStory section of the PR description (between <!-- mergestory:start --> and
 * <!-- mergestory:end -->), or append it. The rest of the description is left untouched, and
 * nothing is written when the section is already up to date. Refuses to run in a dry run.
 */
export async function updatePullRequestDescription(
  ref: PullRequestRef,
  section: string,
  ctx: RunContext,
): Promise<void> {
  refuseInDryRun(ctx, 'change the description');
  try {
    const client = await GitHubClient.create(ref, ctx, { stage: 'notify' });
    const pullRequest = await client.getPullRequest();
    const next = replaceMarkedSection(pullRequest.body, section);
    if (next === pullRequest.body) return;
    assertFits(next, 'description');
    await client.updatePullRequestBody(next);
  } catch (error) {
    throw asNotifyError(error);
  }
}
