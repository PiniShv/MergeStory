/**
 * Sources turn "a pull request URL" or "a local git repository" into a normalised ChangeSet
 * plus read-only access to file contents. Sources never modify the repository.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MergeStoryError } from '../core/errors.ts';
import type { SourceInput, SourceProvider } from '../core/providers.ts';
import { parsePullRequestUrl } from '../github/pr-url.ts';
import { GitHubSource } from './github.ts';
import { LocalGitSource } from './local.ts';

export { parsePatchHunks } from './diff-parser.ts';
export type { GitHubSourceOptions } from './github.ts';
export { GitHubSource } from './github.ts';
export type { SourceLimits } from './limits.ts';
export { DEFAULT_SOURCE_LIMITS } from './limits.ts';
export type { LocalGitSourceOptions } from './local.ts';
export { LocalGitSource } from './local.ts';
export { createGuardedReader } from './reader.ts';

/** Longer than any real path or URL; stops pathological input before it is matched. */
const MAX_ARGUMENT_LENGTH = 4096;

// The forms of a pull request reference: "https://host/o/r/pull/1", "host/o/r/pull/1" (a dot in
// the host name) and "o/r#1".
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const SHORTHAND = /^[^\s/#@:]+\/[^\s/#@:]+#\d+$/;
const SCHEMELESS_PR_URL = /^[^/\s@:]+\.[^/\s@:]+\/[^\s]*\/pull\/\d+/;

/**
 * Decide which source an argument refers to.
 * - "https://github.com/o/r/pull/1", "github.com/o/r/pull/1" or "o/r#1"  -> github
 * - a filesystem path (default ".")                                    -> local
 *
 * A name that exists on disk is always a path, even if it looks like "o/r#1". `base` and `head`
 * only apply to local repositories.
 */
export function detectSourceInput(
  arg: string | null | undefined,
  options: { base?: string | null; head?: string | null; cwd?: string } = {},
): SourceInput {
  const base = options.base?.trim() || null;
  const head = options.head?.trim() || null;
  const text = arg?.trim() ?? '';
  const cwd = options.cwd ?? process.cwd();
  if (text.length > MAX_ARGUMENT_LENGTH) {
    throw new MergeStoryError('SOURCE_INVALID', 'The source argument is too long.', {
      hint: 'Pass a path to a local repository or a pull request URL.',
    });
  }

  const looksRemote =
    text !== '' &&
    (SCHEME_URL.test(text) ||
      (!existsSync(resolve(cwd, text)) && (SHORTHAND.test(text) || SCHEMELESS_PR_URL.test(text))));
  if (looksRemote) {
    if (base || head) {
      throw new MergeStoryError('USAGE', '--base and --head only apply to a local repository.', {
        hint: 'Remove them, or pass the path of a local repository instead of a pull request.',
      });
    }
    // Check the reference now, so a bad URL fails here with a clear message.
    const ref = parsePullRequestUrl(text);
    if (SHORTHAND.test(text)) {
      return { kind: 'github', url: `https://${ref.webHost}/${ref.owner}/${ref.repo}/pull/${ref.number}` };
    }
    return { kind: 'github', url: SCHEME_URL.test(text) ? text : `https://${text}` };
  }
  return { kind: 'local', repoPath: resolve(cwd, text || '.'), base, head };
}

export function createSourceProvider(input: SourceInput): SourceProvider {
  return input.kind === 'github' ? new GitHubSource() : new LocalGitSource();
}
