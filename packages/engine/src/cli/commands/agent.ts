/**
 * mergestory agent: the commands a coding agent may run without asking. They read only the current
 * repository (through git), their work folder and MergeStory's own files. They write only in the
 * MergeStory home and the system's temporary folder. No argument can make them start a program of
 * its choosing, reach a host the user did not configure, upload, comment or spend money. The
 * general commands keep their flexible flags for people and CI.
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type Command, InvalidArgumentError, Option } from 'commander';
import { resolveFfmpeg } from '../../core/binaries.ts';
import type { Config, ConfigInput } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { assertNoLinks, ensureDir, homeLayout } from '../../core/paths.ts';
import { runCommand } from '../../core/process.ts';
import { globalRedactor } from '../../core/redact.ts';
import type { PlannedScene, RenderPlan } from '../../core/render-plan.ts';
import { runFolder } from '../../core/run-folder.ts';
import { isSameRepository } from '../../github/linked-issues.ts';
import { parsePullRequestUrl, webHostFromApiUrl } from '../../github/pr-url.ts';
import { sourceProblem } from '../../jobs/input-rules.ts';
import { GitRunner } from '../../sources/git.ts';
import { parseGitHubRemote } from '../../sources/remote.ts';
import {
  type ContextFlags,
  LOG_KIND,
  RECORDING_KIND,
  readCaptureFolder,
  SCREENSHOT_KIND,
} from '../inputs.ts';
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
  repro: 'repro.json',
  redact: 'redact.json',
  storyboard: 'storyboard.json',
  /** Written by `agent render`: the run folder of the latest render. */
  lastRun: 'last-run.json',
} as const;
/** The pictures that `agent frames` writes. */
const FRAMES_DIR = 'frames';
const CONTACT_SHEET = 'contact-sheet.jpg';
/** The folders of screenshots, of screen recordings and of logs. Each may hold a captions.json. */
const SCREENSHOTS_DIR = 'screenshots';
const RECORDINGS_DIR = 'recordings';
const LOGS_DIR = 'logs';

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
  const result = await git.run(['remote', '-v'], {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
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

/** The task, notes, test results, reproduction, regions to hide, screenshots, recordings and logs that the agent wrote into the work folder, as context flags. */
async function contextFiles(dir: string): Promise<ContextFlags> {
  const flags: ContextFlags = {};
  const path = (name: string): string | undefined =>
    existsSync(join(dir, name)) ? join(dir, name) : undefined;
  const task = path(WORK_FILE.task);
  const notes = path(WORK_FILE.notes);
  const tests = path(WORK_FILE.tests);
  const repro = path(WORK_FILE.repro);
  if (task) flags.taskFile = task;
  if (notes) flags.notesFile = notes;
  if (tests) flags.testsFile = tests;
  if (repro) {
    flags.reproFile = repro;
    flags.reproLabel = WORK_FILE.repro;
  }
  const redact = path(WORK_FILE.redact);
  if (redact) flags.redact = redact;
  const screenshots = await readCaptureFolder(join(dir, SCREENSHOTS_DIR), SCREENSHOT_KIND, {
    nameLabel: `${SCREENSHOTS_DIR}/`,
  });
  if (screenshots.length > 0) flags.screenshotFiles = screenshots;
  const recordings = await readCaptureFolder(join(dir, RECORDINGS_DIR), RECORDING_KIND);
  if (recordings.length > 0) flags.recordingFiles = recordings;
  const logs = (await readCaptureFolder(join(dir, LOGS_DIR), LOG_KIND)).map(({ path, caption }) => ({
    path,
    caption,
  }));
  if (logs.length > 0) flags.logFiles = logs;
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
  const context = await contextFiles(dir);
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

const SHEET_COLUMNS = 4;
const SHEET_MAX_FRAMES = 24;

/** A scene's frame time: the middle of its last beat, or of the scene when it has none. Always inside the video. */
function frameTime(scene: PlannedScene, durationSec: number): number {
  const beat = scene.beats.at(-1);
  const t = beat ? beat.startSec + beat.durationSec / 2 : scene.startSec + scene.durationSec / 2;
  return Math.round(Math.max(0, Math.min(t, durationSec - 0.1)) * 100) / 100;
}

/** Write frames/ in the work folder from the video of the latest `agent render`. */
async function takeFrames(dir: string, config: Config, signal: AbortSignal | undefined) {
  const pointer = join(dir, WORK_FILE.lastRun);
  let runDir: unknown;
  try {
    runDir = (JSON.parse(await readFile(pointer, 'utf8')) as { runDir?: unknown }).runDir;
  } catch {
    runDir = undefined;
  }
  const none = (why: string) =>
    new MergeStoryError('USAGE', why, { hint: 'Run `mergestory agent render --name <name>` first.' });
  if (typeof runDir !== 'string') throw none('This work folder has no rendered video yet.');
  // A pointer that leads out of the runs folder is not followed.
  const runs = homeLayout(config.home).runs;
  const rel = relative(runs, resolve(runDir));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw none('The latest render is not in the runs folder.');
  }
  const run = runFolder(runDir);
  if (!existsSync(run.video) || !existsSync(run.renderPlan)) throw none('The latest render has no video.');
  const plan = JSON.parse(await readFile(run.renderPlan, 'utf8')) as RenderPlan;
  const { ffmpeg } = await resolveFfmpeg(config);
  const out = join(dir, FRAMES_DIR);
  await rm(out, { recursive: true, force: true });
  await ensureDir(out);
  const grab = async (args: string[], file: string) => {
    try {
      await runCommand(ffmpeg, ['-v', 'error', '-y', ...args, file], { signal, timeoutMs: 120_000 });
    } catch (cause) {
      throw new MergeStoryError('RENDER_FAILED', 'FFmpeg could not take a frame from the video.', { cause });
    }
  };
  const step = Math.max(2, Math.ceil(plan.durationSec / SHEET_MAX_FRAMES));
  const count = Math.max(1, Math.ceil(plan.durationSec / step));
  const contactSheet = join(out, CONTACT_SHEET);
  await grab(
    [
      '-i',
      run.video,
      '-vf',
      `fps=1/${step},scale=480:-2,tile=${SHEET_COLUMNS}x${Math.ceil(count / SHEET_COLUMNS)}`,
      '-frames:v',
      '1',
    ],
    contactSheet,
  );
  const frames: { sceneId: string; title: string; timeSec: number; file: string }[] = [];
  for (const [i, scene] of plan.scenes.entries()) {
    const timeSec = frameTime(scene, plan.durationSec);
    const file = join(out, `scene-${String(i + 1).padStart(2, '0')}.jpg`);
    await grab(['-ss', String(timeSec), '-i', run.video, '-frames:v', '1', '-q:v', '2'], file);
    frames.push({ sceneId: scene.id, title: scene.title, timeSec, file });
  }
  return { framesDir: out, contactSheet, sheetStepSec: step, frames };
}

/** Add `agent analyze`, `agent validate`, `agent render` and `agent frames`. */
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
      followUp: {
        source: sourceArg ?? '.',
        args: ['--name', flags.name, ...refs],
        agent: true,
      },
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
    // The old pointer goes first, so that a failed render never leaves `agent frames` on the previous video.
    if (!flags.dryRun) await rm(join(dir, WORK_FILE.lastRun), { force: true });
    const result = await makeVideo(env, source, { ...flags, ...files }, localOnlyOverrides(flags));
    // Lets `agent frames` find this render.
    if (result && 'runDir' in result && !('dryRun' in result) && existsSync(dir)) {
      await writeFile(join(dir, WORK_FILE.lastRun), `${JSON.stringify({ runDir: result.runDir })}\n`, {
        mode: 0o600,
      });
    }
  });

  const frames = agent
    .command('frames')
    .description('Take still frames from the latest render of the work folder, to check the video by eye')
    .argument('[source]', SOURCE_ARGUMENT);
  addNameFlag(frames);
  frames.action(async (sourceArg: string | undefined, flags: AgentFlags, cmd: Command) => {
    const env = rt.env(cmd);
    const { dir, config } = await openWorkFolder(env, flags.name, false);
    await agentSource(sourceArg, env, config);
    const out = await takeFrames(dir, config, env.signal);
    if (env.json) {
      env.emitJson(globalRedactor.redactValue({ ok: true, name: flags.name, ...out }));
      return;
    }
    env.say(`Contact sheet: ${out.contactSheet}`);
    for (const f of out.frames) env.say(`${f.sceneId} "${f.title}" at ${f.timeSec}s: ${f.file}`);
    env.say('Next: look at these pictures, fix storyboard.json if a scene is wrong, and render again.');
  });
}
