/** Google Drive as a Google service: its settings, its one permission and its sign-in. */
import type { Explanation, GoogleApiError } from '../google/google-api.ts';
import type { GoogleProvider } from '../google/provider.ts';
import { runGoogleSignIn, type SignInOptions, type SignInResult } from '../google/sign-in.ts';

/** The only permission MergeStory asks for: files and folders that MergeStory itself created. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const DRIVE: GoogleProvider = {
  id: 'drive',
  label: 'Google Drive',
  envPrefix: 'MERGESTORY_DRIVE',
  file: 'drive.json',
  apiName: 'Google Drive API',
  explain,
};

/** Failures only Drive has. */
function explain(err: GoogleApiError): Explanation | null {
  if (err.has('storageQuotaExceeded')) {
    return {
      code: 'PUBLISH_FAILED',
      message: 'Your Google Drive is full.',
      hint: 'Free some space in Google Drive, or ask your administrator for more storage, then publish again.',
    };
  }
  return null;
}

/** `mergestory setup drive`. */
export function runDriveSignIn(options: SignInOptions): Promise<SignInResult> {
  return runGoogleSignIn(options, {
    provider: DRIVE,
    scopes: [DRIVE_FILE_SCOPE],
    describeScope: () =>
      'drive.file: only the files and the folder that MergeStory creates. MergeStory never sees the rest of your Drive.',
    purpose:
      'MergeStory uploads videos to a folder named MergeStory in the Google Drive of the account you choose.',
    notes: [],
  });
}
