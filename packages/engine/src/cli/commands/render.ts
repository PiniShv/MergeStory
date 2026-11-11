/** mergestory render: make the video on this machine. Safe to pre-approve: no flag reaches a host or spends money. */
import { type Command, Option } from 'commander';
import type { ConfigInput } from '../../core/config.ts';
import {
  addContextFlags,
  addSourceFlags,
  addStyleFlags,
  type ConfigFlags,
  type GenerateFlags,
} from '../options.ts';
import type { CliRuntime } from '../runtime.ts';
import { makeVideo } from './generate.ts';

/** The voices that run on this machine. */
const LOCAL_VOICES = ['auto', 'kokoro', 'say', 'none'] as const;

const EXAMPLES = `
Examples:
  mergestory render . --base main --storyboard storyboard.json
  mergestory render . --base main --dry-run
`;

/**
 * Security boundary: these settings win over the flags, the environment and the config file, so
 * that render never calls a model or a paid voice, never uploads or comments, and writes only to
 * the run folder. Do not loosen them without changing what SECURITY.md says about render.
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

/** Add the `render` command. */
export function registerRender(program: Command, rt: CliRuntime): void {
  const command = program
    .command('render')
    .description(
      'Make the video on this machine from a storyboard. Never calls a model or a paid voice, and never uploads',
    )
    .argument('[source]', 'pull request URL, owner/repo#123, or the path of a local repository', '.');
  addSourceFlags(command);
  addContextFlags(command);
  addStyleFlags(command);
  command
    .optionsGroup('Voice:')
    .addOption(
      new Option('--tts <provider>', 'speech on this machine; auto picks a free local voice').choices(
        LOCAL_VOICES,
      ),
    )
    .option('--voice <name>', 'voice name for the speech provider')
    .optionsGroup('Run:')
    .option(
      '--storyboard <file>',
      'the storyboard you wrote (max 1 MB); without it the free offline storyboard is used',
    )
    .option('--dry-run', 'show the plan; renders nothing')
    .option('--no-cache', 'do not use or fill the cache')
    .option('--no-captions', 'leave captions out of the video');
  command.addHelpText('after', EXAMPLES);
  command.action(async (source: string, flags: GenerateFlags, cmd: Command) => {
    await makeVideo(rt.env(cmd), source, flags, localOnlyOverrides(flags));
  });
}
