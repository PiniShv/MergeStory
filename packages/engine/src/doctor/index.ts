/**
 * `mergestory doctor`: checks that this machine can make videos and says how to fix what it cannot.
 * Names of settings and environment variables are reported, never their values.
 *
 * The checks sit in one file for each part of the setup. Where a rule decides whether a run works
 * (a speech provider, a publisher), the report asks the same code that the run asks, and adds its own
 * sentences.
 */
import { join } from 'node:path';
import { noCache } from '../core/cache.ts';
import { type Config, loadSecrets } from '../core/config.ts';
import { createRunContext } from '../core/context.ts';
import { silentLogger } from '../core/logger.ts';
import { homeLayout } from '../core/paths.ts';
import { ENGINE_VERSION } from '../version.ts';
import { check } from './check.ts';
import { defaultDoctorDeps } from './deps.ts';
import { checkGithub } from './github.ts';
import { checkHome } from './home.ts';
import { checkLlm } from './llm.ts';
import { checkPublish } from './publish.ts';
import { checkSpeech } from './speech.ts';
import { checkBrowser, checkFfmpeg, checkGit, checkNode } from './tools.ts';
import type { CheckStatus, DoctorCheck, DoctorContext, DoctorDeps, DoctorReport } from './types.ts';

export { formatDoctor } from './format.ts';
export type { DoctorReport } from './types.ts';

/** Input of `runDoctor`. */
export interface RunDoctorOptions {
  config: Config;
  /** Set when the configuration could not be read; shown as a failed check. */
  configError?: { message: string; hint?: string | undefined } | null;
  /** Also contact the services you configured (storage, link protection). Without it no network call is made. */
  online?: boolean;
  deps?: Partial<DoctorDeps>;
}

/** A group of checks that throws becomes a failed check instead of stopping the report. */
async function guard(
  id: string,
  name: string,
  work: () => Promise<DoctorCheck | DoctorCheck[]> | DoctorCheck | DoctorCheck[],
): Promise<DoctorCheck[]> {
  try {
    return [await work()].flat();
  } catch (err) {
    return [
      check(id, name, 'fail', `the check itself failed: ${err instanceof Error ? err.message : String(err)}`),
    ];
  }
}

/** Run every check. The groups run side by side, and their results are listed in a fixed order. */
export async function runDoctor(options: RunDoctorOptions): Promise<DoctorReport> {
  const env = options.deps?.env ?? process.env;
  const deps: DoctorDeps = { ...defaultDoctorDeps(env), ...options.deps };
  const { config } = options;
  const online = options.online === true;
  const secrets = loadSecrets(deps.env);
  const c: DoctorContext = {
    config,
    secrets,
    ctx: createRunContext({
      config,
      runId: 'doctor',
      runDir: join(homeLayout(config.home).runs, 'doctor'),
      logger: silentLogger,
      secrets,
      cache: noCache,
    }),
    deps,
    online,
  };

  const groups = await Promise.all([
    guard('node', 'Node.js', () => checkNode(c)),
    guard('git', 'git', () => checkGit(c)),
    guard('ffmpeg', 'ffmpeg and ffprobe', () => checkFfmpeg(c)),
    guard('browser', 'Browser for rendering', () => checkBrowser(c)),
    guard('speech', 'Speech', () => checkSpeech(c)),
    guard('llm', 'Storyboard writer (LLM)', () => checkLlm(c)),
    guard('github', 'GitHub access', () => checkGithub(c)),
    guard('publish', 'Publishing', () => checkPublish(c)),
    guard('home', 'MergeStory home', () => checkHome(c)),
  ]);
  const checks: DoctorCheck[] = [
    ...(options.configError
      ? [
          check(
            'config',
            'Configuration',
            'fail',
            options.configError.message,
            options.configError.hint ?? null,
          ),
        ]
      : []),
    ...groups.flat(),
  ];

  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const item of checks) summary[item.status] += 1;
  return { ok: summary.fail === 0, online, version: ENGINE_VERSION, summary, checks };
}
