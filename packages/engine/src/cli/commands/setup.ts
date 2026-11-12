/** mergestory setup: optional extras that are not installed by default, and one-time sign-ins. */
import { join } from 'node:path';
import type { Command } from 'commander';
import { MergeStoryError } from '../../core/errors.ts';
import type { SignInOptions, SignInResult } from '../../publish/google/sign-in.ts';
import type { CliRuntime, CommandEnv } from '../runtime.ts';
import { loadConfig } from './shared.ts';

const TARGETS: { name: string; summary: string }[] = [
  {
    name: 'kokoro',
    summary:
      'free local speech (Kokoro, English): about 400 MB of files plus a speech model that downloads on first use. The first English video installs it by itself; this does it ahead of time',
  },
  {
    name: 'youtube',
    summary:
      'sign in to YouTube once so videos can be uploaded to your channel (needs a browser; nothing is installed)',
  },
  {
    name: 'drive',
    summary:
      'sign in to Google Drive once so videos can be uploaded to your Drive (needs a browser; nothing is installed)',
  },
];

/** Replaces the terminal, the browser launcher and the sign-in itself. Tests use it. */
export interface SetupDeps {
  terminal?: () => {
    interactive: boolean;
    askHidden: (question: string, signal: AbortSignal) => Promise<string>;
  };
  openBrowser?: (url: string) => Promise<boolean>;
  signIn?: (options: SignInOptions) => Promise<SignInResult>;
}

/** The sign-in for YouTube or Google Drive: the same flow, with the service's own permissions. */
async function setupGoogle(env: CommandEnv, deps: SetupDeps, target: 'youtube' | 'drive'): Promise<void> {
  const config = await loadConfig(env);
  const [{ homeLayout }, { globalRedactor }, { loadSecrets }, youtube, drive, prompt] = await Promise.all([
    import('../../core/paths.ts'),
    import('../../core/redact.ts'),
    import('../../core/config.ts'),
    import('../../publish/youtube/sign-in.ts'),
    import('../../publish/drive/provider.ts'),
    import('../../publish/google/prompt.ts'),
  ]);
  const terminal =
    deps.terminal?.() ??
    ({
      // Hidden input needs a real terminal. Questions go to stderr, so --json output stays clean.
      interactive: Boolean(process.stdin.isTTY),
      askHidden: (question: string, signal: AbortSignal) =>
        prompt.readHidden(question, process.stdin, { write: (text) => env.io.stderr(text) }, signal),
    } as const);
  const run = target === 'youtube' ? youtube.runYouTubeSignIn : drive.runDriveSignIn;
  const result = await (deps.signIn ?? run)({
    ctx: {
      config,
      secrets: loadSecrets(env.io.env),
      redactor: globalRedactor,
      home: homeLayout(config.home),
      signal: env.signal,
    },
    io: {
      // In --json mode stdout holds one JSON document, so the steps (and the sign-in address) go to stderr.
      say: env.json ? (text) => env.io.stderr(`${text}\n`) : env.say,
      askHidden: (question) => terminal.askHidden(question, env.signal),
      openBrowser: deps.openBrowser ?? ((url) => prompt.openInBrowser(url)),
      interactive: terminal.interactive,
      ci: Boolean(env.io.env.CI),
    },
  });
  // Never the tokens: only where the sign-in is saved and what it allows.
  if (env.json)
    env.emitJson({ ok: true, [target]: { credentialsFile: result.credentialsFile, scopes: result.scopes } });
}

/** Add the `setup` command. */
export function registerSetup(program: Command, rt: CliRuntime, deps: SetupDeps = {}): void {
  program
    .command('setup')
    .description('Install optional extras and sign in to services')
    .argument('[target]', `what to set up (${TARGETS.map((t) => t.name).join(', ')})`)
    .action(async (target: string | undefined, _options: unknown, cmd: Command) => {
      const env = rt.env(cmd);
      if (target === undefined) {
        if (env.json) {
          env.emitJson({ ok: true, targets: TARGETS });
          return;
        }
        env.say('Things you can set up:\n');
        for (const item of TARGETS) env.say(`  mergestory setup ${item.name}\n      ${item.summary}`);
        return;
      }
      if (!TARGETS.some((item) => item.name === target)) {
        throw new MergeStoryError('USAGE', `Unknown setup target: ${JSON.stringify(target.slice(0, 40))}.`, {
          hint: `Choose one of: ${TARGETS.map((t) => t.name).join(', ')}.`,
        });
      }
      if (target === 'youtube' || target === 'drive') {
        await setupGoogle(env, deps, target);
        return;
      }
      env.say('Kokoro is a free text-to-speech voice that runs on this machine (English only).');
      env.say('  - Installing it adds about 400 MB of files under your MergeStory home.');
      env.say(
        '  - The speech model (roughly 90 to 330 MB) downloads from huggingface.co the first time a video uses it.',
      );
      env.say('  - No repository content is sent anywhere.\n');
      const config = await loadConfig(env);
      const [{ createRunContext }, { homeLayout }, { newRunId }, { setupKokoro }] = await Promise.all([
        import('../../core/context.ts'),
        import('../../core/paths.ts'),
        import('../../core/ids.ts'),
        import('../../narration/index.ts'),
      ]);
      const runId = newRunId();
      const ctx = createRunContext({
        config,
        runId,
        runDir: join(homeLayout(config.home).runs, runId),
        logger: env.logger,
        signal: env.signal,
      });
      // The same lock as a run that installs the voice, so the two never install at once.
      const status = await setupKokoro(ctx);
      if (env.json) {
        env.emitJson({ ok: true, kokoro: status });
        return;
      }
      env.say(`Kokoro${status.version ? ` ${status.version}` : ''} is installed at ${status.location}.`);
      env.say(
        status.modelCached
          ? 'The speech model is already downloaded.'
          : 'The speech model is not downloaded yet. It downloads the first time a video uses it.',
      );
      env.say('Use it with --tts kokoro, or leave --tts on auto.');
    });
}
