/** The real file system, processes and modules for the checks, loaded only when a check needs them. */
import { access, constants, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homeLayout } from '../core/paths.ts';
import type { DoctorDeps, RunResult } from './types.ts';

async function defaultRun(command: string, args: string[]): Promise<RunResult> {
  const { findProgram, runCommand } = await import('../core/process.ts');
  try {
    // A bare name (git) is started by its absolute path on PATH; configured paths are used as given.
    const program = /[\\/]/.test(command) ? command : await findProgram(command);
    const result = await runCommand(program, args, {
      timeoutMs: 15_000,
      allowFailure: true,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

async function defaultExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await access(current, constants.F_OK);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export function defaultDoctorDeps(env: NodeJS.ProcessEnv): DoctorDeps {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    env,
    which: async (command) => (await import('../core/process.ts')).which(command),
    run: defaultRun,
    resolveFfmpeg: async (config) => (await import('../core/binaries.ts')).resolveFfmpeg(config),
    resolveBrowser: async (config) => (await import('../render/index.ts')).resolveBrowserExecutable(config),
    kokoroStatus: async (config) => {
      const { createRunContext } = await import('../core/context.ts');
      const { silentLogger } = await import('../core/logger.ts');
      const home = homeLayout(config.home);
      const ctx = createRunContext({
        config,
        runId: 'doctor',
        runDir: join(home.runs, 'doctor'),
        logger: silentLogger,
      });
      return (await import('../narration/index.ts')).kokoroStatus(ctx);
    },
    freeBytes: async (path) => {
      try {
        const info = await statfs(path);
        return Number(info.bavail) * Number(info.bsize);
      } catch {
        return null;
      }
    },
    existingAncestor: defaultExistingAncestor,
    isWritable: async (path) => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    headBucket: async (config, secrets) =>
      (await import('../publish/s3/index.ts')).checkBucket(config.publish.s3, secrets),
    probeAccess: async (url, folder) =>
      (await import('../publish/access-probe.ts')).probeAccessProtection(url, { pathPrefix: folder }),
    readYouTubeLogin: async (path) => {
      const { readCredentialsFile } = await import('../publish/youtube/credentials.ts');
      const found = await readCredentialsFile(path);
      if (!found) return null;
      return {
        clientId: found.clientId !== '',
        clientSecret: Boolean(found.clientSecret),
        refreshToken: found.refreshToken !== '',
      };
    },
    driveDomain: async (config, ctx) =>
      new (await import('../publish/drive/publisher.ts')).DrivePublisher(config).accountDomain(ctx),
    publisher: async (config) => (await import('../publish/index.ts')).createPublisher(config),
  };
}
