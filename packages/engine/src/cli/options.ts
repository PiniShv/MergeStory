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
  THEME_NAME,
  TTS_PROVIDERS,
  VISIBILITIES,
} from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import { isLoopbackAddress } from '../core/net.ts';
import { isInside } from '../core/posix.ts';
import type { SourceInput } from '../core/providers.ts';
import { maskPrivate, maskSecrets } from '../core/secrets.ts';
import { refProblem, sourceProblem } from '../jobs/input-rules.ts';
import type { JobOptions } from '../jobs/model.ts';
import { maskContext } from '../jobs/view.ts';
import { sourceInputsOf } from '../sources/spec.ts';
import { LIMITS, readJsonFile } from './files.ts';
import { buildContext, type ContextFlags, parseLogSpec, parseScreenshotSpec } from './inputs.ts';

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

const {
  maxDurationSec: MAX_DURATION,
  targetDurationSec: TARGET_DURATION,
  renderSec: RENDER_SEC,
} = DURATION_LIMITS;

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
  ).argParser(
    numberFlag({
      integer: true,
      min: TARGET_DURATION.min,
      max: TARGET_DURATION.max,
    }),
  );
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

/** `--source`, which generate, analyze and validate take (the agent commands do not). */
export interface SeveralSourcesFlag {
  source?: string[];
}

/** Flags that map to settings, as commander delivers them. */
export interface ConfigFlags {
  style?: Config['style'];
  quality?: Config['quality'];
  maxDuration?: number;
  duration?: number;
  language?: string;
  /** A theme name, or (generate only) the path of a theme folder. */
  theme?: string;
  /** --allow-low-contrast (generate only). */
  allowLowContrast?: boolean;
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
  maxRenderSeconds?: number;
}

/** Every flag of `generate`. */
export interface GenerateFlags extends SourceFlags, SeveralSourcesFlag, ContextFlags, ConfigFlags {
  storyboard?: string;
  dryRun?: boolean;
  async?: boolean;
}

/** Every flag of `publish`. */
export type PublishFlags = Pick<ConfigFlags, 'publish' | 'visibility' | 'comment' | 'updateDescription'>;

/** Add --base and --head, and with `several` also --source. */
export function addSourceFlags(command: Command, several = false): Command {
  command
    .optionsGroup('Source:')
    .option('--base <ref>', 'local repository: base ref (default: merge base with the default branch)')
    .option('--head <ref>', 'local repository: head ref (default: HEAD)');
  if (several) {
    command.option(
      '--source <repo>[:<base>..<head>]',
      'one video for a change in several repositories: a local repository (with an optional range) or a pull request; repeat it, up to 4 times. Not together with a source argument, --base or --head',
      collect,
    );
  }
  return command;
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
      'JSON array of test results: {command, passed, summary, source?: agent|ci|user, log?: L1.120-140} (max 256 KB). They are shown as reported, never run',
    )
    .option(
      '--repro-file <file>',
      'the steps that show the bug, JSON (at most 64 KB): {"title", "environment"?, "steps": [{"text", "screenshot"?, "recording"?, "result"?}]}',
    )
    .option(
      '--screenshot <spec>',
      'a real screenshot, PNG or JPEG up to 4 MB: <path>[:<caption>[:before|after]] (repeatable; the limit is the setting inputs.maxScreenshots)',
      collect,
    )
    .option(
      '--screenshots-dir <folder>',
      'a folder of real screenshots (.png, .jpg, .jpeg), used in name order after any --screenshot; an optional captions.json names a caption and side for each (give it once)',
      (value: string, previous: string | undefined) => {
        if (previous !== undefined) throw new InvalidArgumentError('Give --screenshots-dir once.');
        return value;
      },
    )
    .option(
      '--recording <spec>',
      'a real screen recording, MP4 (H.264) or WebM (VP8 or VP9), checked with ffprobe: <path>[:<caption>[:before|after]] (repeatable)',
      collect,
    )
    .option(
      '--redact <file>',
      'JSON file (max 64 KB) of regions to cover with a solid block in screenshots and recordings: {"SS1": [{"x", "y", "w", "h"}], "RC1": [{"x", "y", "w", "h"}]}, fractions of the picture, hidden for the whole clip in a recording (given once)',
      (value: string, previous: string | undefined) => {
        // A second file would replace the first in silence, and show what the first one hid.
        if (previous !== undefined)
          throw new InvalidArgumentError('Give --redact once, with one file of all regions.');
        return value;
      },
    )
    .option(
      '--log <spec>',
      'a real log, UTF-8 text up to 256 KB, at most 4: <file>[:<caption>]. Cite lines as L1.120-140 (repeatable)',
      collect,
    );
}

/**
 * `--theme`. With `paths` (generate, theme preview) it also takes the path of a theme folder on this
 * machine; without (agent commands) only a name, so an agent can never point it at a folder.
 */
export function themeOption(paths: boolean): Option {
  const names =
    'midnight (default), paper, high-contrast, terminal, or a theme of yours in ~/.mergestory/themes';
  return new Option(
    '--theme <theme>',
    paths ? `video theme: ${names}, or the path of a theme folder` : `video theme: ${names}`,
  ).argParser((value: string) => {
    if (!paths && !THEME_NAME.test(value)) {
      throw new InvalidArgumentError('Give the name of a theme. A path is not accepted here.');
    }
    return value;
  });
}

/** Add the flags for style, quality and length. `userThemes` also takes theme paths and --allow-low-contrast. */
export function addStyleFlags(command: Command, userThemes = false): Command {
  command
    .optionsGroup('Style and length:')
    .addOption(new Option('--style <style>', 'how technical the narration is').choices(STYLES))
    .addOption(new Option('--quality <preset>', 'video quality').choices(QUALITIES))
    .addOption(maxDurationOption())
    .addOption(durationOption())
    .option('--language <code>', 'narration language, for example en')
    .addOption(themeOption(userThemes));
  if (userThemes) {
    command.option('--allow-low-contrast', 'use a theme that fails the contrast check, with a warning');
  }
  return command;
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
    .optionsGroup('Providers (the defaults call no paid service and keep everything on this machine):')
    .addOption(
      new Option(
        '--llm <provider>',
        'who writes the storyboard; none = offline storyboard, no model call',
      ).choices(LLM_PROVIDERS),
    )
    .option('--model <name>', "LLM model (default: the provider's cheap default)")
    .option('--llm-base-url <url>', 'base URL of an OpenAI-compatible server, such as a local one')
    .addOption(new Option('--tts <provider>', 'speech; auto picks a local voice').choices(TTS_PROVIDERS))
    .option('--voice <name>', 'voice name for the speech provider')
    .addOption(publishOption(PUBLISH_PROVIDERS))
    .addOption(visibilityOption())
    .option('--comment', 'post or update one comment with the video link on the pull request')
    .option('--update-description', 'add or update a section in the pull request description')
    .option(
      '--budget <usd>',
      'the most this run may spend on paid model and voice calls, in USD (checked against estimates)',
      numberFlag({ min: 0 }),
    );
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
    .option('--music <file>', 'background music file, mixed quietly under the narration')
    .option(
      '--max-render-seconds <sec>',
      `stop when rendering takes longer than this many seconds (${RENDER_SEC.min}-${RENDER_SEC.max}); the run then ends with exit code 8 and leaves no video`,
      numberFlag({ integer: true, min: RENDER_SEC.min, max: RENDER_SEC.max }),
    );
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
  // A theme path is made absolute here, so later steps never look for it in another folder.
  if (flags.theme) config.theme = THEME_NAME.test(flags.theme) ? flags.theme : resolve(cwd, flags.theme);
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
  const render: NonNullable<ConfigInput['render']> = {};
  if (flags.music) render.musicPath = await checkMusicFile(flags.music, cwd);
  if (flags.maxRenderSeconds !== undefined) render.maxSeconds = flags.maxRenderSeconds;
  if (Object.keys(render).length > 0) config.render = render;
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
  flags: SourceFlags & SeveralSourcesFlag & ContextFlags & ConfigFlags,
  env: BuildEnv,
): Promise<CommonOptions> {
  const options: CommonOptions = { source: '.' };
  const specs = flags.source ?? [];
  if (specs.length > 0) {
    if (sourceArg !== undefined || flags.base !== undefined || flags.head !== undefined) {
      throw new MergeStoryError(
        'USAGE',
        '--source cannot be used together with a source argument, --base or --head.',
        { hint: 'Give every source as --source <repo>[:<base>..<head>].' },
      );
    }
    const inputs = sourceInputsOf({ source: '.', sources: specs }, env.cwd);
    options.source = inputs[0] as SourceInput;
    if (inputs.length > 1) {
      if (flags.comment || flags.updateDescription) {
        throw new MergeStoryError(
          'USAGE',
          '--comment and --update-description cannot be used with several sources: nothing is posted to a pull request.',
          { hint: 'Remove the flag and post the link on each pull request yourself.' },
        );
      }
      options.sources = inputs;
    }
  } else {
    options.source = await normalizeSource(sourceArg ?? '.', env.cwd);
    const base = checkRef('--base', flags.base);
    const head = checkRef('--head', flags.head);
    if (base) options.base = base;
    if (head) options.head = head;
  }

  const rawContext = await buildContext(flags, env.cwd);
  if (rawContext) {
    const { context, masked } = maskContext(rawContext);
    if (masked > 0) {
      env.logger.warn(
        `Masked ${masked} secret-like value(s) in the task, notes, test results and reproduction you provided.`,
      );
    }
    options.context = context;
  }

  const config = await configFromFlags(flags, env.cwd);
  if (Object.keys(config).length > 0) options.config = config;

  // Run files must stay out of every repository being explained.
  const repos = (options.sources ?? [options.source]).flatMap((input) => {
    const path = typeof input === 'string' ? input : input.kind === 'local' ? input.repoPath : '';
    return isAbsolute(path) ? [path] : [];
  });
  if (config.outDir && repos.some((repo) => isInside(repo, config.outDir as string))) {
    throw new MergeStoryError('USAGE', '--out is inside the repository being explained.', {
      hint: 'MergeStory never writes into the repository. Choose a folder outside it.',
    });
  }
  return options;
}

/**
 * The source and flags of an `analyze` command line as raw words, for the commands that AUTHORING.md
 * shows. Files are made absolute, so the commands work from the run folder as well. The flags are
 * the ones that decide the evidence ids (refs, task, notes, tests, screenshots, recordings, logs).
 */
export function followUpFor(
  source: string,
  flags: SourceFlags & ContextFlags,
  cwd: string,
  /** The `--source` texts, when they were used: then the commands repeat them and take no source argument. */
  sources: string[] | null = null,
): { source: string; args: string[]; contextArgs: string[] } {
  const refs: string[] = sources ? sources.flatMap((spec) => ['--source', spec]) : [];
  if (flags.base) refs.push('--base', flags.base);
  if (flags.head) refs.push('--head', flags.head);
  const contextArgs: string[] = [];
  // The file becomes absolute. The caption is masked, secrets and e-mail addresses: the commands are written to AUTHORING.md.
  const withCaption = (path: string, spec: string): string =>
    `${resolve(cwd, path)}${maskPrivate(spec.slice(path.length), { maskEmails: true })}`;
  if (flags.task !== undefined) contextArgs.push('--task', flags.task);
  if (flags.taskFile !== undefined) contextArgs.push('--task-file', resolve(cwd, flags.taskFile));
  if (flags.notesFile !== undefined) contextArgs.push('--notes-file', resolve(cwd, flags.notesFile));
  if (flags.testsFile !== undefined) contextArgs.push('--tests-file', resolve(cwd, flags.testsFile));
  if (flags.reproFile !== undefined) contextArgs.push('--repro-file', resolve(cwd, flags.reproFile));
  for (const spec of flags.screenshot ?? []) {
    const { path } = parseScreenshotSpec(spec);
    contextArgs.push('--screenshot', withCaption(path, spec));
  }
  if (flags.screenshotsDir !== undefined) {
    contextArgs.push('--screenshots-dir', resolve(cwd, flags.screenshotsDir));
  }
  for (const spec of flags.recording ?? []) {
    const { path } = parseScreenshotSpec(spec);
    contextArgs.push('--recording', withCaption(path, spec));
  }
  for (const spec of flags.log ?? []) {
    const { path } = parseLogSpec(spec);
    contextArgs.push('--log', withCaption(path, spec));
  }
  if (flags.redact !== undefined) contextArgs.push('--redact', resolve(cwd, flags.redact));
  return { source: sources ? '' : source, args: [...refs, ...contextArgs], contextArgs };
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

/** A source input as the text of `--source`, with the folder of a local repository absolute. */
export function sourceSpecOf(input: string | SourceInput): string {
  if (typeof input === 'string') return input;
  if (input.kind === 'github') return input.url;
  return input.base || input.head
    ? `${input.repoPath}:${input.base ?? ''}..${input.head ?? ''}`
    : input.repoPath;
}

/** The `--source` texts of a run that was given `--source`, for the commands that follow it; null otherwise. */
export function sourceSpecsOf(
  common: Pick<CommonOptions, 'source' | 'sources'>,
  flags: SeveralSourcesFlag,
): string[] | null {
  return flags.source?.length ? (common.sources ?? [common.source]).map(sourceSpecOf) : null;
}
