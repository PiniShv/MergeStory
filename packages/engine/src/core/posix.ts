/**
 * Paths. The first group works on the paths of files in a repository, which are always written with
 * "/" (git and the GitHub API do so on every system). The last one compares paths of the machine.
 */
import { isAbsolute, relative, sep } from 'node:path';

/** The folder part of a repository path; empty for a file at the top. */
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** The last part of a repository path. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Lower-case extension including the dot; empty for files without one and for dotfiles such as ".gitignore". */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** Resolve "." and ".." segments of a POSIX path. Returns null when the path escapes the root. */
export function normalizePosix(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

/** Join path parts with "/", skipping empty ones. */
export function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

/** true when `target` is `root` or lies below it. Both must already be real paths. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
