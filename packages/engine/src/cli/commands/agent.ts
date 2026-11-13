/**
 * mergestory agent: the commands a coding agent may run without asking. They read only the current
 * repository (through git), their work folder and MergeStory's own files. They write only in the
 * MergeStory home and the system's temporary folder. No argument can make them start a program of
 * its choosing, reach a host the user did not configure, upload, comment or spend money. The
 * general commands keep their flexible flags for people and CI.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Command, InvalidArgumentError, Option } from 'commander';
import type { Config, ConfigInput } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { assertNoLinks, ensureDir, homeLayout } from '../../core/paths.ts';
import { globalRedactor } from '../../core/redact.ts';
import { isSameRepository } from '../../github/linked-issues.ts';
import { parsePullRequestUrl, webHostFromApiUrl } from '../../github/pr-url.ts';
import { sourceProblem } from '../../jobs/input-rules.ts';
import { GitRunner } from '../../sources/git.ts';
import { parseGitHubRemote } from '../../sources/remote.ts';
import type { ContextFlags } from '../inputs.ts';
import {
  addSourceFlags,
  addStyleFlags,
  buildCommonOptions,
  type ConfigFlags,
  durationOption,
  maxDurationOption,
  readStoryboard,
  type SourceFlags,
} from '../options.ts';
import type { CliRuntime, CommandEnv } from '../runtime.ts';
import { checkAndReport } from './authoring.ts';
import { makeVideo } from './generate.ts';
import { loadConfig } from './shared.ts';

/** The voices that run on this machine. */
const LOCAL_VOICES = ['auto', 'kokoro', 'say', 'none'] as const;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The files of a work folder, found by name. */
const WORK_FILE = {
  task: 'task.md',
  notes: 'notes.md',
  tests: 'tests.json',
  storyboard: 'storyboard.json',
} as const;

type AgentFlags = SourceFlags &
  Pick<
    ConfigFlags,
    | 'style'
    | 'quality'
    | 'maxDuration'
    | 'duration'
    | 'language'
    | 'theme'
    | 'tts'
    | 'voice'
    | 'cache'
    | 'captions'
  > & { name: string; dryRun?: boolean };

/**
 * Security boundary: these settings win over the flags, the environment and the config file, so
 * that agent render never calls a model or a paid voice, never uploads or comments, and writes only
 * to the run folder. `budgetUsd` is irrelevant because nothing paid runs. Do not loosen them without
 * changing what SECURITY.md says about the agent commands.
 */
export function localOnlyOverrides(flags: Pick<ConfigFlags, 'tts'>): ConfigInput {
  const tts = (LOCAL_VOICES as readonly string[]).includes(flags.tts ?? '') ? flags.tts : 'auto';
  return {
    llm: { provider: 'none' },
    tts: { provider: tts },
    publish: { provider: 'local', localDir: null },
    github: { comment: false, updateDescription: false },
    render: { musicPath: null },
    outDir: null,
  };
}

function nameFlag(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new InvalidArgumentError(
      'Use 1-64 characters: a-z, 0-9, ".", "_" and "-", starting with a letter or digit.',
    );
  }
  return value;
}

/**
 * `$MERGESTORY_HOME/work/<name>`, after checking that no link leads out of it. Only `agent analyze`
 * creates it (mode 0700), so a mistyped name in the other commands leaves nothing behind.
 */
async function openWorkFolder(
  env: CommandEnv,
  name: string,
  create: boolean,
): Promise<{ dir: string; config: Config }> {
  const config = await loadConfig(env);
  const { work } = homeLayout(config.home);
  const dir = join(work, name);
  await assertNoLinks(work, false);
  await assertNoLinks(dir);
  if (create) {
    await ensureDir(work);
    await ensureDir(dir);
  }
  return { dir, config };
}

function notThisRepository(): MergeStoryError {
  return new MergeStoryError(
    'USAGE',
    'The agent commands only explain the repository of the current folder.',
    {
      hint: 'For another repository or another folder, run `mergestory analyze`, which asks for approval.',
    },
  );
}

/** The GitHub repositories that the remotes of the current repository point at. */
async function remotesOf(env: CommandEnv, config: Config, hosts: ReadonlySet<string>) {
  const git = new GitRunner(env.io.cwd, {
    signal: env.signal,
    redactor: globalRedactor,
    home: homeLayout(config.home),
  });
  const result = await git.run(['remote', '-v'], { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });
  if (result.code !== 0) return [];
  // "origin<TAB>https://github.com/o/r.git (fetch)": the URL may hold a token, so only owner and name are kept.
  return result.stdout
    .split('\n')
    .map((line) => parseGitHubRemote(line.split(/\s+/)[1] ?? '', hosts))
    .filter((remote) => remote !== null);
}

/**
 * The repository of the current folder, or a pull request of one of its remotes. Anything else could
 * make the command read another repository or contact a host that the arguments choose.
 */
async function agentSource(source: string | undefined, env: CommandEnv, config: Config): Promise<string> {
  if (source === undefined || source === '.') return env.io.cwd;
  if (sourceProblem(source) !== null) throw notThisRepository();
  let ref: ReturnType<typeof parsePullRequestUrl>;
  try {
    ref = parsePullRequestUrl(source, config.github.apiUrl);
  } catch {
    throw notThisRepository();
  }
  const hosts = new Set(['github.com']);
  const configured = webHostFromApiUrl(config.github.apiUrl);
  if (configured) hosts.add(configured);
  if (!hosts.has(ref.webHost)) throw notThisRepository();
  const remotes = await remotesOf(env, config, hosts);
  const known = remotes.some(
    (remote) =>
      remote.host === ref.webHost &&
      isSameRepository({ owner: remote.owner, repo: remote.name, number: 0 }, ref),
  );
  if (!known) throw notThisRepository();
  return source;
}

/** The task, notes and test results that the agent wrote into the work folder, as the matching flags. */
function contextFiles(dir: string): ContextFlags {
  const flags: ContextFlags = {};
  const path = (name: string): string | undefined =>
    existsSync(join(dir, name)) ? join(dir, name) : undefined;
  const task = path(WORK_FILE.task);
  const notes = path(WORK_FILE.notes);
  const tests = path(WORK_FILE.tests);
  if (task) flags.taskFile = task;
  if (notes) flags.notesFile = notes;
  if (tests) flags.testsFile = tests;
  return flags;
}

/** Work folder, source and the options every agent command shares. */
async function prepareAgent(
  env: CommandEnv,
  sourceArg: string | undefined,
  flags: AgentFlags,
  create = false,
) {
  const { dir, config } = await openWorkFolder(env, flags.name, create);
  const source = await agentSource(sourceArg, env, config);
  const context = contextFiles(dir);
  return { dir, source, context };
}

function addNameFlag(command: Command): Command {
  return command
    .optionsGroup('Work folder:')
    .addOption(
      new Option(
        '--name <name>',
        'name of the work folder under ~/.mergestory/work (a-z, 0-9, ".", "_", "-")',
      )
        .argParser(nameFlag)
        .makeOptionMandatory(),
    );
}

const SOURCE_ARGUMENT =
  'omit or ".": the repository of the current folder; or a pull request of one of its remotes';

/** Add `agent analyze`, `agent validate` and `agent render`. */
export function registerAgent(program: Command, rt: CliRuntime): void {
  const agent = program
    .command('agent')
    .description(
      'Commands for coding agents: they work in ~/.mergestory/work/<name>, stay on this machine and spend nothing',
    );

  const analyze = agent
    .command('analyze')
    .description('Analyse the change and write the authoring files into the work folder')
    .argument('[source]', SOURCE_ARGUMENT);
  addNameFlag(analyze);
  addSourceFlags(analyze);
  analyze.action(async (sourceArg: string | undefined, flags: AgentFlags, cmd: Command) => {
    const env = rt.env(cmd);
    const { dir, source, context } = await prepareAgent(env, sourceArg, flags, true);
    const common = await buildCommonOptions(
      source,
      { ...flags, ...context },
      { cwd: env.io.cwd, logger: env.logger },
    );
    const refs = [
      ...(flags.base ? ['--base', flags.base] : []),
      ...(flags.head ? ['--head', flags.head] : []),
    ];
    const { prepareAuthoring } = await import('../../pipeline/index.ts');
    const result = await prepareAuthoring({
      ...common,
      outDir: dir,
      followUp: { source: sourceArg ?? '.', args: ['--name', flags.name, ...refs], agent: true },
      signal: env.signal,
      logger: env.logger,
    });
    if (env.json) {
      env.emitJson(
        globalRedactor.redactValue({
          ok: true,
          name: flags.name,
          workDir: dir,
          files: result.files,
          summary: result.summary,
        }),
      );
      return;
    }
    env.say(`Analysis ready: ${globalRedactor.redact(result.summary.title)}`);
    env.say(`Work folder: ${dir}`);
    env.say('Next: read AUTHORING.md there. It shows the commands that check and render the storyboard.');
  });

  const validate = agent
    .command('validate')
    .description('Check storyboard.json in the work folder without rendering anything')
    .argument('[source]', SOURCE_ARGUMENT);
  addNameFlag(validate);
  addSourceFlags(validate);
  validate
    .optionsGroup('Limits:')
    .addOption(maxDurationOption(true))
    .addOption(durationOption())
    .option('--language <code>', 'narration language, for example en');
  validate.action(async (sourceArg: string | undefined, flags: AgentFlags, cmd: Command) => {
    const env = rt.env(cmd);
    const { dir, source, context } = await prepareAgent(env, sourceArg, flags);
    const storyboardPath = join(dir, WORK_FILE.storyboard);
    if (!existsSync(storyboardPath)) {
      throw new MergeStoryError('USAGE', `There is no ${WORK_FILE.storyboard} in the work folder ${dir}.`, {
        hint: 'Write it first. AUTHORING.md in the work folder explains how.',
      });
    }
    const common = await buildCommonOptions(
      source,
      { ...flags, ...context },
      { cwd: env.io.cwd, logger: env.logger },
    );
    const storyboard = await readStoryboard(storyboardPath, env.io.cwd, 'storyboard file');
    await checkAndReport(env, common, storyboard);
  });

  const render = agent
    .command('render')
    .description('Make the video on this machine. Never calls a model or a paid voice, and never uploads')
    .argument('[source]', SOURCE_ARGUMENT);
  addNameFlag(render);
  addSourceFlags(render);
  addStyleFlags(render);
  render
    .optionsGroup('Voice:')
    .addOption(
      new Option('--tts <provider>', 'speech on this machine; auto picks a local voice').choices(
        LOCAL_VOICES,
      ),
    )
    .option('--voice <name>', 'voice name for the speech provider')
    .optionsGroup('Run:')
    .option('--dry-run', 'show the plan; renders nothing')
    .option('--no-cache', 'do not use or fill the cache')
    .option('--no-captions', 'leave captions out of the video');
  render.action(async (sourceArg: string | undefined, flags: AgentFlags, cmd: Command) => {
    const env = rt.env(cmd);
    const { dir, source, context } = await prepareAgent(env, sourceArg, flags);
    const storyboard = join(dir, WORK_FILE.storyboard);
    // Without storyboard.json the free offline storyboard is used.
    const files = existsSync(storyboard) ? { ...context, storyboard } : context;
    await makeVideo(env, source, { ...flags, ...files }, localOnlyOverrides(flags));
  });
}
