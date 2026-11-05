/**
 * Checks that code-like names in a storyboard exist in the change. A narration line that names a
 * function, file or constant nobody can find in the diff, the files or the analysis is a sign of
 * an invented detail.
 *
 * Names are kept in two places. Code names come from the code itself and from what the analysis
 * read in it. Prose names come from text that people wrote about the change (the pull request,
 * commits, issues, the README, the task and the notes), and they stay tied to the evidence that
 * holds that text. A description of planned or wrong work must not pass as a fact about the code:
 * a name that only prose holds counts as known on a line that cites that prose.
 */

/** Names in one piece of prose. */
export interface ProseNames {
  words: Set<string>;
  lowerWords: Set<string>;
  pathTokens: Set<string>;
}

export interface KnownCorpus {
  /** Every identifier-like word in the code and its analysis. */
  words: Set<string>;
  lowerWords: Set<string>;
  /** Path strings known to exist (changed files, repository tree). */
  paths: string[];
  /** Path-shaped tokens that appear inside the code text. */
  pathTokens: Set<string>;
  /** Names that people wrote about the change, by the id of the evidence that holds the text ("PR", "NOTES", "CM1"). */
  prose: Map<string, ProseNames>;
}

export function createCorpus(): KnownCorpus {
  return { words: new Set(), lowerWords: new Set(), paths: [], pathTokens: new Set(), prose: new Map() };
}

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
/** A path with at least one slash and an extension that contains a letter. Not part of a URL. */
const PATH =
  /(?<![\w@./:\\-])(?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}(?![\w/-])/g;
const DOTTED_CALL = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?=\()/g;
const BACKTICKED = /`([^`\s]+)`/g;
const IDENTIFIER_SPAN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?$/;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Add code text (diff lines, file content, analysis labels) to the corpus. */
export function addCorpusText(corpus: KnownCorpus, text: string): void {
  if (!text) return;
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    corpus.words.add(word);
    corpus.lowerWords.add(word.toLowerCase());
  }
  for (const match of text.matchAll(PATH)) corpus.pathTokens.add(normalizePath(match[0]));
}

/** Add text that people wrote (PR description, commit message, task, notes), under the id of the evidence that holds it. */
export function addProseText(corpus: KnownCorpus, evidenceId: string, text: string): void {
  if (!text) return;
  let names = corpus.prose.get(evidenceId);
  if (!names) {
    names = { words: new Set(), lowerWords: new Set(), pathTokens: new Set() };
    corpus.prose.set(evidenceId, names);
  }
  for (const match of text.matchAll(WORD)) {
    names.words.add(match[0]);
    names.lowerWords.add(match[0].toLowerCase());
  }
  for (const match of text.matchAll(PATH)) names.pathTokens.add(normalizePath(match[0]));
}

/** Add paths that exist in the repository. Their parts count as known words too. */
export function addCorpusPaths(corpus: KnownCorpus, paths: Iterable<string>): void {
  for (const path of paths) {
    if (!path) continue;
    corpus.paths.push(normalizePath(path));
    addCorpusText(corpus, path);
  }
}

/** Names that are common in prose and not worth checking: brands, languages and keywords. */
const COMMON_TERMS = new Set([
  'github',
  'gitlab',
  'bitbucket',
  'javascript',
  'typescript',
  'nodejs',
  'postgresql',
  'mysql',
  'mongodb',
  'graphql',
  'openapi',
  'openai',
  'macos',
  'ios',
  'iphone',
  'ipad',
  'youtube',
  'linkedin',
  'devops',
  'websocket',
  'websockets',
  'oauth',
  'json',
  'yaml',
  'npm',
  'pnpm',
  'vscode',
  'fastapi',
  'kubernetes',
  'docker',
  'true',
  'false',
  'null',
  'undefined',
  'none',
  'nil',
  'async',
  'await',
  'const',
  'let',
  'var',
  'function',
  'class',
  'return',
  'import',
  'export',
  'default',
  'int',
  'string',
  'bool',
  'boolean',
  'void',
  'self',
  'this',
]);

export type TokenKind = 'backtick' | 'camel' | 'snake' | 'call' | 'path';

export interface CodeToken {
  text: string;
  kind: TokenKind;
}

/**
 * Code-like tokens in a piece of text: single backticked words, camelCase or PascalCase names,
 * snake_case names, dotted calls such as a.b(), and paths with a slash and an extension.
 */
export function codeLikeTokens(text: string): CodeToken[] {
  const found: CodeToken[] = [];
  const seen = new Set<string>();
  const add = (token: string, kind: TokenKind): void => {
    const key = `${kind}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ text: token, kind });
  };
  for (const match of text.matchAll(BACKTICKED)) {
    const inner = match[1]!;
    PATH.lastIndex = 0;
    if (new RegExp(`^(?:${PATH.source})$`).test(inner)) add(normalizePath(inner), 'path');
    else if (IDENTIFIER_SPAN.test(inner)) add(inner.replace(/\(\)$/, ''), 'backtick');
  }
  for (const match of text.matchAll(PATH)) add(normalizePath(match[0]), 'path');
  for (const match of text.matchAll(DOTTED_CALL)) add(match[0], 'call');
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (word.length < 4) continue;
    if (/[a-z][A-Z]/.test(word)) add(word, 'camel');
    else if (/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(word)) add(word, 'snake');
  }
  return found;
}

function isKnownWord(word: string, corpus: KnownCorpus, cited: readonly string[]): boolean {
  const lower = word.toLowerCase();
  if (corpus.words.has(word) || corpus.lowerWords.has(lower) || COMMON_TERMS.has(lower)) return true;
  return cited.some((id) => {
    const names = corpus.prose.get(id);
    return names !== undefined && (names.words.has(word) || names.lowerWords.has(lower));
  });
}

function isKnownPath(path: string, corpus: KnownCorpus, cited: readonly string[]): boolean {
  if (corpus.pathTokens.has(path)) return true;
  if (corpus.paths.some((known) => known === path || known.endsWith(`/${path}`))) return true;
  return cited.some((id) => corpus.prose.get(id)?.pathTokens.has(path) === true);
}

/** `cited` are the evidence ids of the text: a name that only prose holds is known when its prose is cited. */
export function isKnownToken(token: CodeToken, corpus: KnownCorpus, cited: readonly string[] = []): boolean {
  switch (token.kind) {
    case 'path':
      return isKnownPath(token.text, corpus, cited);
    case 'call':
    case 'backtick':
      return token.text.split('.').every((part) => isKnownWord(part, corpus, cited));
    default:
      return isKnownWord(token.text, corpus, cited);
  }
}

/** Code-like tokens in `text` that appear nowhere in the change, or only in prose that `cited` does not cite. */
export function unknownTokens(text: string, corpus: KnownCorpus, cited: readonly string[] = []): CodeToken[] {
  return codeLikeTokens(text).filter((token) => !isKnownToken(token, corpus, cited));
}

/** The ids of the prose that holds a token, so a message can say which source to cite. */
export function proseSources(token: CodeToken, corpus: KnownCorpus): string[] {
  const parts = token.kind === 'call' || token.kind === 'backtick' ? token.text.split('.') : [token.text];
  const holds = (names: ProseNames): boolean =>
    token.kind === 'path'
      ? names.pathTokens.has(token.text)
      : parts.every((part) => names.words.has(part) || names.lowerWords.has(part.toLowerCase()));
  return [...corpus.prose.entries()].filter(([, names]) => holds(names)).map(([id]) => id);
}
