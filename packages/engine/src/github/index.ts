/**
 * Optional GitHub integration: reading pull requests, and (only when asked) writing one
 * comment or one section of the description. The engine works without it.
 */

export type { GitHubClientOptions } from './client.ts';
export { GITHUB_API_VERSION, GitHubClient, MAX_PR_FILES } from './client.ts';
export type { IssueReference } from './linked-issues.ts';
export { extractClosingReferences, findLinkedIssues } from './linked-issues.ts';
export type {
  GitHubComment,
  GitHubComparison,
  GitHubIssue,
  GitHubPrCommit,
  GitHubPrFile,
  GitHubPullRequest,
  GitHubRepo,
  GitHubTree,
  GitHubTreeEntry,
} from './model.ts';
export type { CommentResult } from './notify.ts';
export {
  DESCRIPTION_END,
  DESCRIPTION_START,
  replaceMarkedSection,
  updatePullRequestDescription,
  upsertPullRequestComment,
} from './notify.ts';
export type { PullRequestRef } from './pr-url.ts';
export {
  DEFAULT_API_URL,
  graphqlUrlFor,
  isValidOwnerName,
  isValidRepoName,
  parsePullRequestUrl,
  webHostFromApiUrl,
} from './pr-url.ts';
