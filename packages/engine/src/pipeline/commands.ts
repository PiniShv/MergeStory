/** Command lines that hints and documents show to people. Quoted, so they can be pasted into a shell. */
import type { Config } from '../core/config.ts';
import { shellQuote } from '../core/text.ts';

/** The words of a command, quoted and joined. */
export function commandLine(args: readonly string[]): string {
  return args.map(shellQuote).join(' ');
}

/**
 * The command that uploads a rendered run again, with the settings that this run used, so that
 * a command line that was only typed once (flags are not stored) is not needed to try again.
 */
export function publishCommand(runDir: string, config: Config): string {
  const { provider, visibility } = config.publish;
  const args = ['mergestory', 'publish', runDir, '--publish', provider === 'none' ? 'local' : provider];
  if (provider === 's3') args.push('--visibility', visibility);
  if (config.github.comment) args.push('--comment');
  if (config.github.updateDescription) args.push('--update-description');
  return commandLine(args);
}
