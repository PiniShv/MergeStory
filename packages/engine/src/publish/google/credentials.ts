/**
 * A Google sign-in (YouTube, Google Drive): an OAuth client id and secret, and the refresh token that
 * `mergestory setup <service>` obtained. They come from environment variables (for CI) or, when those are missing, from
 * a file in the MergeStory home that only the current user can read.
 *
 * Every value is registered with the redactor as soon as it is read.
 */
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { SecretName } from '../../core/config.ts';
import type { RunContext } from '../../core/context.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { randomToken } from '../../core/ids.ts';
import { shellQuote } from '../../core/text.ts';
import { type GoogleProvider, setupCommand } from './provider.ts';

export interface GoogleCredentials {
  clientId: string;
  /** Desktop clients get a secret when they are created; it may be missing for other client types. */
  clientSecret: string | null;
  refreshToken: string;
  /** Space-separated scopes the token was granted, when the file says so. */
  scope: string | null;
}

/** What is stored in the credentials file. */
export interface StoredCredentials extends GoogleCredentials {
  createdAt: string | null;
}

const MAX_FILE_BYTES = 64 * 1024;

const StoredSchema = z.object({
  version: z.number().int().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().nullable().optional(),
  refresh_token: z.string().min(1),
  scope: z.string().nullable().optional(),
  created_at: z.string().optional(),
});

export function credentialsDir(home: string): string {
  return join(home, 'credentials');
}

export function credentialsPath(home: string, provider: GoogleProvider): string {
  return join(credentialsDir(home), provider.file);
}

/** true when group or other users have any access. POSIX only: Windows has no such mode bits. */
function isTooOpen(mode: number, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' && (mode & 0o077) !== 0;
}

/**
 * Read the credentials file. Returns null when it does not exist. Refuses a file that other users
 * can read, because it holds a long-lived token.
 */
export async function readCredentialsFile(
  path: string,
  provider: GoogleProvider,
  platform: NodeJS.Platform = process.platform,
): Promise<StoredCredentials | null> {
  const { label } = provider;
  const setup = setupCommand(provider);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new MergeStoryError('CONFIG_INVALID', `The ${label} credentials file could not be opened.`, {
      hint: `Check the permissions of ${path}, or run \`${setup}\` again.`,
      cause: err,
    });
  }
  try {
    // Checked on the open file, so the file cannot be swapped between the check and the read.
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        `The ${label} credentials file is not a plain, small file.`,
        {
          hint: `Delete ${path} and run \`${setup}\` again.`,
        },
      );
    }
    if (isTooOpen(info.mode, platform)) {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        `The ${label} credentials file can be read by other users.`,
        {
          hint: `Run: chmod 600 ${shellQuote(path)}  (and chmod 700 on its folder). Or delete it and run \`${setup}\` again.`,
        },
      );
    }
    const text = await handle.readFile('utf8');
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // reported below as an invalid file
    }
    const parsed = StoredSchema.safeParse(json);
    if (!parsed.success) {
      throw new MergeStoryError('CONFIG_INVALID', `The ${label} credentials file is not valid.`, {
        hint: `Run \`${setup}\` again to write it afresh (it replaces ${path}).`,
      });
    }
    const data = parsed.data;
    return {
      clientId: data.client_id,
      clientSecret: data.client_secret ?? null,
      refreshToken: data.refresh_token,
      scope: data.scope ?? null,
      createdAt: data.created_at ?? null,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Write the credentials file: the folder is made private (0700) and the file is written with
 * mode 0600 to a temporary name first, then moved into place, so a half-written file never exists.
 */
export async function writeCredentialsFile(
  path: string,
  provider: GoogleProvider,
  credentials: StoredCredentials,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const payload = {
    version: 1,
    client_id: credentials.clientId,
    ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}),
    refresh_token: credentials.refreshToken,
    ...(credentials.scope ? { scope: credentials.scope } : {}),
    created_at: credentials.createdAt ?? new Date().toISOString(),
  };
  const temp = join(dir, `.${provider.file}.${randomToken(4)}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // The mode given above is reduced by the umask; this makes it exact.
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw new MergeStoryError(
      'CONFIG_INVALID',
      `The ${provider.label} credentials file could not be written.`,
      {
        hint: `Check that ${dir} can be written to.`,
        cause: err,
      },
    );
  }
}

/** The environment variables that hold a service's sign-in. */
export function envNames(
  provider: GoogleProvider,
): Record<'clientId' | 'clientSecret' | 'refreshToken', SecretName> {
  return {
    clientId: `${provider.envPrefix}_CLIENT_ID`,
    clientSecret: `${provider.envPrefix}_CLIENT_SECRET`,
    refreshToken: `${provider.envPrefix}_REFRESH_TOKEN`,
  };
}

export interface LoadOptions {
  platform?: NodeJS.Platform;
}

/**
 * The credentials for a run. Environment variables win over the file, value by value. The file is
 * only read when the client id or the refresh token is missing from the environment.
 */
export async function loadCredentials(
  ctx: Pick<RunContext, 'secrets' | 'redactor' | 'home'>,
  provider: GoogleProvider,
  options: LoadOptions = {},
): Promise<GoogleCredentials> {
  const names = envNames(provider);
  const setup = setupCommand(provider);
  const fromEnv = {
    clientId: ctx.secrets.get(names.clientId),
    clientSecret: ctx.secrets.get(names.clientSecret),
    refreshToken: ctx.secrets.get(names.refreshToken),
  };
  const path = credentialsPath(ctx.home.home, provider);
  const file =
    fromEnv.clientId && fromEnv.refreshToken
      ? null
      : await readCredentialsFile(path, provider, options.platform);

  if (file && fromEnv.clientId && !fromEnv.refreshToken && fromEnv.clientId !== file.clientId) {
    throw new MergeStoryError(
      'CONFIG_INVALID',
      `${names.clientId} is not the client the saved sign-in was made with.`,
      {
        hint: `Unset ${names.clientId}, or run \`${setup}\` again with that client.`,
      },
    );
  }
  const clientId = fromEnv.clientId ?? file?.clientId ?? null;
  const refreshToken = fromEnv.refreshToken ?? file?.refreshToken ?? null;
  if (!clientId || !refreshToken) {
    const missing = [...(clientId ? [] : [names.clientId]), ...(refreshToken ? [] : [names.refreshToken])];
    throw new MergeStoryError('CONFIG_INVALID', `No ${provider.label} sign-in was found.`, {
      hint:
        `Run \`${setup}\` on a machine with a browser. In CI, set ${names.clientId}, ` +
        `${names.clientSecret} and ${names.refreshToken} (missing: ${missing.join(', ')}).`,
    });
  }
  const credentials: GoogleCredentials = {
    clientId,
    clientSecret: fromEnv.clientSecret ?? file?.clientSecret ?? null,
    refreshToken,
    // The file's scopes belong to the file's token, not to a token from the environment.
    scope: fromEnv.refreshToken ? null : (file?.scope ?? null),
  };
  ctx.redactor.add(credentials.clientId);
  ctx.redactor.add(credentials.clientSecret);
  ctx.redactor.add(credentials.refreshToken);
  return credentials;
}
