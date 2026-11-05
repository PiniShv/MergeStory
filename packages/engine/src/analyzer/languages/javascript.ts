// biome-ignore-all lint/suspicious/noAssignInExpressions: regex matches are assigned in the condition so the else-if chain stays flat
/** JavaScript and TypeScript, and Vue and Svelte components, of which only the imports are read. */
import { dirname, joinPosix, normalizePosix } from '../../core/posix.ts';
import type { SymbolKind } from '../../core/types.ts';
import { blockEnd, nestingDepths, type ScanProfile } from '../scan.ts';
import { collapse, type RawSymbol } from '../symbol-types.ts';
import { C_COMMENTS, matchAll, packageRootOf, symbolEmitter } from './shared.ts';
import type { ImportIndex, ImportOf, ImportSupport, LanguageSupport } from './types.ts';

const PROFILE: ScanProfile = {
  lineComments: ['//'],
  blockComments: true,
  backtick: true,
  templateLiterals: true,
  regexLiterals: true,
};

const JS_FN =
  /^(export\s+)?(default\s+)?(?:declare\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*[<(]/;
const JS_CLASS = /^(export\s+)?(default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const JS_IFACE = /^(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const JS_TYPE = /^(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/;
const JS_ENUM = /^(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const JS_VAR =
  /^(export\s+)?(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::(?:[^=]|=>)+?)?=(?!=)\s*(.*)$/;
const JS_CJS = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;
const JS_DEFAULT_EXPR = /^export\s+default\s+(?:async\s+)?(?:\(|[\w$]+\s*=>)/;
const ARROW =
  /^(?:async\s+)?(?:<[^>]*>\s*)?(?:function\b|[\w$]+\s*=>|\((?:[^()]|\([^()]*\))*\)\s*(?::\s*[^=;{]+?)?\s*=>)/;
const WRAPPED = /^(?:React\.)?(?:memo|forwardRef)\s*\(/;
const JS_METHOD =
  /^((?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare)\s+)*)(\*\s*)?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/;
const JS_PROP_FN =
  /^((?:(?:public|private|protected|static|readonly|override|declare)\s+)*)(#?[A-Za-z_$][\w$]*)\s*[?!]?\s*(?::(?:[^=]|=>)+?)?=(?!=)\s*(?:async\s+)?(?:\(|[\w$]+\s*=>|function)/;
const JS_ROUTE =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|options|head|all)\(\s*(['"`])(\/[^'"`]*|\*)\3/;
const ROUTER_NAME =
  /^(app|router|server|fastify|api|route|routes|r|[\w$]*Router|[\w$]*App|[\w$]*Server|[\w$]*Api)$/;
const NOT_METHODS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'with',
  'else',
  'do',
  'try',
]);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const NEST_ROUTE = /^@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:['"`]([^'"`]*)['"`])?/;
const NEST_CONTROLLER = /^@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/;
const NEXT_APP_ROUTE = /(^|\/)app\/((?:.*\/)?)route\.[mc]?[jt]sx?$/;
const NEXT_PAGES_ROUTE = /(^|\/)pages\/(api\/.*)\.[mc]?[jt]sx?$/;

function joinRoute(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/** Route path of a Next.js route file, or null when the path is not one. */
function nextRoutePath(path: string): { path: string; app: boolean } | null {
  const app = NEXT_APP_ROUTE.exec(path);
  if (app) {
    const [, , dirs = ''] = app;
    return { path: joinRoute(...dirs.split('/').filter((d) => d && !/^\(.*\)$/.test(d))), app: true };
  }
  const pages = NEXT_PAGES_ROUTE.exec(path);
  if (pages) {
    const [, , api = ''] = pages;
    return { path: joinRoute(api.replace(/\/index$/, '')), app: false };
  }
  return null;
}

/**
 * Text that stands for a symbol's signature: the declaration without its body. Interfaces and types
 * use their whole text, because any change to their shape changes what callers can rely on.
 */
function jsDecl(lines: readonly string[], kind: SymbolKind, name: string, from: number, to: number): string {
  if (kind === 'route') return name;
  if (kind === 'interface' || kind === 'type') return collapse(lines.slice(from, to + 1).join(' '), 2000);
  const text = lines
    .slice(from, Math.min(to, from + 6) + 1)
    .map((l) => l.trim())
    .join(' ');
  if (kind === 'constant') return collapse(text.split(/=(?!>)/)[0] ?? '');
  return collapse(cutSignature(text));
}

/** Cut at the first body brace, arrow or semicolon that is not inside parentheses or brackets. */
function cutSignature(text: string): string {
  let depth = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text.charAt(k);
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth <= 0) {
      if (ch === '{' || ch === ';') return text.slice(0, k);
      if (ch === '=' && text.charAt(k + 1) === '>') return text.slice(0, k + 2);
    }
  }
  return text;
}

const CONTINUES_AT_START = /^(?:\?\.|\.(?!\.)|\?|:|&&|\|\||\?\?|\+|-|\||&|,)/;
const CONTINUES_AT_END = /(?:=>|=|&&|\|\||\?\?|\+|-|\?|:|\||&|,|\.)$/;

/**
 * A top-level statement can continue on the next line without opening a bracket: a chained call
 * (".object({"), a leading operator, or an assignment that ends the line with "=".
 */
function extendStatement(lines: readonly string[], depths: readonly number[], end: number): number {
  let e = end;
  for (let guard = 0; guard < 400; guard++) {
    const code = (lines[e] ?? '').replace(/\s\/\/.*$/, '').trimEnd();
    let n = e + 1;
    while (n < lines.length && (lines[n] ?? '').trim() === '') n++;
    if (n >= lines.length || depths[n] !== 0) break;
    const next = (lines[n] ?? '').trim();
    const startsCont = !next.startsWith('//') && !next.startsWith('/*') && CONTINUES_AT_START.test(next);
    if (!startsCont && !CONTINUES_AT_END.test(code)) break;
    e = blockEnd(depths, n, lines.length);
  }
  return e;
}

/** Records a symbol of a JavaScript file from its first to its last line (0-based). */
type Push = (name: string, kind: SymbolKind, exported: boolean, from: number, to: number) => void;

function detectJs(lines: readonly string[], path: string): RawSymbol[] {
  const depths = nestingDepths(lines, PROFILE);
  const { symbols, emit } = symbolEmitter(lines, depths);
  const next = nextRoutePath(path);
  const jsx = /\.(tsx|jsx)$/.test(path);
  // What stands for a symbol's declaration depends on its kind.
  const push: Push = (name, kind, exported, from, to) =>
    emit(name, kind, from, { exported, end: to, decl: jsDecl(lines, kind, name, from, to) });

  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;

    const route = JS_ROUTE.exec(t);
    if (route) {
      const [, router = '', verb = '', , target = ''] = route;
      if (ROUTER_NAME.test(router)) {
        push(`${verb.toUpperCase()} ${target}`, 'route', true, i, blockEnd(depths, i, lines.length));
      }
    }
    if (depths[i] !== 0) continue;

    const end = (): number => blockEnd(depths, i, lines.length);
    const stmtEnd = (): number => extendStatement(lines, depths, end());
    let m: RegExpExecArray | null;
    if ((m = JS_FN.exec(t))) {
      const [, exported, isDefault, , name = 'default'] = m;
      if (next && !next.app && isDefault) {
        push(`ALL ${next.path}`, 'route', true, i, end());
      } else if (next?.app && HTTP_METHODS.has(name)) {
        push(`${name} ${next.path}`, 'route', true, i, end());
      } else {
        const kind = /^[A-Z]/.test(name) && jsx ? 'component' : 'function';
        push(name, kind, !!exported, i, end());
      }
    } else if ((m = JS_CLASS.exec(t))) {
      const [, exported, , name = ''] = m;
      const e = end();
      push(name, 'class', !!exported, i, e);
      jsMethods(lines, depths, i, e, name, !!exported, push);
    } else if ((m = JS_IFACE.exec(t))) {
      const [, exported, name = ''] = m;
      push(name, 'interface', !!exported, i, end());
    } else if ((m = JS_TYPE.exec(t))) {
      const [, exported, name = ''] = m;
      push(name, 'type', !!exported, i, stmtEnd());
    } else if ((m = JS_ENUM.exec(t))) {
      const [, exported, name = ''] = m;
      push(name, 'type', !!exported, i, end());
    } else if ((m = JS_VAR.exec(t))) {
      const [, exported, , name = '', init = ''] = m;
      const e = stmtEnd();
      const rhs = [init, ...lines.slice(i + 1, e + 1)].join(' ').slice(0, 600).trim();
      const isFn = ARROW.test(rhs) || WRAPPED.test(rhs);
      if (next?.app && HTTP_METHODS.has(name) && exported) {
        push(`${name} ${next.path}`, 'route', true, i, e);
      } else if (isFn) {
        const component = WRAPPED.test(rhs) || (/^[A-Z]/.test(name) && jsx);
        push(name, component ? 'component' : 'function', !!exported, i, e);
      } else if (exported || /^[A-Z][A-Z0-9_]+$/.test(name)) {
        push(name, 'constant', !!exported, i, e);
      }
    } else if ((m = JS_CJS.exec(t))) {
      const [, name = '', init = ''] = m;
      const e = stmtEnd();
      const isFn = ARROW.test([init, ...lines.slice(i + 1, e + 1)].join(' ').slice(0, 600).trim());
      push(name, isFn ? 'function' : 'constant', true, i, e);
    } else if (JS_DEFAULT_EXPR.test(t)) {
      push('default', next && !next.app ? 'route' : 'function', true, i, stmtEnd());
    }
  }
  return symbols;
}

function jsMethods(
  lines: readonly string[],
  depths: readonly number[],
  classStart: number,
  classEnd: number,
  className: string,
  classExported: boolean,
  push: Push,
): void {
  let prefix = '';
  for (let k = Math.max(0, classStart - 3); k < classStart; k++) {
    const c = NEST_CONTROLLER.exec((lines[k] ?? '').trim());
    if (c) prefix = c[1] ?? '';
  }
  let pending: { method: string; path: string } | null = null;
  for (let l = classStart + 1; l < classEnd; l++) {
    if (depths[l] !== 1) continue;
    const t = (lines[l] ?? '').trim();
    const nest = NEST_ROUTE.exec(t);
    if (nest) {
      const [, verb = '', path = ''] = nest;
      pending = { method: verb.toUpperCase(), path };
      continue;
    }
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('@')) continue;
    const method = JS_METHOD.exec(t);
    const member = method ?? JS_PROP_FN.exec(t);
    const name = (method ? method[3] : member?.[2]) ?? '';
    if (!member || !name || NOT_METHODS.has(name)) {
      pending = null;
      continue;
    }
    const modifiers = member[1] ?? '';
    const isPrivate = /\b(private|protected)\b/.test(modifiers) || name.startsWith('#');
    const e = blockEnd(depths, l, lines.length);
    if (pending) {
      push(`${pending.method} ${joinRoute(prefix, pending.path)}`, 'route', true, l, e);
      pending = null;
    } else {
      push(`${className}.${name}`, 'method', classExported && !isPrivate, l, e);
    }
  }
}

const IMPORT_PATTERNS = [
  /^\s*(?:import|export)\s+(?:type\s+)?[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]/gm,
  /^\s*import\s*['"]([^'"\n]+)['"]/gm,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** True when the text before `index` on its line shows that the statement sits in a comment. */
function inLineComment(text: string, index: number): boolean {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(start, index).trimStart();
  return prefix.startsWith('//') || prefix.startsWith('*');
}

function extractImports(text: string): ImportOf<'js'>[] {
  const refs: ImportOf<'js'>[] = [];
  for (const re of IMPORT_PATTERNS) {
    for (const m of matchAll(text, re)) {
      const [, spec = ''] = m;
      if (!inLineComment(text, m.index)) refs.push({ lang: 'js', spec });
    }
  }
  return refs;
}

const JS_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.vue',
  '.svelte',
];

function jsCandidates(base: string): string[] {
  const stem = base.replace(/\.(m|c)?js$/, '');
  const list = [base, ...JS_EXTENSIONS.map((e) => base + e)];
  if (stem !== base) list.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => stem + e));
  list.push(...JS_EXTENSIONS.map((e) => `${base}/index${e}`));
  return list;
}

function resolveImport(importer: string, { spec }: ImportOf<'js'>, index: ImportIndex): string[] {
  const root = packageRootOf(importer);
  let base: string | null = null;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    base = normalizePosix(joinPosix(dirname(importer), spec));
  } else if (spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('#')) {
    const rest = spec.replace(/^(@\/|~\/|#\/?)/, '');
    const hit = index.firstKnown([
      ...jsCandidates(joinPosix(root, 'src', rest)),
      ...jsCandidates(joinPosix(root, rest)),
    ]);
    return hit ? [hit] : [joinPosix(root, 'src', rest)];
  } else {
    for (const [name, dir] of index.packageDirs) {
      if (spec === name || spec.startsWith(`${name}/`)) {
        const sub = spec.slice(name.length).replace(/^\//, '');
        const hit = index.firstKnown(jsCandidates(joinPosix(dir, 'src', sub || 'index')));
        return [hit ?? joinPosix(dir, 'src', sub || 'index')];
      }
    }
    return [];
  }
  if (base === null) return [];
  const hit = index.firstKnown(jsCandidates(base));
  return [hit ?? base];
}

const IMPORTS: ImportSupport<ImportOf<'js'>> = {
  lang: 'js',
  extract: extractImports,
  resolve: resolveImport,
};

export const JAVASCRIPT: readonly LanguageSupport[] = [
  {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    symbols: detectJs,
    imports: IMPORTS,
    comments: C_COMMENTS,
    looseSyntax: true,
  },
  // Single-file components: their imports are read, their declarations are not.
  { extensions: ['.vue', '.svelte'], imports: IMPORTS, comments: C_COMMENTS },
];
