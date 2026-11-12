/** What the shared Google code needs to know about one service: its name, its settings and its own errors. */
import type { Explanation, GoogleApiError } from './google-api.ts';

export interface GoogleProvider {
  /** The publish provider and the `mergestory setup` target. */
  id: 'youtube' | 'drive';
  /** For messages: "YouTube", "Google Drive". */
  label: string;
  /** Prefix of the environment variables that hold the sign-in. */
  envPrefix: 'MERGESTORY_YOUTUBE' | 'MERGESTORY_DRIVE';
  /** File name of the saved sign-in, inside $MERGESTORY_HOME/credentials. */
  file: string;
  /** The API to turn on in the Google Cloud project. */
  apiName: string;
  /** Failures only this service has, worded for it. null leaves the shared wording. */
  explain?: (err: GoogleApiError) => Explanation | null;
}

/** "mergestory setup youtube" */
export function setupCommand(provider: GoogleProvider): string {
  return `mergestory setup ${provider.id}`;
}

/** The guide for this service, as a link that also works for an installed package. */
export function docsRef(provider: GoogleProvider): string {
  return `https://github.com/PiniShv/MergeStory/blob/main/docs/${provider.id}.md`;
}
