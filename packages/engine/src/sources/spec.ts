/** The sources of a run: one, or several (`--source <repo>[:<base>..<head>]`, repeatable). */
import { MergeStoryError } from '../core/errors.ts';
import type { SourceInput } from '../core/providers.ts';
import { MAX_SOURCES, sameSourceError } from '../core/source-views.ts';
import { refProblem, sourceProblem } from '../jobs/input-rules.ts';
import { detectSourceInput } from './index.ts';

/** What a ref may be made of. A URL never matches a range, so it is never split. */
const RANGE = /^([A-Za-z0-9._/@^~+-]*)\.\.([A-Za-z0-9._/@^~+-]*)$/;

/** Split `<repo>[:<base>..<head>]`. The range is the text after the LAST colon, when it has the form `<base>..<head>`. A Windows drive letter is never that colon. */
export function splitSourceRange(spec: string): { repo: string; base: string | null; head: string | null } {
  const colon = spec.lastIndexOf(':');
  const drive = colon === 1 && /^[A-Za-z]:[\\/]/.test(spec);
  const match = colon < 0 || drive ? null : RANGE.exec(spec.slice(colon + 1));
  // A ref has no "..", so a second one means this is not a range.
  if (!match || spec.slice(colon + 1).split('..').length !== 2) return { repo: spec, base: null, head: null };
  return { repo: spec.slice(0, colon), base: match[1] || null, head: match[2] || null };
}

/** One `--source` text as a source input. A range goes with a local repository only. */
export function parseSourceSpec(spec: string, cwd: string): SourceInput {
  const { repo, base, head } = splitSourceRange(spec);
  if (sourceProblem(repo) !== null) {
    throw new MergeStoryError('USAGE', `"${spec.slice(0, 60)}" is not a valid source.`, {
      hint: 'Pass a pull request URL, owner/repo#123, or the path of a local repository, then optionally :<base>..<head>.',
    });
  }
  for (const [label, ref] of [
    ['base', base],
    ['head', head],
  ] as const) {
    if (ref !== null && refProblem(ref) !== null) {
      throw new MergeStoryError(
        'USAGE',
        `The ${label} ref in "${spec.slice(0, 60)}" is not a valid git ref.`,
        {
          hint: 'Use a branch, tag or commit, for example main..fix/x. It must not start with "-".',
        },
      );
    }
  }
  return detectSourceInput(repo, { base, head, cwd });
}

/** A source input as the text of `--source`, with the folder of a local repository absolute. */
export function sourceSpecOf(input: string | SourceInput): string {
  if (typeof input === 'string') return input;
  if (input.kind === 'github') return input.url;
  return input.base || input.head
    ? `${input.repoPath}:${input.base ?? ''}..${input.head ?? ''}`
    : input.repoPath;
}

interface SourceOptions {
  source: string | SourceInput;
  sources?: ReadonlyArray<string | SourceInput> | undefined;
  base?: string | null | undefined;
  head?: string | null | undefined;
}

/** Every source of a run, as inputs. With `sources` the positional `source`, `base` and `head` are not used. */
export function sourceInputsOf(options: SourceOptions, cwd: string): [SourceInput, ...SourceInput[]] {
  if (options.sources === undefined) {
    if (typeof options.source !== 'string') return [options.source];
    return [
      detectSourceInput(options.source, { base: options.base ?? null, head: options.head ?? null, cwd }),
    ];
  }
  if (options.base || options.head) {
    throw new MergeStoryError('USAGE', '--base and --head cannot be used together with --source.', {
      hint: 'Give the range inside each source: --source <repo>:<base>..<head>',
    });
  }
  const [first, ...rest] = options.sources;
  if (first === undefined) throw new MergeStoryError('USAGE', 'There is no source to explain.');
  if (options.sources.length > MAX_SOURCES) {
    throw new MergeStoryError('USAGE', `A video can join at most ${MAX_SOURCES} sources.`, {
      hint: `You gave ${options.sources.length}. Make one video for each group of ${MAX_SOURCES} or fewer.`,
    });
  }
  const toInput = (s: string | SourceInput): SourceInput =>
    typeof s === 'string' ? parseSourceSpec(s, cwd) : s;
  const inputs: [SourceInput, ...SourceInput[]] = [toInput(first), ...rest.map(toInput)];
  const keys = new Set(inputs.map((input) => JSON.stringify(input)));
  if (keys.size !== inputs.length) throw sameSourceError();
  return inputs;
}
