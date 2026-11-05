// biome-ignore-all lint/suspicious/noAssignInExpressions: regex matches are assigned in the condition so the else-if chain stays flat
/** PHP, with the routes of `Route::get('/x', ...)`. */
import { basename, dirname, joinPosix, normalizePosix } from '../../core/posix.ts';
import { blockEnd, nestingDepths, type ScanProfile } from '../scan.ts';
import type { RawSymbol } from '../symbol-types.ts';
import { C_COMMENTS, matchAll, symbolEmitter } from './shared.ts';
import type { ImportOf, ImportSupport, LanguageSupport } from './types.ts';

const PROFILE: ScanProfile = { lineComments: ['//', '#'], blockComments: true };

const PHP_TYPE = /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/;
const PHP_FUNC = /^((?:(?:public|protected|private|static|final|abstract)\s+)*)function\s+&?(\w+)\s*\(/;
const PHP_ROUTE = /\bRoute::(get|post|put|patch|delete|any|options)\(\s*['"]([^'"]+)['"]/;

function detectPhp(lines: readonly string[]): RawSymbol[] {
  const depths = nestingDepths(lines, PROFILE);
  const { symbols, emit } = symbolEmitter(lines, depths);
  let current: { name: string; end: number } | null = null;
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (current && i > current.end) current = null;
    const route = PHP_ROUTE.exec(t);
    if (route) {
      const [, verb = '', target = ''] = route;
      emit(`${verb === 'any' ? 'ALL' : verb.toUpperCase()} /${target.replace(/^\//, '')}`, 'route', i);
    }
    const d = depths[i] ?? 0;
    let m: RegExpExecArray | null;
    if (d === 0 && (m = PHP_TYPE.exec(t))) {
      const [, keyword = '', name = ''] = m;
      const end = blockEnd(depths, i, lines.length);
      emit(name, keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'type' : 'class', i, { end });
      current = { name, end };
    } else if ((m = PHP_FUNC.exec(t))) {
      const [, modifiers = '', name = ''] = m;
      if (d === 0) emit(name, 'function', i);
      else if (d === 1 && current) {
        emit(`${current.name}.${name}`, 'method', i, {
          exported: !/\b(private|protected)\b/.test(modifiers),
        });
      }
    }
  }
  return symbols;
}

function extractImports(text: string): ImportOf<'php'>[] {
  const refs: ImportOf<'php'>[] = [];
  for (const [, spec = ''] of matchAll(text, /^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/gm)) {
    if (spec !== 'function' && spec !== 'const') refs.push({ lang: 'php', spec });
  }
  const inclusion = /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"\n]+)['"]/g;
  for (const [, file = ''] of matchAll(text, inclusion)) {
    refs.push({ lang: 'php', spec: `./${file.replace(/^\//, '')}` });
  }
  return refs;
}

const IMPORTS: ImportSupport<ImportOf<'php'>> = {
  lang: 'php',
  extract: extractImports,
  resolve(importer, { spec }, index) {
    if (spec.startsWith('.')) {
      const p = normalizePosix(joinPosix(dirname(importer), spec));
      return p ? [p] : [];
    }
    const parts = spec.split('\\').filter(Boolean);
    for (let start = 0; start < parts.length; start++) {
      const rel = `${parts.slice(start).join('/')}.php`;
      if (parts.length - start < 2 && parts.length > 1) break;
      const hit = (index.byBase.get(basename(rel)) ?? []).find(
        (p) => p === rel || p.toLowerCase().endsWith(`/${rel.toLowerCase()}`),
      );
      if (hit) return [hit];
    }
    return [];
  },
};

export const PHP: readonly LanguageSupport[] = [
  { extensions: ['.php'], symbols: detectPhp, imports: IMPORTS, comments: [...C_COMMENTS, '#'] },
];
