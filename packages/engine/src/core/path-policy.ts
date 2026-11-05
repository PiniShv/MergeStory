/**
 * The path policy: which repository paths are off limits. One set of rules for every check, so a
 * path that `privacy.excludePaths` hides is hidden everywhere.
 *
 * Supported syntax: `*` (any characters except "/"), `**` (any characters including "/", also
 * inside a name, as in "src/**.test.ts"), and `?` (one character except "/"). Everything else
 * matches literally, "[", "]", "!" and "#" included: a privacy list has no comments and no
 * negation, so an entry can only hide paths, never show them.
 *
 * The rules follow .gitignore, so people can predict them:
 * - a pattern without a "/" matches a file or directory name at any depth ("*.pem", "secrets");
 * - a pattern with a "/" at the start or in the middle is relative to the repository root
 *   ("config/*.json", "/build");
 * - a trailing "/" matches a directory and everything inside it, at any depth when it is the only
 *   "/" ("internal/");
 * - "**" followed by "/" at the start of a segment matches zero or more directories;
 * - a match on a directory also covers everything beneath it.
 *
 * This is a privacy control, so it errs on the side of matching more: case is ignored.
 *
 * The sources apply the policy once per changed file and keep the verdict in `ChangedFile.sensitive`
 * (true when the path or the previous path is off limits). Every later stage reads that flag through
 * `isProtectedFile` (or `isShowable` where it also needs text) and never matches the patterns again.
 */
import { isSensitivePath } from './secrets.ts';
import type { ChangedFile } from './types.ts';

/**
 * One step of a compiled pattern. `?` is "one", `*` is "star" (no "/"), "**" is "any", and a
 * "**" followed by "/" at the start of a segment is "dirs": zero or more directories.
 */
type Step =
  | { kind: 'char'; char: string }
  | { kind: 'one' }
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'dirs' };

function parseSteps(glob: string): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      let last = i;
      while (glob[last + 1] === '*') last++;
      if (last === i) {
        steps.push({ kind: 'star' });
      } else if ((i === 0 || glob[i - 1] === '/') && glob[last + 1] === '/') {
        steps.push({ kind: 'dirs' });
        last += 1;
      } else {
        steps.push({ kind: 'any' });
      }
      i = last;
    } else if (char === '?') {
      steps.push({ kind: 'one' });
    } else {
      steps.push({ kind: 'char', char: fold(char) });
    }
  }
  return steps;
}

/** Fold a UTF-16 code unit to one case, so two characters that differ only in case compare equal. */
function fold(char: string): string {
  const upper = char.toUpperCase();
  if (upper.length !== 1) return char;
  if (char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) return char;
  return upper;
}

/**
 * A pattern as a small automaton. Each node reads one character or jumps ahead without reading;
 * "dirs" becomes a jump that may skip the next three nodes: any characters, then "/".
 * Matching tracks every node the pattern could be at, so the time is the pattern length times the
 * path length, however many wildcards the pattern has.
 */
type Node =
  | { kind: 'char'; char: string }
  | { kind: 'one' }
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'slash' }
  | { kind: 'skip'; to: number };

function buildNodes(steps: readonly Step[]): Node[] {
  const nodes: Node[] = [];
  for (const step of steps) {
    if (step.kind === 'dirs') {
      nodes.push({ kind: 'skip', to: nodes.length + 3 }, { kind: 'any' }, { kind: 'slash' });
    } else {
      nodes.push(step);
    }
  }
  return nodes;
}

/** Add every node reachable without reading a character. Jumps only go forward, so one pass is enough. */
function closeOver(nodes: readonly Node[], active: Uint8Array): void {
  for (let i = 0; i < nodes.length; i++) {
    if (!active[i]) continue;
    const node = nodes[i]!;
    if (node.kind === 'skip') {
      active[i + 1] = 1;
      active[node.to] = 1;
    } else if (node.kind === 'star' || node.kind === 'any') {
      active[i + 1] = 1;
    }
  }
}

/** Compile one pattern to a test, or return null for a pattern that names nothing (blank, or only slashes). */
function compileGlob(pattern: string): ((path: string) => boolean) | null {
  let glob = pattern.trim().replace(/\\/g, '/');
  if (!glob) return null;
  glob = glob.replace(/^(?:\.\/)+/, '');
  const directoryOnly = glob.endsWith('/');
  glob = glob.replace(/\/+$/, '');
  if (!glob) return null;
  const anchored = glob.includes('/');
  glob = glob.replace(/^\/+/, '');
  if (!anchored) glob = `**/${glob}`;
  // Repeated "**/" means the same as one.
  glob = glob.replace(/(?:\*{2,}\/)+/g, '**/');
  const nodes = buildNodes(parseSteps(glob));
  const end = nodes.length;

  return (path) => {
    let active = new Uint8Array(end + 1);
    active[0] = 1;
    closeOver(nodes, active);
    // The pattern may end at the end of the path, or before a "/" (then everything beneath matches).
    // A directory-only pattern needs the "/".
    for (let pos = 0; ; pos++) {
      if (active[end] && (pos < path.length ? path[pos] === '/' : !directoryOnly)) return true;
      if (pos === path.length) return false;
      const char = path[pos]!;
      const folded = fold(char);
      const next = new Uint8Array(end + 1);
      let any = false;
      for (let i = 0; i < end; i++) {
        if (!active[i]) continue;
        const node = nodes[i]!;
        switch (node.kind) {
          case 'char':
            if (node.char === folded) next[i + 1] = 1;
            break;
          case 'one':
            if (char !== '/') next[i + 1] = 1;
            break;
          case 'slash':
            if (char === '/') next[i + 1] = 1;
            break;
          case 'star':
            if (char !== '/') next[i] = 1;
            break;
          case 'any':
            next[i] = 1;
            break;
          case 'skip':
            break;
        }
      }
      for (let i = 0; i <= end; i++) if (next[i]) any = true;
      if (!any) return false;
      closeOver(nodes, next);
      active = next;
    }
  };
}

/** Normalise a repository path before matching: POSIX separators and no leading "./". */
function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** Build a matcher that is true when a path matches any of the patterns. */
export function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const tests = patterns.map(compileGlob).filter((t): t is (path: string) => boolean => t !== null);
  if (tests.length === 0) return () => false;
  return (path) => {
    const normalised = normalisePath(path);
    return tests.some((test) => test(normalised));
  };
}

/** True when `path` matches any pattern. Prefer compileGlobs when testing many paths. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return compileGlobs(patterns)(path);
}

/**
 * Build the test that decides whether a path is off limits: built-in sensitive files plus the
 * configured `privacy.excludePaths`. Protected files keep their path and counts in a change
 * set, but their content is never read, shown or sent anywhere.
 */
export function createPathPolicy(excludePaths: readonly string[]): (path: string) => boolean {
  const excluded = compileGlobs(excludePaths);
  return (path) => isSensitivePath(path) || excluded(path);
}

/**
 * True when the content of a changed file is off limits: the source marked it sensitive, or its path
 * or previous path is a built-in sensitive file. The second test repeats what the sources do, so a
 * change set built by hand through the library cannot show a key file by mistake. The configured
 * patterns are matched by the sources only.
 */
export function isProtectedFile(file: Pick<ChangedFile, 'sensitive' | 'path' | 'oldPath'>): boolean {
  return (
    file.sensitive || isSensitivePath(file.path) || (file.oldPath !== null && isSensitivePath(file.oldPath))
  );
}

/** True when the content of a changed file may be shown in a video or sent to a provider. */
export function isShowable(file: Pick<ChangedFile, 'binary' | 'sensitive' | 'path' | 'oldPath'>): boolean {
  return !file.binary && !isProtectedFile(file);
}
