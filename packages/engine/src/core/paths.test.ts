import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diskIdentity, isInWorkFolder, sameOnDisk } from './paths.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temporary folder with `a`, `b`, and `link`, a symbolic link to `a`. */
async function folders(): Promise<{ base: string; a: string; b: string; link: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mergestory-paths-')));
  dirs.push(base);
  const [a, b, link] = [join(base, 'a'), join(base, 'b'), join(base, 'link')];
  await mkdir(join(a, 'inner'), { recursive: true });
  await mkdir(b);
  await symlink(a, link);
  return { base, a, b, link };
}

describe('sameOnDisk', () => {
  it('knows one folder under two names, and tells two folders apart', async () => {
    const { a, b, link } = await folders();
    expect(await sameOnDisk(a, link)).toBe(true);
    expect(await sameOnDisk(a, b)).toBe(false);
    expect(await sameOnDisk(a, join(a, 'missing'))).toBe(false);
    expect(await sameOnDisk(join(a, 'missing'), join(a, 'missing'))).toBe(false);
  });

  it('compares real paths where the disk gives no identity', async () => {
    const { a, b, link } = await folders();
    // Some file systems give the same number for every file: then nothing may count as the same by it.
    const none = async (): Promise<null> => null;
    expect(await sameOnDisk(a, link, none)).toBe(true);
    expect(await sameOnDisk(a, b, none)).toBe(false);
    expect(await sameOnDisk(a, join(a, 'missing'), none)).toBe(false);
  });
});

describe('isInWorkFolder', () => {
  it('knows the work folder under a name that no path shows', async () => {
    const { a, b } = await folders();
    // As a second mount point would: `b` is the same folder on disk as the work folder `a`.
    const aliased = async (path: string): Promise<string | null> => diskIdentity(path === b ? a : path);
    expect(await isInWorkFolder(join(b, 'repo', '.git'), a)).toBe(false);
    expect(await isInWorkFolder(join(b, 'repo', '.git'), a, aliased)).toBe(true);
    expect(await isInWorkFolder(b, a, aliased)).toBe(true);
  });

  it('is false when the work folder does not exist, and for a folder next to it', async () => {
    const { base, a, b } = await folders();
    expect(await isInWorkFolder(a, join(base, 'no-work'))).toBe(false);
    expect(await isInWorkFolder(b, a)).toBe(false);
    expect(await isInWorkFolder(base, a)).toBe(false);
  });

  it('is true for the folder, for a path in it, through a link, in another letter case and before it exists', async () => {
    const { base, a, link } = await folders();
    expect(await isInWorkFolder(a, a)).toBe(true);
    expect(await isInWorkFolder(join(a, 'inner'), a)).toBe(true);
    expect(await isInWorkFolder(join(link, 'inner'), a)).toBe(true);
    expect(await isInWorkFolder(join(link, 'not', 'yet'), a)).toBe(true);
    expect(await isInWorkFolder(join(base, 'A', 'inner'), a)).toBe(true);
    expect(await isInWorkFolder(join(base, 'NO-WORK', 'x'), join(base, 'no-work'))).toBe(true);
  });
});
