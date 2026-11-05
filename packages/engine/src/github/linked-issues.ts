/**
 * Finding the issues a pull request closes: through GraphQL when there is a token, otherwise (or
 * when that fails) from "fixes #n" references in the description.
 */
import type { RunContext } from '../core/context.ts';
import { asArray, isRecord } from '../core/json.ts';
import type { GitHubClient } from './client.ts';
import { type GitHubIssue, toIssue } from './model.ts';

export interface IssueReference {
  owner: string;
  repo: string;
  number: number;
}

/**
 * "fixes #12", "Closes: owner/repo#7", "resolved https://github.com/o/r/issues/3". Like GitHub,
 * each reference needs its own keyword.
 */
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+(?:https?:\/\/([^\s/]+)\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|(?:([\w.-]+)\/([\w.-]+))?#(\d+))/gi;

/** Remove every `open ... close` span. An unclosed span is left alone. Runs in linear time. */
function removeSpans(text: string, open: string, close: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start < 0) return out + text.slice(from);
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return out + text.slice(from);
    out += `${text.slice(from, start)} `;
    from = end + close.length;
  }
}

/**
 * GitHub ignores references inside code and HTML comments (PR templates often have both).
 * Plain string search is used instead of lazy regular expressions, because a description is
 * written by someone else and must not be able to make the matching slow.
 */
function stripCode(text: string): string {
  const withoutBlocks = removeSpans(
    removeSpans(removeSpans(text, '<!--', '-->'), '```', '```'),
    '~~~',
    '~~~',
  );
  return withoutBlocks.replace(/`[^`\n]*`/g, ' ');
}

/** Whether a reference points into the pull request's own repository (names ignore case, like GitHub). */
export function isSameRepository(reference: IssueReference, pr: { owner: string; repo: string }): boolean {
  return (
    reference.owner.toLowerCase() === pr.owner.toLowerCase() &&
    reference.repo.toLowerCase() === pr.repo.toLowerCase()
  );
}

/**
 * Closing references in a pull request description, in order of appearance, without duplicates.
 * Links on a different host than the pull request are ignored, and with `sameRepositoryOnly` so
 * are references to other repositories. The limit applies after that filter.
 */
export function extractClosingReferences(
  body: string,
  pr: { owner: string; repo: string; webHost: string },
  max: number,
  options: { sameRepositoryOnly?: boolean } = {},
): IssueReference[] {
  const found: IssueReference[] = [];
  const seen = new Set<string>();
  for (const match of stripCode(body).matchAll(CLOSING_KEYWORD)) {
    let reference: IssueReference;
    if (match[4] !== undefined) {
      if (match[1]!.toLowerCase() !== pr.webHost.toLowerCase()) continue;
      reference = { owner: match[2]!, repo: match[3]!, number: Number(match[4]) };
    } else {
      reference = { owner: match[5] ?? pr.owner, repo: match[6] ?? pr.repo, number: Number(match[7]) };
    }
    if (!Number.isSafeInteger(reference.number) || reference.number < 1) continue;
    if (options.sameRepositoryOnly && !isSameRepository(reference, pr)) continue;
    const key = `${reference.owner}/${reference.repo}#${reference.number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(reference);
    if (found.length >= max) break;
  }
  return found;
}

async function closingIssuesFromGraphql(
  client: GitHubClient,
  maxIssues: number,
): Promise<GitHubIssue[] | null> {
  const query =
    'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){' +
    `closingIssuesReferences(first:${maxIssues}){nodes{number title body url repository{nameWithOwner}}}}}}`;
  const data = await client.graphql(query, {
    owner: client.ref.owner,
    repo: client.ref.repo,
    number: client.ref.number,
  });
  if (!isRecord(data) || asArray(data.errors).length > 0 || !isRecord(data.data)) return null;
  const repository = data.data.repository;
  const pullRequest = isRecord(repository) ? repository.pullRequest : null;
  const references = isRecord(pullRequest) ? pullRequest.closingIssuesReferences : null;
  if (!isRecord(references)) return null;
  const issues: GitHubIssue[] = [];
  for (const node of asArray(references.nodes)) {
    if (!isRecord(node) || !isRecord(node.repository)) continue;
    // Only issues of this repository, as on the REST path: the token may read private repositories.
    const [owner, repo] = String(node.repository.nameWithOwner).split('/');
    if (!owner || !repo || !isSameRepository({ owner, repo, number: 0 }, client.ref)) continue;
    const issue = toIssue({ ...node, html_url: node.url });
    if (issue) issues.push(issue);
  }
  return issues.slice(0, maxIssues);
}

/**
 * Issues the pull request closes, at most `maxIssues`. With a token this asks GraphQL, which also
 * knows about manually linked issues. Without one, or when GraphQL fails, "fixes #n" style
 * references in the description are looked up over REST. The description is written by the PR
 * author, so with a token only references to this repository are followed: the token may read
 * private repositories the author cannot see.
 */
export async function findLinkedIssues(
  client: GitHubClient,
  ctx: Pick<RunContext, 'signal' | 'logger'>,
  prBody: string,
  maxIssues: number,
): Promise<GitHubIssue[]> {
  if (client.authenticated) {
    try {
      const viaGraphql = await closingIssuesFromGraphql(client, maxIssues);
      if (viaGraphql !== null) return viaGraphql;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.logger.debug('GraphQL lookup of linked issues failed; using the description instead');
    }
  }
  const issues: GitHubIssue[] = [];
  const references = extractClosingReferences(prBody, client.ref, maxIssues, {
    sameRepositoryOnly: client.authenticated,
  });
  for (const reference of references) {
    if (reference.number === client.ref.number && isSameRepository(reference, client.ref)) continue;
    const issue = await client.getIssue(reference.owner, reference.repo, reference.number);
    if (issue) issues.push(issue);
  }
  return issues;
}
