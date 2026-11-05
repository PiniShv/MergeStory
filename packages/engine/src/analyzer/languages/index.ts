/**
 * The languages the analyzer reads, and what it knows about each: how to find declarations, how to
 * read and resolve imports, how a comment starts and whether indentation carries meaning. A file
 * gets the support of the language that lists its name or extension.
 */
import { basename, extname } from '../../core/posix.ts';
import { GO } from './go.ts';
import { JAVASCRIPT } from './javascript.ts';
import { JVM } from './jvm.ts';
import { OTHERS } from './others.ts';
import { PHP } from './php.ts';
import { PYTHON } from './python.ts';
import { RUBY } from './ruby.ts';
import { RUST } from './rust.ts';
import type { ImportLang, ImportSupport, LanguageSupport } from './types.ts';

const LANGUAGES: readonly LanguageSupport[] = [
  ...JAVASCRIPT,
  ...PYTHON,
  ...GO,
  ...RUST,
  ...JVM,
  ...RUBY,
  ...PHP,
  ...OTHERS,
];

/**
 * The entries by extension and by name. A mistake in an entry would leave a file silently skipped, so
 * it is refused when the module loads: an extension without its dot, a key in upper case (the lookup
 * is in lower case), or one that two entries list.
 */
export function indexLanguages(languages: readonly LanguageSupport[]): {
  byExtension: Map<string, LanguageSupport>;
  byName: Map<string, LanguageSupport>;
} {
  const byExtension = new Map<string, LanguageSupport>();
  const byName = new Map<string, LanguageSupport>();
  const add = (map: Map<string, LanguageSupport>, key: string, language: LanguageSupport): void => {
    if (key !== key.toLowerCase()) throw new Error(`"${key}" must be lower case.`);
    if (map === byExtension && !key.startsWith('.')) throw new Error(`The extension "${key}" needs its dot.`);
    if (map.has(key)) throw new Error(`Two languages list "${key}".`);
    map.set(key, language);
  };
  for (const language of languages) {
    for (const extension of language.extensions) add(byExtension, extension, language);
    for (const name of language.names ?? []) add(byName, name, language);
  }
  return { byExtension, byName };
}

const { byExtension, byName } = indexLanguages(LANGUAGES);

/** The support the analyzer has for a file, from its name or extension; null for a kind it does not know. */
export function languageSupport(path: string): LanguageSupport | null {
  return byName.get(basename(path).toLowerCase()) ?? byExtension.get(extname(path)) ?? null;
}

/** True when the analyzer finds declarations in files like this one. */
export function hasSymbols(path: string): boolean {
  return languageSupport(path)?.symbols !== undefined;
}

/** True when the analyzer reads the imports of files like this one. */
export function hasImports(path: string): boolean {
  return languageSupport(path)?.imports !== undefined;
}

const importsByLang = new Map<ImportLang, ImportSupport>();
for (const language of LANGUAGES) {
  if (language.imports) importsByLang.set(language.imports.lang, language.imports);
}

/** The import support that makes and resolves the imports of a language. */
export function importSupport(lang: ImportLang): ImportSupport | undefined {
  return importsByLang.get(lang);
}
