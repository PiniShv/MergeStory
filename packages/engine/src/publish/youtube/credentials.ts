/** The YouTube sign-in: the shared Google sign-in files and variables, for provider "youtube". */
import type { RunContext } from '../../core/context.ts';
import * as google from '../google/credentials.ts';
import { YOUTUBE } from './provider.ts';

export { credentialsDir, type GoogleCredentials, type StoredCredentials } from '../google/credentials.ts';

export const credentialsPath = (home: string): string => google.credentialsPath(home, YOUTUBE);

export const readCredentialsFile = (path: string, platform?: NodeJS.Platform) =>
  google.readCredentialsFile(path, YOUTUBE, platform);

export const writeCredentialsFile = (path: string, credentials: google.StoredCredentials) =>
  google.writeCredentialsFile(path, YOUTUBE, credentials);

export const loadCredentials = (
  ctx: Pick<RunContext, 'secrets' | 'redactor' | 'home'>,
  options?: google.LoadOptions,
) => google.loadCredentials(ctx, YOUTUBE, options);
