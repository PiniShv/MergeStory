/** Flag definitions shared by the commands, and the mapping from flags to pipeline options. */
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { type Command, InvalidArgumentError, Option } from 'commander';
import {
  type Config,
  type ConfigInput,
  DURATION_LIMITS,
  LLM_PROVIDERS,
  PUBLISH_PROVIDERS,
  QUALITIES,
  STYLES,
  THEMES,
  TTS_PROVIDERS,
  VISIBILITIES,
} from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import { isLoopbackAddress } from '../core/net.ts';
import { isInside } from '../core/posix.ts';
import { maskSecrets } from '../core/secrets.ts';
import { refProblem, sourceProblem } from '../jobs/input-rules.ts';
import type { JobOptions } from '../jobs/model.ts';
import { maskContext } from '../jobs/view.ts';
import { LIMITS, readJsonFile } from './files.ts';
import { buildContext, type ContextFlags, parseScreenshotSpec } from './inputs.ts';

// ---------------------------------------------------------------------------
// Flag parsers
// ---------------------------------------------------------------------------

/** For repeatable flags. Without a default value commander passes undefined the first time. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/**
 * Number parser for flags. The config schema checks every range again; the ranges given here come
 * from the same constants, so a wrong value is refused at once, with the range in the message.
 */
export function numberFlag(
  options: { integer?: boolean; min?: number; max?: number } = {},
): (value: string) => number {
  return (value) => {
    const number = Number(value);
    if (value.trim() === '' || !Number.isFinite(number)) throw new InvalidArgumentError('Expected a number.');
    if (options.integer && !Number.isInteger(number))
      throw new InvalidArgumentError('Expected a whole number.');
    if (options.min !== undefined && number < options.min) {
      throw new InvalidArgumentError(`Must be at least ${options.min}.`);
    }
    if (options.max !== undefined && number > options.max) {
      throw new InvalidArgumentError(`Must be at most ${options.max}.`);
    }
    return number;
  };
}

const { maxDurationSec: MAX_DURATION, targetDurationSec: TARGET_DURATION } = DURATION_LIMITS;

/**
 * `--max-duration`. Says exactly what is kept: the estimate that the storyboard is trimmed to, not
 * the length of the finished video. `check` is for `validate`, which only warns.
 */
export function maxDurationOption(check = false): Option {
  const range = `${MAX_DURATION.min}-${MAX_DURATION.max}, default ${MAX_DURATION.default}`;
  return new Option(
    '--max-duration <sec>',
    check
      ? `longest video in seconds (${range}); warns when making the video would have to drop scenes to fit`
      : `longest video in seconds (${range}). Before narration, scenes and lines are dropped, least important first, until the estimated length fits. The mission and review scenes always stay, and the real voice may run a little over`,
  ).argParser(numberFlag({ integer: true, min: MAX_DURATION.min, max: MAX_DURATION.max }));
}

/** `--duration`, the target length. */
export function durationOption(): Option {
  return new Option(
    '--duration <sec>',
    `target length in seconds (${TARGET_DURATION.min}-${TARGET_DURATION.max}; default: adapts to the size of the change)`,
  ).argParser(numberFlag({ integer: true, min: TARGET_DURATION.min, max: TARGET_DURATION.max }));
}

/** Port number parser for flags. */
export function portFlag(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError('Expected a port number from 0 to 65535.');
  }
  return port;
}

// ---------------------------------------------------------------------------
// Flag groups
// ---------------------------------------------------------------------------

export interface SourceFlags {
  base?: string;
  head?: string;
}

/** Flags that map to settings, as commander delivers them. */
export interface ConfigFlags {
  style?: Config['style'];
  quality?: Config['quality'];
  maxDuration?: number;
  duration?: number;
  language?: string;
  theme?: Config['theme'];
  llm?: Config['llm']['provider'];
  model?: string;
  llmBaseUrl?: string;
  tts?: Config['tts']['provider'];
  voice?: string;
  publish?: Config['publish']['provider'];
  visibility?: Config['publish']['visibility'];
  comment?: boolean;
  updateDescription?: boolean;
  budget?: number;
  out?: string;
  /** false when --no-cache was given. */
  cache?: boolean;
  /** false when --no-captions was given. */
  captions?: boolean;
  music?: string;
}

/** Every flag of `generate`. */
export interface GenerateFlags extends SourceFlags, ContextFlags, ConfigFlags {
  storyboard?: string;
  dryRun?: boolean;
  async?: boolean;
}

/** Every flag of `publish`. */
export type PublishFlags = Pick<ConfigFlags, 'publish' | 'visibility' | 'comment' | 'updateDescription'>;

/** Add --base and --head. */
export function addSourceFlags(command: Command): Command {
  return command
    .optionsGroup('Source:')
    .option('--base <ref>', 'local repository: base ref (default: merge base with the default branch)')
    .option('--head <ref>', 'local repository: head ref (default: HEAD)');
}

/** Add the flags that supply task, notes, test results and screenshots. */
export function addContextFlags(command: Command): Command {
  return command
    .optionsGroup('Context (optional, makes the video more accurate):')
    .option('--task <text>', 'the original task, in a few sentences (max 64 KB)')
    .option('--task-file <file>', 'read the task from a file (max 64 KB)')
    .option('--notes-file <file>', 'implementation notes or design decisions (max 64 KB)')
    .option(
      '--tests-file <file>',
      'JSON array of test results: {command, passed, summary, source?: agent|ci|user} (max 256 KB). They are shown as reported, never run',
    )
    .option(
      '--screenshot <spec>',
      'a real screenshot, PNG or JPEG up to 4 MB: <path>[:<caption>[:before|after]] (repeatable)',
      collect,
    );
}

/** Add the flags for style, quality and length. */
export function addStyleFlags(command: Command): Command {
  return command
    .optionsGroup('Style and length:')
    .addOption(new Option('--style <style>', 'how technical the narration is').choices(STYLES))
    .addOption(new Option('--quality <preset>', 'video quality').choices(QUALITIES))
    .addOption(maxDurationOption())
    .addOption(durationOption())
    .option('--language <code>', 'narration language, for example en')
    .addOption(new Option('--theme <theme>', 'color theme').choices(THEMES));
}

/** What each publish target means, in a few words. */
const PUBLISH_TARGETS: Record<Config['publish']['provider'], string> = {
  local: 'a folder on this machine',
  s3: 'S3-compatible storage',
  youtube: 'your YouTube channel',
  drive: 'your Google Drive',
  none: 'nowhere',
};

/** `--publish`, with the choices that make sense for the command. */
function publishOption(choices: readonly Config['publish']['provider'][]): Option {
  const meaning = choices.map((choice) => `${choice} = ${PUBLISH_TARGETS[choice]}`).join(', ');
  return new Option('--publish <provider>', `where the finished video goes: ${meaning}`).choices(choices);
}

/** `--visibility`: who can open an S3 or Google Drive link. */
function visibilityOption(): Option {
  return new Option(
    '--visibility <visibility>',
    'S3 links: private = signed, expires in 7 days at most; protected = permanent, behind your sign-in proxy; public = permanent, open to anyone. ' +
      'Google Drive links: private = only you; protected = people in your Google Workspace organization; public = anyone with the link',
  ).choices(VISIBILITIES);
}

/** Add the flags that say where the video goes and who can open the link. */
export function addPublishFlags(command: Command): Command {
  return command
    .optionsGroup('Where the video goes:')
    .addOption(publishOption(PUBLISH_PROVIDERS.filter((provider) => provider !== 'none')))
    .addOption(visibilityOption())
    .option('--comment', 'post or update one comment with the video link on the pull request')
    .option('--update-description', 'add or update a section in the pull request description');
}

/** Add the flags for LLM, speech, publishing, GitHub and budget. */
export function addProviderFlags(command: Command): Command {
  return command
    .optionsGroup('Providers (the defaults are free and keep everything on this machine):')
    .addOption(
      new Option('--llm <provider>', 'who writes the storyboard; none = free offline storyboard').choices(
        LLM_PROVIDERS,
      ),
    )
    .option('--model <name>', "LLM model (default: the provider's cheap default)")
    .option('--llm-base-url <url>', 'base URL of an OpenAI-compatible server, such as a local one')
    .addOption(new Option('--tts <provider>', 'speech; auto picks a free local voice').choices(TTS_PROVIDERS))
    .option('--voice <name>', 'voice name for the speech provider')
    .addOption(publishOption(PUBLISH_PROVIDERS))
    .addOption(visibilityOption())
    .option('--comment', 'post or update one comment with the video link on the pull request')
    .option('--update-description', 'add or update a section in the pull request description')
    .option('--budget <usd>', 'cost cap for this run in USD', numberFlag({ min: 0 }));
}

/** Add the flags that control the run itself. */
export function addRunFlags(command: Command): Command {
  return command
    .optionsGroup('Run:')
    .option('--storyboard <file>', 'use a storyboard you wrote instead of generating one (max 1 MB)')
    .option(
      '--dry-run',
      'show the plan, estimated cost and what would be sent; sends, renders and publishes nothing',
    )
    .option('--async', 'run in the background and print a job id (see: mergestory status)')
    .option('--out <dir>', 'write the run files here instead of under the MergeStory home')
    .option('--no-cache', 'do not use or fill the cache')
    .option('--no-captions', 'leave captions out of the video')
    .option('--music <file>', 'background music file, mixed quietly under the narration');
}

// ---------------------------------------------------------------------------
// Mapping to pipeline options
// ---------------------------------------------------------------------------

export interface BuildEnv {
  cwd: string;
  logger: Logger;
}

/** A ref must never be read as an option by git. */
export function checkRef(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (refProblem(value) !== null) {
    throw new MergeStoryError(
      'USAGE',
      `${label} is not a valid git ref: ${JSON.stringify(value.slice(0, 60))}`,
      {
        hint: 'Use a branch, tag or commit, for example main or origin/main~3. It must not start with "-".',
      },
    );
  }
  return value;
}

/** Reject sources that could be read as options, then make existing local directories absolute. */
export async function normalizeSource(source: string, cwd: string): Promise<string> {
  if (sourceProblem(source) !== null) {
    throw new MergeStoryError('USAGE', `"${source.slice(0, 60)}" is not a valid source.`, {
      hint: 'Pass a pull request URL, owner/repo#123, or the path of a local repository.',
    });
  }
  const absolute = resolve(cwd, source);
  const info = await stat(absolute).catch(() => null);
  return info?.isDirectory() ? absolute : source;
}

function checkLlmBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MergeStoryError('USAGE', '--llm-base-url is not a valid URL.', {
      hint: 'Use a full URL such as http://localhost:11434/v1',
    });
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    maskSecrets(value).masked > 0
  ) {
    throw new MergeStoryError('USAGE', '--llm-base-url must be a plain http(s) URL without credentials.', {
      hint: 'Put the key in the MERGESTORY_LLM_API_KEY environment variable, never in the URL.',
    });
  }
  // A flag must not send the evidence pack off this machine: other hosts come from settings only.
  if (!isLoopbackAddress(url.hostname)) {
    throw new MergeStoryError(
      'USAGE',
      '--llm-base-url only takes an address on this machine, such as http://localhost:11434/v1.',
      {
        hint: 'For a server on another machine, set MERGESTORY_LLM_BASE_URL, or llm.baseUrl in the config file.',
      },
    );
  }
  return value;
}

async function checkMusicFile(path: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, path);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new MergeStoryError('USAGE', `--music: file not found: ${path}`);
  return absolute;
}

/** Flags that were given become config overrides. Flags that were not given leave the environment and config file in charge. */
export async function configFromFlags(flags: ConfigFlags, cwd: string): Promise<ConfigInput> {
  const config: ConfigInput = {};
  if (flags.style) config.style = flags.style;
  if (flags.quality) config.quality = flags.quality;
  if (flags.maxDuration !== undefined) config.maxDurationSec = flags.maxDuration;
  if (flags.duration !== undefined) config.targetDurationSec = flags.duration;
  if (flags.language) config.language = flags.language;
  if (flags.theme) config.theme = flags.theme;
  if (flags.budget !== undefined) config.budgetUsd = flags.budget;
  if (flags.captions === false) config.captions = false;
  if (flags.out) config.outDir = resolve(cwd, flags.out);

  const llm: NonNullable<ConfigInput['llm']> = {};
  if (flags.llm) llm.provider = flags.llm;
  if (flags.model) llm.model = flags.model;
  if (flags.llmBaseUrl) llm.baseUrl = checkLlmBaseUrl(flags.llmBaseUrl);
  if (Object.keys(llm).length > 0) config.llm = llm;

  const tts: NonNullable<ConfigInput['tts']> = {};
  if (flags.tts) tts.provider = flags.tts;
  if (flags.voice) tts.voice = flags.voice;
  if (Object.keys(tts).length > 0) config.tts = tts;

  const publish: NonNullable<ConfigInput['publish']> = {};
  if (flags.publish) publish.provider = flags.publish;
  if (flags.visibility) publish.visibility = flags.visibility;
  if (Object.keys(publish).length > 0) config.publish = publish;

  const github: NonNullable<ConfigInput['github']> = {};
  if (flags.comment) github.comment = true;
  if (flags.updateDescription) github.updateDescription = true;
  if (Object.keys(github).length > 0) config.github = github;

  if (flags.cache === false) config.cache = { enabled: false };
  if (flags.music) config.render = { musicPath: await checkMusicFile(flags.music, cwd) };
  return config;
}

/** Options shared by generate, analyze and validate. */
export type CommonOptions = Omit<JobOptions, 'storyboard' | 'dryRun' | 'runId'>;

/**
 * Build the options every command needs: source, refs, context and config overrides.
 * Files are read here, with size limits, and secret-like values in the context are masked.
 */
export async function buildCommonOptions(
  sourceArg: string | undefined,
  flags: SourceFlags & ContextFlags & ConfigFlags,
  env: BuildEnv,
): Promise<CommonOptions> {
  const source = await normalizeSource(sourceArg ?? '.', env.cwd);
  const options: CommonOptions = { source };
  const base = checkRef('--base', flags.base);
  const head = checkRef('--head', flags.head);
  if (base) options.base = base;
  if (head) options.head = head;

  const rawContext = await buildContext(flags, env.cwd);
  if (rawContext) {
    const { context, masked } = maskContext(rawContext);
    if (masked > 0) {
      env.logger.warn(
        `Masked ${masked} secret-like value(s) in the task, notes and test results you provided.`,
      );
    }
    options.context = context;
  }

  const config = await configFromFlags(flags, env.cwd);
  if (Object.keys(config).length > 0) options.config = config;

  // Run files must stay out of the repository being explained.
  if (config.outDir && isAbsolute(source) && isInside(source, config.outDir)) {
    throw new MergeStoryError('USAGE', '--out is inside the repository being explained.', {
      hint: 'MergeStory never writes into the repository. Choose a folder outside it.',
    });
  }
  return options;
}

/**
 * The source and flags of an `analyze` command line as raw words, for the commands that AUTHORING.md
 * shows. Files are made absolute, so the commands work from the run folder as well. The flags are
 * the ones that decide the evidence ids (refs, task, notes, tests, screenshots).
 */
export function followUpFor(
  source: string,
  flags: SourceFlags & ContextFlags,
  cwd: string,
): { source: string; args: string[]; contextArgs: string[] } {
  const refs: string[] = [];
  if (flags.base) refs.push('--base', flags.base);
  if (flags.head) refs.push('--head', flags.head);
  const contextArgs: string[] = [];
  if (flags.task !== undefined) contextArgs.push('--task', flags.task);
  if (flags.taskFile !== undefined) contextArgs.push('--task-file', resolve(cwd, flags.taskFile));
  if (flags.notesFile !== undefined) contextArgs.push('--notes-file', resolve(cwd, flags.notesFile));
  if (flags.testsFile !== undefined) contextArgs.push('--tests-file', resolve(cwd, flags.testsFile));
  for (const spec of flags.screenshot ?? []) {
    const { path } = parseScreenshotSpec(spec);
    contextArgs.push('--screenshot', `${resolve(cwd, path)}${spec.slice(path.length)}`);
  }
  return { source, args: [...refs, ...contextArgs], contextArgs };
}

/** Read a storyboard file. `label` names it in error messages ("--storyboard" or "storyboard file"). */
export async function readStoryboard(path: string, cwd: string, label: string): Promise<unknown> {
  const value = await readJsonFile(path, {
    label,
    maxBytes: LIMITS.storyboardBytes,
    cwd,
    invalidCode: 'STORYBOARD_INVALID',
  });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MergeStoryError('STORYBOARD_INVALID', `${label}: ${path} must contain a JSON object.`, {
      hint: 'Run: mergestory schema   to see the expected shape.',
    });
  }
  return value;
}
