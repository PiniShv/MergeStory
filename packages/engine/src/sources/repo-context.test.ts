import { describe, expect, it } from 'vitest';
import { createPathPolicy } from '../core/path-policy.ts';
import { buildRepoContext, reduceTree } from './repo-context.ts';

describe('reduceTree', () => {
  it('keeps top-level entries, two directory levels and key files', () => {
    const { tree, truncated } = reduceTree([
      'README.md',
      'package.json',
      'src/index.ts',
      'src/core/types.ts',
      'src/core/deep/very/deep/file.ts',
      'src/util/helpers.ts',
      'packages/engine/package.json',
      'packages/engine/src/a.ts',
      '.github/workflows/ci.yml',
      'docs/guide.md',
    ]);
    expect(truncated).toBe(false);
    expect(tree).toEqual([
      '.github/',
      '.github/workflows/',
      '.github/workflows/ci.yml',
      'README.md',
      'docs/',
      'package.json',
      'packages/',
      'packages/engine/',
      'packages/engine/package.json',
      'src/',
      'src/core/',
      'src/util/',
    ]);
  });

  it('caps the list, keeping top-level entries first, and says so', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `dir${String(i).padStart(2, '0')}/sub/file.txt`);
    paths.push('README.md');
    const { tree, truncated } = reduceTree(paths, { maxEntries: 10 });
    expect(truncated).toBe(true);
    expect(tree).toHaveLength(10);
    expect(tree).toContain('README.md');
    // No second-level directory is listed before the top-level directories that fit.
    expect(tree.some((entry) => entry.split('/').filter(Boolean).length === 2)).toBe(false);
  });

  it('accepts directory entries from a non-recursive listing', () => {
    const { tree } = reduceTree(['src/', 'README.md', 'docs/']);
    expect(tree).toEqual(['README.md', 'docs/', 'src/']);
  });
});

describe('buildRepoContext', () => {
  const privacy = { maskEmails: true };

  it('reads the README and manifests from the top level and masks secrets', async () => {
    const files: Record<string, string> = {
      'README.md': `${Array.from({ length: 100 }, (_, i) => `readme line ${i + 1}`).join('\n')}`,
      'package.json': '{"name":"demo","author":"Jane <jane@example.com>"}',
      'go.mod': 'module example.com/demo\n',
      'sub/package.json': '{"name":"nested"}',
    };
    const reads: string[] = [];
    const context = await buildRepoContext({
      paths: Object.keys(files),
      pathsTruncated: false,
      readHead: async (path) => {
        reads.push(path);
        return files[path] ?? null;
      },
      isProtected: () => false,
      privacy,
    });
    expect(context.readmeExcerpt?.split('\n')).toHaveLength(60);
    expect(context.readmeExcerpt?.startsWith('readme line 1\n')).toBe(true);
    expect(context.manifests.map((m) => m.path)).toEqual(['package.json', 'go.mod']);
    expect(context.manifests[0]!.excerpt).not.toContain('jane@example.com');
    // Only root-level manifests are read.
    expect(reads).not.toContain('sub/package.json');
    expect(context.treeTruncated).toBe(false);
  });

  it('caps the README at 4 KB and manifests at 1.5 KB', async () => {
    const context = await buildRepoContext({
      paths: ['README.md', 'package.json'],
      pathsTruncated: false,
      readHead: async (path) =>
        path === 'README.md' ? `${'x'.repeat(100)}\n`.repeat(50) : `{"a":"${'y'.repeat(5000)}"}`,
      isProtected: () => false,
      privacy,
    });
    expect(context.readmeExcerpt!.length).toBeLessThanOrEqual(4096);
    expect(context.manifests[0]!.excerpt.length).toBeLessThanOrEqual(1536);
  });

  it('masks a secret that the cut would split, in a manifest written on one long line', async () => {
    // The quoted value starts before character 1536 and ends after it.
    const secret = 'Zx9fQw3LmN8pR2vT7yKb';
    const manifest = `{"name":"demo","description":"${'d'.repeat(1482)}","password":"${secret}"}`;
    const context = await buildRepoContext({
      paths: ['package.json'],
      pathsTruncated: false,
      readHead: async () => manifest,
      isProtected: () => false,
      privacy,
    });
    const excerpt = context.manifests[0]!.excerpt;
    expect(excerpt.length).toBeLessThanOrEqual(1536);
    expect(excerpt).toContain('"password":"••••••••"');
    expect(excerpt).not.toContain(secret.slice(0, 6));
  });

  it('prefers README.md, and never lists or reads protected paths', async () => {
    const isProtected = createPathPolicy(['internal/']);
    const reads: string[] = [];
    const context = await buildRepoContext({
      paths: ['README', 'README.md', '.env', 'internal/plan.md', 'src/a.ts', 'keys/server.pem'],
      pathsTruncated: false,
      readHead: async (path) => {
        reads.push(path);
        return `content of ${path}`;
      },
      isProtected,
      privacy,
    });
    expect(context.readmeExcerpt).toBe('content of README.md');
    expect(reads).toEqual(['README.md']);
    expect(context.tree).not.toContain('.env');
    expect(context.tree.some((entry) => entry.startsWith('internal'))).toBe(false);
    expect(context.tree.some((entry) => entry.includes('server.pem'))).toBe(false);
    expect(context.tree).toContain('src/');
  });

  it('survives reading problems and flags a truncated listing', async () => {
    const context = await buildRepoContext({
      paths: ['README.md', 'package.json'],
      pathsTruncated: true,
      readHead: async () => {
        throw new Error('boom');
      },
      isProtected: () => false,
      privacy,
    });
    expect(context.readmeExcerpt).toBeNull();
    expect(context.manifests).toEqual([]);
    expect(context.treeTruncated).toBe(true);
  });
});
