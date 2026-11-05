/**
 * Repository context: a short, capped picture of the repository at head (top of the tree,
 * README, manifests). The same code serves the local and the GitHub source.
 */
import type { RepoContext } from '../core/types.ts';
import { MANIFEST_MAX_CHARS, README_MAX_CHARS, README_MAX_LINES, REPO_TREE_MAX_ENTRIES } from './limits.ts';
import { excerptLines, type PrivacyOptions, sanitizeText } from './text.ts';

/** Manifest files read from the repository root. */
export const MANIFEST_FILES = [
  'package.json',
  'go.mod',
  'pyproject.toml',
  'Cargo.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
] as const;

/** File names (lower case) that tell a reader what the project is, listed even when deeper in the tree. */
const KEY_FILE_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'cargo.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gemfile',
  'composer.json',
  'mix.exs',
  'package.swift',
  'cmakelists.txt',
  'makefile',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  'compose.yml',
  'deno.json',
]);

const KEY_FILE_MAX_DEPTH = 4;

function isKeyFile(segments: string[]): boolean {
  const name = segments[segments.length - 1]!.toLowerCase();
  if (/^readme(\..+)?$/.test(name)) return true;
  if (KEY_FILE_NAMES.has(name)) return true;
  return segments[0] === '.github' && segments[1] === 'workflows';
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reduce a file listing to the first two directory levels plus key files.
 * Directories end with "/". When more than `maxEntries` entries qualify, top-level entries are
 * kept first, then key files, then second-level directories.
 *
 * Input paths ending with "/" are treated as directories, so a non-recursive listing works too.
 */
export function reduceTree(
  paths: readonly string[],
  options: { maxEntries?: number } = {},
): { tree: string[]; truncated: boolean } {
  const maxEntries = options.maxEntries ?? REPO_TREE_MAX_ENTRIES;
  const top = new Set<string>();
  const keyFiles = new Set<string>();
  const secondLevel = new Set<string>();

  for (const path of paths) {
    const isDirectory = path.endsWith('/');
    const segments = path.split('/').filter(Boolean);
    const first = segments[0];
    if (first === undefined) continue;
    if (segments.length === 1) {
      top.add(isDirectory ? `${first}/` : first);
      continue;
    }
    top.add(`${first}/`);
    if (segments.length >= 3 || (isDirectory && segments.length === 2)) {
      secondLevel.add(`${first}/${segments[1]}/`);
    }
    if (!isDirectory && segments.length <= KEY_FILE_MAX_DEPTH && isKeyFile(segments))
      keyFiles.add(segments.join('/'));
  }

  const ordered = [
    ...[...top].sort(compareOrdinal),
    ...[...keyFiles].filter((p) => !top.has(p)).sort(compareOrdinal),
    ...[...secondLevel].sort(compareOrdinal),
  ];
  return {
    tree: ordered.slice(0, maxEntries).sort(compareOrdinal),
    truncated: ordered.length > maxEntries,
  };
}

const README_RANK: [RegExp, number][] = [
  [/^readme\.md$/i, 0],
  [/^readme\.(markdown|mdx)$/i, 1],
  [/^readme\.rst$/i, 2],
  [/^readme\.txt$/i, 3],
  [/^readme$/i, 4],
  [/^readme\.[a-z]+$/i, 5],
];

function pickReadme(topFiles: readonly string[]): string | null {
  let best: { path: string; rank: number } | null = null;
  for (const path of topFiles) {
    for (const [pattern, rank] of README_RANK) {
      if (pattern.test(path) && (best === null || rank < best.rank)) best = { path, rank };
    }
  }
  return best?.path ?? null;
}

export interface RepoContextInput {
  /** File paths at head. Directory entries may end with "/". */
  paths: readonly string[];
  /** True when the listing is known to be incomplete (the source cut it short). */
  pathsTruncated: boolean;
  /** Read a file at head; null when missing, binary or too large. */
  readHead(path: string): Promise<string | null>;
  /** True for sensitive or excluded paths. They are left out of the tree and never read. */
  isProtected(path: string): boolean;
  privacy: PrivacyOptions;
}

/** Build the RepoContext from a file listing and a reader. Reading problems leave a field empty. */
export async function buildRepoContext(input: RepoContextInput): Promise<RepoContext> {
  const visible = input.paths.filter((path) => !input.isProtected(path.replace(/\/+$/, '')));
  const { tree, truncated } = reduceTree(visible);
  const topFiles = visible.filter((path) => !path.includes('/'));

  const readExcerpt = async (path: string, maxLines: number, maxChars: number): Promise<string | null> => {
    try {
      const content = await input.readHead(path);
      if (content === null) return null;
      // Mask the whole file before the cut: a secret cut in half no longer looks like one.
      const excerpt = excerptLines(sanitizeText(content, input.privacy), maxLines, maxChars);
      return excerpt.trim() ? excerpt : null;
    } catch {
      return null;
    }
  };

  const readmePath = pickReadme(topFiles);
  const manifestPaths = MANIFEST_FILES.filter((name) => topFiles.includes(name));
  const [readmeExcerpt, manifestExcerpts] = await Promise.all([
    readmePath ? readExcerpt(readmePath, README_MAX_LINES, README_MAX_CHARS) : Promise.resolve(null),
    Promise.all(manifestPaths.map((path) => readExcerpt(path, Number.MAX_SAFE_INTEGER, MANIFEST_MAX_CHARS))),
  ]);

  const manifests: RepoContext['manifests'] = [];
  manifestPaths.forEach((path, index) => {
    const excerpt = manifestExcerpts[index];
    if (excerpt) manifests.push({ path, excerpt });
  });

  return { tree, treeTruncated: truncated || input.pathsTruncated, readmeExcerpt, manifests };
}
