// biome-ignore-all lint/suspicious/noAssignInExpressions: regex matches are assigned in the condition so the else-if chain stays flat
/**
 * Java and Kotlin, and C#, whose declarations look alike (types, members, annotations or attributes
 * that name a route). C# has no import support.
 */
import { blockEnd, nestingDepths, type ScanProfile } from '../scan.ts';
import { C_COMMENTS, matchAll, symbolEmitter } from './shared.ts';
import type { ImportOf, ImportSupport, LanguageSupport, SymbolDetector } from './types.ts';

const PROFILE: ScanProfile = { lineComments: ['//'], blockComments: true, tripleQuotes: true };

const JVM_TYPE =
  /^(?:@\w+(?:\([^)]*\))?\s+|\[\w+(?:\([^)]*\))?\]\s*)*((?:(?:public|protected|private|internal|abstract|final|sealed|open|data|static|partial|enum|annotation|value|inner|inline|fun|record|unsafe|new)\s+)*)(class|interface|enum|record|object|struct|trait)\s+(\w+)/;
const JVM_MEMBER =
  /^(?:@\w+(?:\([^)]*\))?\s+|\[[\w.]+(?:\([^)]*\))?\]\s*)*((?:(?:public|protected|private|internal|static|final|abstract|synchronized|native|default|override|virtual|async|sealed|unsafe|extern|new|partial|readonly)\s+)*)(?:<[^>]+>\s+)?(?:([\w.<>,[\]?]+(?:\s*<[^>]*>)?)\s+)?(\w+)\s*\(/;
const KOTLIN_FUN =
  /^(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|private|protected|internal|open|override|abstract|suspend|inline|operator|infix|tailrec|external|final|actual|expect)\s+)*)fun\s+(?:<[^>]+>\s+)?(?:[\w.<>?,\s]+\.)?(\w+)\s*\(/;
const NOT_MEMBERS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'new',
  'throw',
  'else',
  'synchronized',
  'using',
  'lock',
  'foreach',
  'when',
  'try',
]);
const SPRING_ROUTE =
  /^@(Get|Post|Put|Delete|Patch|Request)Mapping(?:\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)")?/;
const ASPNET_ROUTE = /^\[Http(Get|Post|Put|Delete|Patch)(?:\(\s*"([^"]*)"\s*\))?\]/;
const ASPNET_PREFIX = /^\[Route\(\s*"([^"]*)"/;

function annotationRoute(
  lines: readonly string[],
  from: number,
  isType: boolean,
): { method: string; path: string } | null {
  let found: { method: string; path: string } | null = null;
  for (let k = from - 1; k >= Math.max(0, from - 5); k--) {
    const t = (lines[k] ?? '').trim();
    if (!t.startsWith('@') && !t.startsWith('[')) break;
    const spring = SPRING_ROUTE.exec(t);
    if (spring) {
      const [, verb = '', path = ''] = spring;
      found = { method: verb === 'Request' ? 'ALL' : verb.toUpperCase(), path };
    }
    const asp = ASPNET_ROUTE.exec(t);
    if (asp) {
      const [, verb = '', path = ''] = asp;
      found = { method: verb.toUpperCase(), path };
    }
    const prefix = ASPNET_PREFIX.exec(t);
    if (prefix && isType) found = { method: 'ALL', path: prefix[1] ?? '' };
  }
  return found;
}

function routePath(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

function jvmSymbols(dialect: 'java' | 'kotlin' | 'csharp'): SymbolDetector {
  const kotlin = dialect === 'kotlin';
  const csharp = dialect === 'csharp';
  return (lines) => {
    const depths = nestingDepths(lines, PROFILE);
    const { symbols, emit } = symbolEmitter(lines, depths);
    let current: { name: string; depth: number; end: number; exported: boolean; prefix: string } | null =
      null;

    for (const [i, line] of lines.entries()) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (current && i > current.end) current = null;
      const d = depths[i] ?? 0;
      let m: RegExpExecArray | null;
      if (d <= 1 && (m = JVM_TYPE.exec(t))) {
        const [, modifiers = '', keyword = '', name = ''] = m;
        const isPublic =
          csharp || !kotlin
            ? /\bpublic\b/.test(modifiers)
            : !/\b(private|protected|internal)\b/.test(modifiers);
        const kind =
          keyword === 'interface'
            ? 'interface'
            : keyword === 'enum' || /\benum\b/.test(modifiers)
              ? 'type'
              : 'class';
        const end = blockEnd(depths, i, lines.length);
        const typeRoute = annotationRoute(lines, i, true);
        emit(name, kind, i, { exported: isPublic, end });
        if (d === 0 || !current)
          current = { name, depth: d, end, exported: isPublic, prefix: typeRoute?.path ?? '' };
        continue;
      }
      const memberDepth = current ? current.depth + 1 : 0;
      if (d !== memberDepth || (kotlin && !current && d !== 0)) continue;
      let name: string | null = null;
      let exported = false;
      if (kotlin && (m = KOTLIN_FUN.exec(t))) {
        const [, modifiers = '', fn = ''] = m;
        name = fn;
        exported = !/\b(private|protected|internal)\b/.test(modifiers);
      } else if (!kotlin && current && (m = JVM_MEMBER.exec(t))) {
        const [, modifiers = '', type, candidate = ''] = m;
        const before = t.slice(0, t.indexOf('('));
        if (
          NOT_MEMBERS.has(candidate) ||
          before.includes('=') ||
          (!modifiers.trim() && !type && candidate !== current.name)
        )
          continue;
        if (type && NOT_MEMBERS.has(type)) continue;
        name = candidate;
        exported = /\bpublic\b/.test(modifiers);
      }
      if (!name) continue;
      const route = annotationRoute(lines, i, false);
      if (route && current) {
        emit(`${route.method} ${routePath(current.prefix, route.path)}`, 'route', i);
      } else {
        emit(current ? `${current.name}.${name}` : name, current ? 'method' : 'function', i, {
          exported: exported && (!current || current.exported),
        });
      }
    }
    return symbols;
  };
}

function extractImports(text: string): ImportOf<'jvm'>[] {
  const pattern = /^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;?[ \t]*$/gm;
  return matchAll(text, pattern).map(([, spec = '']) => ({ lang: 'jvm', spec }));
}

// Java and Kotlin share their import syntax and their file layout.
const IMPORTS: ImportSupport<ImportOf<'jvm'>> = {
  lang: 'jvm',
  extract: extractImports,
  resolve(_importer, { spec }, index) {
    const parts = spec.split('.');
    for (let n = parts.length; n >= 2; n--) {
      const rel = parts.slice(0, n).join('/');
      for (const ext of ['.java', '.kt']) {
        const name = `${parts[n - 1]}${ext}`;
        const hit = (index.byBase.get(name) ?? []).find(
          (p) => p === `${rel}${ext}` || p.endsWith(`/${rel}${ext}`),
        );
        if (hit) return [hit];
      }
    }
    return [];
  },
};

export const JVM: readonly LanguageSupport[] = [
  { extensions: ['.java'], symbols: jvmSymbols('java'), imports: IMPORTS, comments: C_COMMENTS },
  { extensions: ['.kt', '.kts'], symbols: jvmSymbols('kotlin'), imports: IMPORTS, comments: C_COMMENTS },
  { extensions: ['.cs'], symbols: jvmSymbols('csharp'), comments: C_COMMENTS },
];
