/** What the analyzer knows about a kind of file. Each language module fills in the parts that apply. */
import type { RawSymbol } from '../symbol-types.ts';

/** Finds the declarations of a file. `path` is for the languages whose rules depend on where a file is. */
export type SymbolDetector = (lines: readonly string[], path: string) => RawSymbol[];

/**
 * One import statement, as the language writes it. `spec` is what the statement names: "./a",
 * "com.acme.Foo", "crate::net".
 */
export type ImportRef =
  | { lang: 'js'; spec: string }
  // `dots` counts the leading dots of a relative import; `names` are the names in "from x import a, b".
  | { lang: 'py'; spec: string; dots: number; names: string[] }
  | { lang: 'go'; spec: string }
  // `isMod` is true for a `mod name;` declaration.
  | { lang: 'rs'; spec: string; isMod: boolean }
  | { lang: 'jvm'; spec: string }
  | { lang: 'rb'; spec: string }
  | { lang: 'php'; spec: string };

export type ImportLang = ImportRef['lang'];

/** What a resolver may ask about the repository. */
export interface ImportIndex {
  /** Every path known to exist at head: changed files plus the repository tree excerpt. */
  readonly known: ReadonlySet<string>;
  /** The known paths, by file name. */
  readonly byBase: ReadonlyMap<string, readonly string[]>;
  /** Go modules, longest module path first: the module path and the folder with go.mod ("" at the top). */
  readonly goModules: readonly { module: string; dir: string }[];
  /** Workspace package name (package.json "name") to its directory, in name order. */
  readonly packageDirs: ReadonlyMap<string, string>;
  /** The first candidate that is a known path once normalised, or null when none is. */
  firstKnown(candidates: readonly string[]): string | null;
}

export interface ImportSupport<R extends ImportRef = ImportRef> {
  /** The `lang` of the refs it makes. A ref is resolved by the support that has its `lang`. */
  lang: R['lang'];
  /** The imports in a file's text. Only statements that sit outside full-line comments count. */
  extract(text: string): R[];
  /** The repository paths an import names; none for an external or unknown target. */
  resolve(importer: string, ref: R, index: ImportIndex): string[];
}

/** The import refs of one language. */
export type ImportOf<L extends ImportLang> = Extract<ImportRef, { lang: L }>;

export interface LanguageSupport {
  /** Lower-case extensions with the dot. A file has the support of the one entry that lists its extension. */
  extensions: readonly string[];
  /** Lower-case names of files that have no extension, such as "makefile". */
  names?: readonly string[];
  /** Absent when the analyzer does not read declarations in the language. */
  symbols?: SymbolDetector;
  /** Absent when the analyzer does not read imports in the language. */
  imports?: ImportSupport;
  /** What a full-line comment starts with. Absent when the analyzer does not know the comment syntax. */
  comments?: readonly string[];
  /** Indentation carries meaning, so re-indenting is a real change. */
  indentSensitive?: boolean;
  /** Quote style, semicolons and trailing commas carry no meaning, so changing only those is formatting. */
  looseSyntax?: boolean;
}
