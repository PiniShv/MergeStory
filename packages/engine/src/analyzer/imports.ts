/** Import statement parsing and resolution, used to draw component-to-component relationships. */
import { mapLimit } from '../core/concurrency.ts';
import { basename, normalizePosix } from '../core/posix.ts';
import { importSupport, languageSupport } from './languages/index.ts';
import type { ImportIndex, ImportLang, ImportRef } from './languages/types.ts';

const MAX_PARSE_CHARS = 400_000;
const MAX_WORKSPACE_READS = 12;
const WORKSPACE_DIR = /^(packages|apps|services|libs|modules|cmd|crates)\/[^/]+$/;

/** The language of the imports in a file, or null when the analyzer does not read them. */
export function importLang(path: string): ImportLang | null {
  return languageSupport(path)?.imports?.lang ?? null;
}

/** Raw import references found in a file. Only statements that sit outside full-line comments count. */
export function extractImports(path: string, content: string): ImportRef[] {
  const imports = languageSupport(path)?.imports;
  if (!imports) return [];
  return imports.extract(content.length > MAX_PARSE_CHARS ? content.slice(0, MAX_PARSE_CHARS) : content);
}

export interface ResolverOptions {
  /** Every path known to exist at head: changed files plus the repository tree excerpt. */
  knownPaths: Iterable<string>;
  /** Go modules: module path and the directory holding go.mod ("" for the repository root). */
  goModules?: { module: string; dir: string }[];
  /** Workspace package name (package.json "name") to its directory. */
  packageDirs?: Map<string, string>;
}

/** Resolves import references to repository paths, through the language that made them. */
export class ImportResolver implements ImportIndex {
  readonly known: ReadonlySet<string>;
  readonly byBase = new Map<string, string[]>();
  readonly goModules: readonly { module: string; dir: string }[];
  readonly packageDirs: ReadonlyMap<string, string>;

  constructor(options: ResolverOptions) {
    this.known = new Set(options.knownPaths);
    // Longest module path first, so the most specific module wins whatever order they were found in.
    this.goModules = [...(options.goModules ?? [])].sort(
      (a, b) => b.module.length - a.module.length || a.module.localeCompare(b.module),
    );
    this.packageDirs = new Map(
      [...(options.packageDirs ?? new Map<string, string>())].sort(([a], [b]) => a.localeCompare(b)),
    );
    for (const p of this.known) {
      const b = basename(p);
      this.byBase.set(b, [...(this.byBase.get(b) ?? []), p]);
    }
  }

  firstKnown(candidates: readonly string[]): string | null {
    for (const c of candidates) {
      const n = normalizePosix(c);
      if (n !== null && this.known.has(n)) return n;
    }
    return null;
  }

  resolve(importer: string, ref: ImportRef): string[] {
    return importSupport(ref.lang)?.resolve(importer, ref, this) ?? [];
  }
}

export interface ResolverOptionsInput {
  /** Directories of the components of the change; the workspace ones among them are looked at. */
  componentPaths: readonly string[];
  /** Which manifests are worth reading: package.json for "js", go.mod for "go". */
  languages: ReadonlySet<ImportLang>;
  /** A workspace manifest need not be part of the change, so no changed file carries a verdict for it: this decides whether it is asked for at all. */
  isExcluded: (path: string) => boolean;
  /** Reads a file at head; null when it does not exist. */
  readHead: (path: string) => Promise<string | null>;
  concurrency: number;
}

/**
 * Workspace package names and Go modules, read from the manifests of the workspace directories.
 * The results follow the order of the directories, so the same change always resolves the same way;
 * when two workspaces share a package name, the first one keeps it.
 */
export async function loadResolverOptions(
  input: ResolverOptionsInput,
): Promise<Required<Pick<ResolverOptions, 'goModules' | 'packageDirs'>>> {
  const { readHead, concurrency } = input;
  const dirs = input.componentPaths
    .filter((p) => WORKSPACE_DIR.test(p))
    .filter((p) => !input.isExcluded(`${p}/package.json`) && !input.isExcluded(`${p}/go.mod`))
    .slice(0, MAX_WORKSPACE_READS);
  const [names, modules] = await Promise.all([
    input.languages.has('js')
      ? mapLimit(dirs, concurrency, async (dir) => {
          const text = await readHead(`${dir}/package.json`);
          try {
            const name = (JSON.parse(text ?? 'null') as { name?: unknown } | null)?.name;
            return typeof name === 'string' && name ? name : null;
          } catch {
            return null; // not JSON: ignore
          }
        })
      : [],
    input.languages.has('go')
      ? mapLimit(['', ...dirs], concurrency, async (dir) => {
          const text = await readHead(dir ? `${dir}/go.mod` : 'go.mod');
          return text ? (/^module\s+(\S+)/m.exec(text)?.[1] ?? null) : null;
        })
      : [],
  ]);
  const packageDirs = new Map<string, string>();
  names.forEach((name, i) => {
    if (name && !packageDirs.has(name)) packageDirs.set(name, dirs[i] as string);
  });
  const goDirs = ['', ...dirs];
  const goModules = modules.flatMap((module, i) => (module ? [{ module, dir: goDirs[i] as string }] : []));
  return { goModules, packageDirs };
}
