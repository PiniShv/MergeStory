/** mergestory serve: the HTTP API. */
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { MergeStoryError } from '../../core/errors.ts';
import { collect, portFlag } from '../options.ts';
import type { CliRuntime } from '../runtime.ts';
import { loadConfig } from './shared.ts';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

interface ServeFlags {
  host: string;
  port: number;
  tokenEnv: string;
  allowRoot?: string[];
  allowHost?: string[];
}

/** Add the `serve` command. */
export function registerServe(program: Command, rt: CliRuntime): void {
  program
    .command('serve')
    .description('Start the HTTP API (jobs run one at a time on this machine)')
    .option('--host <host>', 'address to listen on; anything but loopback needs a token', '127.0.0.1')
    .option('--port <port>', 'port to listen on', portFlag, 7171)
    .option(
      '--token-env <name>',
      'name of the environment variable that holds the API token',
      'MERGESTORY_API_TOKEN',
    )
    .option(
      '--allow-root <dir>',
      'directory that local repositories may live in (repeatable). Without one, only pull requests are accepted',
      collect,
    )
    .option(
      '--allow-host <name>',
      'another name accepted in the Host header, for a reverse proxy on this machine that passes on the name it was reached by (repeatable)',
      collect,
    )
    .action(async (flags: ServeFlags, cmd: Command) => {
      const env = rt.env(cmd);
      // The flag takes a name, never the token itself: tokens must not appear in a command line.
      if (!ENV_NAME.test(flags.tokenEnv)) {
        throw new MergeStoryError(
          'USAGE',
          '--token-env takes the name of an environment variable, not the token itself.',
          {
            hint: 'For example: export MERGESTORY_API_TOKEN=$(openssl rand -hex 24) and then mergestory serve',
          },
        );
      }
      const roots = flags.allowRoot ?? [];
      const hosts = flags.allowHost ?? [];
      const config = await loadConfig(env);
      const token = env.io.env[flags.tokenEnv]?.trim() || null;
      const { startServer } = await import('../../server/index.ts');
      const server = await startServer({
        host: flags.host,
        port: flags.port,
        token,
        allowRoots: roots.map((dir) => resolve(env.io.cwd, dir)),
        allowedHosts: hosts,
        configPath: env.configPath,
        home: config.home,
        logger: env.logger,
        signal: env.signal,
      });
      if (!token) {
        env.logger.warn(
          `No API token is set (${flags.tokenEnv}). Any program on this machine can use the API; browsers are blocked by the Host check.`,
        );
      }
      if (env.json) {
        env.emitJson({
          ok: true,
          url: server.url,
          host: server.host,
          port: server.port,
          auth: token !== null,
          allowRoots: roots,
        });
      } else {
        env.say(`MergeStory API listening on ${server.url}`);
        env.say(
          token
            ? `  Send the token as: Authorization: Bearer <token from ${flags.tokenEnv}>`
            : '  No token: only this machine can reach it.',
        );
        env.say(
          roots.length > 0
            ? `  Local repositories are allowed below: ${roots.join(', ')}`
            : '  Local repositories are not allowed (no --allow-root). Pull requests only.',
        );
        if (hosts.length > 0) env.say(`  Host names accepted besides the loopback ones: ${hosts.join(', ')}`);
        env.say('  Press Ctrl+C to stop.');
      }
      await server.closed;
    });
}
