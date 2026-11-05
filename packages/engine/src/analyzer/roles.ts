/** File role detection from the path (and, for SQL, from the changed text). */

import { basename, extname } from '../core/posix.ts';
import type { FileRole } from '../core/types.ts';

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
  'gemfile.lock',
  'composer.lock',
  'pipfile.lock',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
  'podfile.lock',
  'deno.lock',
  'packages.lock.json',
]);

/** Directory names that mark source roots; "build" or "dist" below one of them is real source. */
export const SOURCE_ROOTS = new Set(['src', 'lib', 'app', 'internal', 'pkg', 'cmd', 'source']);

const GENERATED_PATTERNS: RegExp[] = [
  /\.min\.[a-z0-9]+$/i,
  /\.generated\.[a-z0-9]+$/i,
  /(^|\/)__generated__\//,
  /\.pb\.(go|ts|js|cc|h)$/,
  /_pb2(_grpc)?\.pyi?$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /\.map$/,
  /(^|\/)(node_modules|vendor|third_party|\.next|\.nuxt|\.turbo|coverage)\//,
];

const CI_PATTERNS: RegExp[] = [
  /(^|\/)\.github\/(workflows|actions)\//,
  /(^|\/)\.github\/(dependabot|renovate)\.ya?ml$/,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)\.gitlab\/ci\//,
  /(^|\/)\.circleci\//,
  /(^|\/)jenkinsfile/i,
  /(^|\/)azure-pipelines\.ya?ml$/,
  /(^|\/)\.travis\.ya?ml$/,
  /(^|\/)bitbucket-pipelines\.ya?ml$/,
  /(^|\/)\.buildkite\//,
  /(^|\/)\.drone\.ya?ml$/,
  /(^|\/)cloudbuild\.ya?ml$/,
];

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'go.mod',
  'cargo.toml',
  'gemfile',
  'pom.xml',
  'composer.json',
  'pipfile',
]);

const BUILD_NAME =
  /^(dockerfile(\..+)?|.+\.dockerfile|makefile|gnumakefile|.+\.mk|cmakelists\.txt|justfile|rakefile|taskfile\.ya?ml|earthfile)$/i;
const BUILD_CONFIG = /^(vite|webpack|rollup|esbuild|tsup|rspack|parcel|snowpack)\.config\.[a-z]+$/i;
const BUILD_OTHER =
  /^(build|settings)\.gradle(\.kts)?$|^(docker-)?compose(\.[\w-]+)?\.ya?ml$|^(turbo|nx|lerna)\.json$/i;

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc', '.org']);
const DOC_NAME =
  /^(readme|license|licence|copying|changelog|changes|history|contributing|authors|notice|code_of_conduct)(\..*)?$/i;

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.tiff',
  '.svg',
  '.psd',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.mov',
  '.avi',
  '.m4a',
  '.flac',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.jar',
  '.wasm',
]);

const TEST_SEGMENTS = new Set([
  '__tests__',
  '__mocks__',
  'tests',
  'test',
  'spec',
  'specs',
  'e2e',
  'testdata',
]);
const TEST_NAME_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.[a-z0-9]+$/i,
  /_spec\.rb$/,
  /(^|\/)conftest\.py$/,
  /(Test|Tests|IT)\.(java|kt|cs|scala|php)$/,
];

const MIGRATION_SEGMENT = /(^|\/)(migrations?|migrate|alembic|liquibase|flyway)\//;
const MIGRATION_EXTENSIONS = new Set([
  '.sql',
  '.py',
  '.ts',
  '.js',
  '.rb',
  '.go',
  '.java',
  '.kt',
  '.xml',
  '.yml',
  '.yaml',
]);
const SQL_SCHEMA_VERBS =
  /\b(create\s+(table|index|unique\s+index|schema|type|view|extension)|alter\s+table|drop\s+(table|column|index|schema|view|type)|add\s+column|rename\s+(column|to)|truncate)\b/i;

const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties']);
const CONFIG_NAME =
  /^(tsconfig[\w.-]*\.json|jsconfig[\w.-]*\.json|biome\.jsonc?|\.?eslintrc[\w.]*|\.?prettierrc[\w.]*|eslint\.config\.[a-z]+|prettier\.config\.[a-z]+|codeowners|.+\.config\.[a-z]+|.+rc\.(json|ya?ml|js|cjs))$/i;

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.pyi',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  '.cs',
  '.fs',
  '.vb',
  '.rb',
  '.php',
  '.swift',
  '.m',
  '.mm',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hh',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.lua',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.hs',
  '.ml',
  '.clj',
  '.cljs',
  '.elm',
  '.r',
  '.jl',
  '.vue',
  '.svelte',
  '.astro',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.html',
  '.htm',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.tf',
  '.hcl',
  '.nix',
  '.zig',
  '.sol',
  '.prisma',
]);

function isGenerated(path: string): boolean {
  if (GENERATED_PATTERNS.some((p) => p.test(path))) return true;
  const segments = path.split('/');
  const idx = segments.findIndex((s, i) => i < segments.length - 1 && (s === 'dist' || s === 'build'));
  return idx >= 0 && !segments.slice(0, idx).some((s) => SOURCE_ROOTS.has(s));
}

function isTest(path: string): boolean {
  if (TEST_NAME_PATTERNS.some((p) => p.test(path))) return true;
  const dirs = path.split('/').slice(0, -1);
  return dirs.some((d) => TEST_SEGMENTS.has(d.toLowerCase()));
}

/**
 * Classify a changed file by its path. `changedText` (added and removed lines) is only used to tell
 * SQL schema changes from plain queries.
 */
export function detectRole(path: string, changedText = ''): FileRole {
  const name = basename(path);
  const lower = name.toLowerCase();
  const ext = extname(path);

  if (LOCKFILE_NAMES.has(lower)) return 'lockfile';
  if (isGenerated(path)) return 'generated';
  if (CI_PATTERNS.some((p) => p.test(path))) return 'ci';
  if (
    MANIFEST_NAMES.has(lower) ||
    /^requirements([-_.][\w.-]+)?\.txt$/.test(lower) ||
    /(^|\/)requirements\/[^/]+\.txt$/.test(path)
  ) {
    return 'dependency-manifest';
  }
  if (BUILD_NAME.test(name) || BUILD_CONFIG.test(name) || BUILD_OTHER.test(name)) return 'build';
  if (DOC_EXTENSIONS.has(ext) || DOC_NAME.test(name)) return 'docs';
  if (ASSET_EXTENSIONS.has(ext)) return 'asset';
  if (isTest(path)) return 'test';
  if (MIGRATION_SEGMENT.test(path) && MIGRATION_EXTENSIONS.has(ext)) return 'migration';
  if (ext === '.sql' && SQL_SCHEMA_VERBS.test(changedText)) return 'migration';
  if (/(^|\/)(docs?|documentation)\//i.test(path)) return 'docs';
  if (
    name.startsWith('.') ||
    CONFIG_NAME.test(name) ||
    CONFIG_EXTENSIONS.has(ext) ||
    (ext === '.json' && !path.includes('/'))
  ) {
    return 'config';
  }
  if (SOURCE_EXTENSIONS.has(ext)) return 'source';
  return 'other';
}

/** How much a role matters when ranking what to explain (0 = never worth explaining). */
export const ROLE_WEIGHT: Record<FileRole, number> = {
  source: 1,
  migration: 0.9,
  config: 0.5,
  ci: 0.5,
  build: 0.5,
  'dependency-manifest': 0.5,
  test: 0.4,
  other: 0.3,
  docs: 0.2,
  asset: 0.1,
  lockfile: 0,
  generated: 0,
};
