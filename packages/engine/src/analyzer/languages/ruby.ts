// biome-ignore-all lint/suspicious/noAssignInExpressions: regex matches are assigned in the condition so the else-if chain stays flat
/** Ruby, with the routes of a `routes.rb`. */
import { dirname, joinPosix, normalizePosix } from '../../core/posix.ts';
import type { RawSymbol } from '../symbol-types.ts';
import { HASH_COMMENTS, matchAll, packageRootOf, symbolEmitter } from './shared.ts';
import type { ImportOf, ImportSupport, LanguageSupport } from './types.ts';

const RB_DEF = /^(\s*)def\s+(self\.)?(\w+[?!=]?)/;
const RB_CLASS = /^(\s*)(class|module)\s+([A-Z][\w:]*)/;
const RB_ROUTE = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/;

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').length;

function rubyEnd(lines: readonly string[], i: number, indent: number): number {
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j] ?? '';
    if (l.trim() === '') continue;
    const ind = indentOf(l);
    if (ind === indent && /^end\b/.test(l.trim())) return j;
    if (ind < indent) return j - 1;
  }
  return i;
}

function detectRuby(lines: readonly string[], path: string): RawSymbol[] {
  const { symbols, emit } = symbolEmitter(lines);
  const isRoutes = /(^|\/)routes\.rb$/.test(path);
  const stack: { name: string; indent: number; end: number; visibility: string }[] = [];
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = indentOf(line);
    let top = stack.at(-1);
    while (top && i > top.end) {
      stack.pop();
      top = stack.at(-1);
    }
    if (isRoutes) {
      const route = RB_ROUTE.exec(line);
      if (route) {
        const [, verb = '', target = ''] = route;
        emit(`${verb.toUpperCase()} ${target}`, 'route', i);
      }
    }
    if (top && indent === top.indent + 2 && /^(private|protected|public)$/.test(t)) {
      top.visibility = t;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = RB_CLASS.exec(line))) {
      const [, , keyword = '', local = ''] = m;
      const end = rubyEnd(lines, i, indent);
      const name = top ? `${top.name}::${local}` : local;
      emit(name, keyword === 'module' ? 'other' : 'class', i, { end });
      stack.push({ name, indent, end, visibility: 'public' });
    } else if ((m = RB_DEF.exec(line))) {
      const [, , self, local = ''] = m;
      const end = rubyEnd(lines, i, indent);
      if (top && indent > top.indent) {
        emit(`${top.name}.${local}`, 'method', i, { exported: top.visibility === 'public' || !!self, end });
      } else if (!top) {
        emit(local, 'function', i, { end });
      }
    }
  }
  return symbols;
}

function extractImports(text: string): ImportOf<'rb'>[] {
  const refs: ImportOf<'rb'>[] = [];
  for (const [, file = ''] of matchAll(text, /^\s*require_relative\s+['"]([^'"\n]+)['"]/gm)) {
    refs.push({ lang: 'rb', spec: `./${file}` });
  }
  for (const [, spec = ''] of matchAll(text, /^\s*require\s+['"]([^'"\n]+)['"]/gm)) {
    refs.push({ lang: 'rb', spec });
  }
  return refs;
}

const IMPORTS: ImportSupport<ImportOf<'rb'>> = {
  lang: 'rb',
  extract: extractImports,
  resolve(importer, { spec }, index) {
    const file = spec.endsWith('.rb') ? spec : `${spec}.rb`;
    if (spec.startsWith('.')) {
      const p = normalizePosix(joinPosix(dirname(importer), file));
      return p ? [p] : [];
    }
    const hit = index.firstKnown([
      `lib/${file}`,
      file,
      `app/${file}`,
      `${packageRootOf(importer)}/lib/${file}`,
    ]);
    return hit ? [hit] : [];
  },
};

export const RUBY: readonly LanguageSupport[] = [
  { extensions: ['.rb'], symbols: detectRuby, imports: IMPORTS, comments: HASH_COMMENTS },
];
