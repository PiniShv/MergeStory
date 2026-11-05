/**
 * The YouTube sign-in: an OAuth client id and secret, and the refresh token that `mergestory setup
 * youtube` obtained. They come from environment variables (for CI) or, when those are missing, from
 * a file in the MergeStory home that only the current user can read.
 *
 * Every value is registered with the redactor as soon as it is read.
 */
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { RunContext } from '../../core/context.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { randomToken } from '../../core/ids.ts';
import { shellQuote } from '../../core/text.ts';

export interface YouTubeCredentials {
  clientId: string;
  /** Desktop clients get a secret when they are created; it may be missing for other client types. */
  clientSecret: string | null;
  refreshToken: string;
  /** Space-separated scopes the token was granted, when the file says so. */
  scope: string | null;
}

/** What is stored in the credentials file. */
export interface StoredCredentials extends YouTubeCredentials {
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

export function credentialsPath(home: string): string {
  return join(credentialsDir(home), 'youtube.json');
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
  platform: NodeJS.Platform = process.platform,
): Promise<StoredCredentials | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new MergeStoryError('CONFIG_INVALID', 'The YouTube credentials file could not be opened.', {
      hint: `Check the permissions of ${path}, or run \`mergestory setup youtube\` again.`,
      cause: err,
    });
  }
  try {
    // Checked on the open file, so the file cannot be swapped between the check and the read.
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        'The YouTube credentials file is not a plain, small file.',
        {
          hint: `Delete ${path} and run \`mergestory setup youtube\` again.`,
        },
      );
    }
    if (isTooOpen(info.mode, platform)) {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        'The YouTube credentials file can be read by other users.',
        {
          hint: `Run: chmod 600 ${shellQuote(path)}  (and chmod 700 on its folder). Or delete it and run \`mergestory setup youtube\` again.`,
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
      throw new MergeStoryError('CONFIG_INVALID', 'The YouTube credentials file is not valid.', {
        hint: `Run \`mergestory setup youtube\` again to write it afresh (it replaces ${path}).`,
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
export async function writeCredentialsFile(path: string, credentials: StoredCredentials): Promise<void> {
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
  const temp = join(dir, `.youtube.json.${randomToken(4)}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // The mode given above is reduced by the umask; this makes it exact.
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw new MergeStoryError('CONFIG_INVALID', 'The YouTube credentials file could not be written.', {
      hint: `Check that ${dir} can be written to.`,
      cause: err,
    });
  }
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
  options: LoadOptions = {},
): Promise<YouTubeCredentials> {
  const fromEnv = {
    clientId: ctx.secrets.get('MERGESTORY_YOUTUBE_CLIENT_ID'),
    clientSecret: ctx.secrets.get('MERGESTORY_YOUTUBE_CLIENT_SECRET'),
    refreshToken: ctx.secrets.get('MERGESTORY_YOUTUBE_REFRESH_TOKEN'),
  };
  const path = credentialsPath(ctx.home.home);
  const file =
    fromEnv.clientId && fromEnv.refreshToken ? null : await readCredentialsFile(path, options.platform);

  if (file && fromEnv.clientId && !fromEnv.refreshToken && fromEnv.clientId !== file.clientId) {
    throw new MergeStoryError(
      'CONFIG_INVALID',
      'MERGESTORY_YOUTUBE_CLIENT_ID is not the client the saved sign-in was made with.',
      {
        hint: 'Unset MERGESTORY_YOUTUBE_CLIENT_ID, or run `mergestory setup youtube` again with that client.',
      },
    );
  }
  const clientId = fromEnv.clientId ?? file?.clientId ?? null;
  const refreshToken = fromEnv.refreshToken ?? file?.refreshToken ?? null;
  if (!clientId || !refreshToken) {
    const missing = [
      ...(clientId ? [] : ['MERGESTORY_YOUTUBE_CLIENT_ID']),
      ...(refreshToken ? [] : ['MERGESTORY_YOUTUBE_REFRESH_TOKEN']),
    ];
    throw new MergeStoryError('CONFIG_INVALID', 'No YouTube sign-in was found.', {
      hint:
        'Run `mergestory setup youtube` on a machine with a browser. In CI, set MERGESTORY_YOUTUBE_CLIENT_ID, ' +
        `MERGESTORY_YOUTUBE_CLIENT_SECRET and MERGESTORY_YOUTUBE_REFRESH_TOKEN (missing: ${missing.join(', ')}).`,
    });
  }
  const credentials: YouTubeCredentials = {
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
