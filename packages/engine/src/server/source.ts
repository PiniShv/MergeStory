/** Source handling for the HTTP API: pull requests are fine, local paths must be inside an allowed root. */
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gitEnvironment } from '../core/child-env.ts';
import { MergeStoryError } from '../core/errors.ts';
import { isInside } from '../core/posix.ts';
import { findProgram, runCommand } from '../core/process.ts';
import type { SourceInput } from '../core/providers.ts';
import { detectSourceInput } from '../sources/index.ts';
import { ApiError, toApiError } from './http.ts';

const GIT_TIMEOUT_MS = 10_000;

/** Resolve the allowed roots once, at startup, so symbolic links in them are followed by the same rules as sources. */
export async function resolveAllowRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    const real = await realpath(root).catch(() => null);
    const info = real ? await stat(real).catch(() => null) : null;
    if (!real || !info?.isDirectory()) {
      throw new MergeStoryError('USAGE', `The allowed root ${root} is not a directory.`, {
        hint: 'Pass an existing directory to --allow-root.',
      });
    }
    resolved.push(real);
  }
  return resolved;
}

/**
 * The places git reads when it runs in `path`, as real paths: the top level of the work tree, the
 * git directory and the common directory. Git looks in parent directories for a repository and
 * follows a `.git` file or link, so these can lie far from `path`. Null when git cannot read a work
 * tree there.
 */
async function gitLocations(path: string): Promise<string[] | null> {
  const git = await findProgram('git', [path]).catch(() => null);
  if (git === null) return null;
  const result = await runCommand(
    git,
    ['--no-pager', 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    {
      cwd: path,
      env: gitEnvironment(),
      allowFailure: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    },
  ).catch(() => null);
  if (result?.code !== 0) return null;
  const lines = result.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== 3 || lines.some((line) => line === '')) return null;
  // A relative common directory is relative to the directory git ran in.
  const real = await Promise.all(lines.map((line) => realpath(resolve(path, line)).catch(() => null)));
  return real.every((location): location is string => location !== null) ? real : null;
}

/** The source part of a request. */
export interface SourceRequest {
  source: string;
  base?: string | null | undefined;
  head?: string | null | undefined;
}

/**
 * Decide what a request's `source` refers to and check it may be used. The returned value is what
 * the pipeline receives, so what was checked is exactly what runs: for local repositories that is
 * the real path of the work tree's top level. The path, that top level and the git directories
 * must all be inside an allowed root, so a plain directory inside a root cannot be used to read
 * the repository that contains it.
 */
export async function resolveApiSource(
  request: SourceRequest,
  allowRoots: readonly string[],
  cwd: string,
): Promise<SourceInput> {
  let detected: SourceInput;
  try {
    detected = detectSourceInput(request.source, {
      base: request.base ?? null,
      head: request.head ?? null,
      cwd,
    });
  } catch (err) {
    throw toApiError(err, 'SOURCE_INVALID') ?? err;
  }
  if (detected.kind === 'github') {
    if (request.base || request.head) {
      throw new ApiError(400, 'USAGE', 'base and head can only be used with a local repository.');
    }
    return detected;
  }
  if (allowRoots.length === 0) {
    throw new ApiError(403, 'FORBIDDEN', 'Local repositories are not enabled on this server.', {
      hint: 'Start the server with --allow-root <dir> to allow repositories below a directory.',
    });
  }
  // One message for "missing" and "outside", so the API cannot be used to probe the file system.
  const refused = new ApiError(
    403,
    'FORBIDDEN',
    'The repository path does not exist or is not inside an allowed root.',
    {
      hint: 'The whole repository, including its top level and its .git directory, must be inside an allowed root.',
    },
  );
  const allowed = (path: string): boolean => allowRoots.some((root) => isInside(root, path));
  const real = await realpath(detected.repoPath).catch(() => null);
  if (!real || !allowed(real)) throw refused;
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) throw refused;
  const locations = await gitLocations(real);
  if (!locations) {
    throw new ApiError(400, 'SOURCE_INVALID', 'The path is not a git work tree that the server can read.', {
      hint: 'Pass a git repository inside an allowed root. If it belongs to another user, git on the server may need it in safe.directory.',
    });
  }
  if (!locations.every(allowed)) throw refused;
  return { ...detected, repoPath: locations[0]! };
}
