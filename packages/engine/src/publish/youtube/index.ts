/** YouTube publisher (YouTube Data API v3) and its sign-in setup. */
export {
  credentialsPath,
  loadCredentials,
  readCredentialsFile,
  writeCredentialsFile,
} from './credentials.ts';
export { buildDescription, buildTags, buildTitle, chaptersQualify } from './description.ts';
export { openInBrowser, readHidden } from './prompt.ts';
export { createYouTubePublisher, YouTubePublisher, type YouTubePublisherOptions } from './publisher.ts';
export { requiredScopes } from './scopes.ts';
export { runYouTubeSignIn, type SignInIo, type SignInOptions, type SignInResult } from './sign-in.ts';
