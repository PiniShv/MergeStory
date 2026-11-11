/** The command line: global options, the commands, and how failures become exit codes. */
import { Command, CommanderError, Option } from 'commander';
import { MergeStoryError } from '../core/errors.ts';
import { ENGINE_VERSION } from '../version.ts';
import { registerAnalyze, registerSchema, registerValidate } from './commands/authoring.ts';
import { registerCache } from './commands/cache.ts';
import { registerDoctor } from './commands/doctor.ts';
import { registerGenerate } from './commands/generate.ts';
import { registerJobCommands } from './commands/jobs.ts';
import { registerPublish } from './commands/publish.ts';
import { registerRender } from './commands/render.ts';
import { registerServe } from './commands/serve.ts';
import { registerSetup } from './commands/setup.ts';
import { formatError } from './format.ts';
import { type CliIo, createIo } from './io.ts';
import { CliRuntime, describeError, errorEnvelope, USAGE_HINT } from './runtime.ts';
import { colorEnabled, createStyle } from './style.ts';

/** Build the command tree. Nothing heavy is loaded until a command runs. */
export function buildProgram(rt: CliRuntime): Command {
  const { io } = rt;
  const program = new Command('mergestory');
  // These must come before the commands are added: commands copy them when they are created.
  program
    .exitOverride()
    .showSuggestionAfterError()
    .configureHelp({ showGlobalOptions: true })
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      getOutHasColors: () => colorEnabled(io.stdoutIsTty, io.env),
      getErrHasColors: () => colorEnabled(io.stderrIsTty, io.env),
      // Usage errors look like every other error: "error [USAGE]: ..." and a hint.
      outputError: (text, write) => {
        const message = text
          .replace(/^error:\s*/i, '')
          .trim()
          .replace(/\n+/g, ' ');
        const style = createStyle(colorEnabled(io.stderrIsTty, io.env));
        write(formatError({ code: 'USAGE', message, hint: USAGE_HINT, exitCode: 2 }, style));
      },
    });

  program
    .description('Turn a pull request into a short, accurate, narrated video. Every change has a story.')
    .version(ENGINE_VERSION, '-V, --version', 'print the version')
    .optionsGroup('Global options:')
    .option('--json', 'print one JSON object on stdout and nothing else (logs go to stderr)')
    .addOption(
      new Option('--log-level <level>', 'how much to log on stderr')
        .choices(['debug', 'info', 'warn', 'error', 'silent'])
        .env('MERGESTORY_LOG_LEVEL'),
    )
    .addOption(
      new Option('--log-format <format>', 'log line format')
        .choices(['pretty', 'json'])
        .env('MERGESTORY_LOG_FORMAT'),
    )
    .option('-q, --quiet', 'log errors only (same as --log-level error)')
    .commandsGroup('Make a video:');
  registerGenerate(program, rt);
  registerPublish(program, rt);

  program.commandsGroup('Write the storyboard yourself:');
  registerAnalyze(program, rt);
  registerValidate(program, rt);
  registerRender(program, rt);
  registerSchema(program, rt);

  program.commandsGroup('Environment and background work:');
  registerDoctor(program, rt);
  registerSetup(program, rt);
  registerJobCommands(program, rt);
  registerServe(program, rt);
  registerCache(program, rt);
  return program;
}

/** Commander reports help and version through exceptions that carry exit code 0. */
const SUCCESS_CODES = new Set(['commander.helpDisplayed', 'commander.version']);

function installSignalHandlers(controller: AbortController, io: CliIo): () => void {
  let seen = 0;
  const onSignal = (name: string): void => {
    seen += 1;
    if (seen === 1) {
      io.stderr(`\nReceived ${name}. Stopping... (press Ctrl+C again to quit at once)\n`);
      controller.abort();
      return;
    }
    process.exit(130);
  };
  const onInt = (): void => onSignal('SIGINT');
  const onTerm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}

function report(err: unknown, argv: readonly string[], rt: CliRuntime): number {
  const { io } = rt;
  if (err instanceof CommanderError && SUCCESS_CODES.has(err.code)) return 0;
  // No command given: commander has printed the help (to stderr) and asks for a non-zero exit.
  if (err instanceof CommanderError && err.code === 'commander.help') return err.exitCode === 0 ? 0 : 2;
  const view = describeError(err);
  const json = rt.current ? rt.current.json : argv.includes('--json');
  if (json) {
    io.stdout(`${JSON.stringify(errorEnvelope(view))}\n`);
  } else if (!(err instanceof CommanderError)) {
    // Commander has already printed its own usage errors.
    const style = createStyle(colorEnabled(io.stderrIsTty, io.env));
    io.stderr(formatError(view, style));
  }
  if (view.stack && (rt.current?.debug ?? false)) io.stderr(`${view.stack}\n`);
  return view.exitCode;
}

/** Words that make commander print help or the version instead of running a command. */
const INFO_FLAGS = new Set(['-h', '--help', '-V', '--version']);

/** true for `mergestory --json` with no command and no request for help: there is nothing to run. */
function isBareJson(program: Command, argv: readonly string[]): boolean {
  if (!argv.includes('--json') || argv.some((word) => INFO_FLAGS.has(word))) return false;
  return program.parseOptions([...argv]).operands.length === 0;
}

/**
 * Run the CLI and return the exit code. Does not call process.exit (except on a second Ctrl+C, which
 * quits at once), so output is always flushed.
 * `argv` is what comes after `mergestory`.
 */
export async function runCli(argv: readonly string[], overrides: Partial<CliIo> = {}): Promise<number> {
  const io = createIo(overrides);
  const controller = new AbortController();
  const rt = new CliRuntime(io, controller.signal);
  const detach = io.handleSignals ? installSignalHandlers(controller, io) : () => {};
  try {
    // A settings file can name programs and hosts, so only the environment and the home folder may choose one.
    if (argv.some((word) => word === '--config' || word.startsWith('--config='))) {
      throw new MergeStoryError('USAGE', 'The --config option was removed in 1.1.0.', {
        hint: 'Set MERGESTORY_CONFIG=<file> instead, or put the file at ~/.mergestory/config.json.',
      });
    }
    const program = buildProgram(rt);
    // The help would go to stderr and stdout would stay empty: say what is wrong in the one JSON object instead.
    if (isBareJson(program, argv)) {
      throw new MergeStoryError('USAGE', 'No command was given.', { hint: USAGE_HINT });
    }
    await program.parseAsync(argv, { from: 'user' });
    return rt.exitCode;
  } catch (err) {
    return report(err, argv, rt);
  } finally {
    detach();
  }
}
