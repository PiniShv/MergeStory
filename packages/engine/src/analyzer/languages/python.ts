// biome-ignore-all lint/suspicious/noAssignInExpressions: regex matches are assigned in the condition so the else-if chain stays flat
/** Python, with the routes that decorators such as `@app.get("/x")` register. */
import { dirname, joinPosix, normalizePosix } from '../../core/posix.ts';
import { collapse, type RawSymbol } from '../symbol-types.ts';
import { HASH_COMMENTS, matchAll, packageRootOf, symbolEmitter } from './shared.ts';
import type { ImportIndex, ImportOf, ImportSupport, LanguageSupport } from './types.ts';

const PY_DEF = /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_CLASS = /^([ \t]*)class\s+(\w+)/;
const PY_CONST = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\S/;
const PY_ROUTE =
  /^@(\w+)\.(route|get|post|put|patch|delete|head|options|websocket|api_route)\(\s*(['"])([^'"]*)\3([^)]*)/;

function detectPython(lines: readonly string[]): RawSymbol[] {
  const { symbols, emit } = symbolEmitter(lines);
  const indentOf = (l: string): number => (/^[ \t]*/.exec(l)?.[0] ?? '').replace(/\t/g, '    ').length;
  const skippable = (l: string): boolean => l.trim() === '' || l.trim().startsWith('#');
  const endOf = (i: number, ind: number): number => {
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (skippable(l)) continue;
      if (indentOf(l) <= ind) {
        if (/^\s*[)\]}]/.test(l)) {
          last = j;
          continue;
        }
        break;
      }
      last = j;
    }
    return last;
  };
  const header = (i: number): string => {
    let text = '';
    for (let j = i; j < Math.min(lines.length, i + 8); j++) {
      text += ` ${(lines[j] ?? '').trim()}`;
      if ((lines[j] ?? '').trimEnd().endsWith(':')) break;
    }
    return collapse(text);
  };
  const decorators = (i: number): { start: number; route: string | null } => {
    let start = i;
    let route: string | null = null;
    for (let j = i - 1; j >= 0 && (lines[j] ?? '').trim().startsWith('@'); j--) {
      start = j;
      const m = PY_ROUTE.exec((lines[j] ?? '').trim());
      if (m) {
        const [, , verb = '', , path = '', rest = ''] = m;
        const verbs =
          verb === 'route' || verb === 'api_route'
            ? [...(/methods\s*=\s*\[([^\]]*)\]/.exec(rest)?.[1] ?? '').matchAll(/['"](\w+)['"]/g)].map((x) =>
                (x[1] ?? '').toUpperCase(),
              )
            : [verb.toUpperCase()];
        route = `${(verbs.length ? verbs : ['GET']).join(',')} ${path}`;
      }
    }
    return { start, route };
  };

  let currentClass: { name: string; exported: boolean; end: number; body: number } | null = null;
  for (const [i, line] of lines.entries()) {
    if (skippable(line)) continue;
    const ind = indentOf(line);
    if (currentClass && i > currentClass.end) currentClass = null;
    let m: RegExpExecArray | null;
    if ((m = PY_CLASS.exec(line)) && ind === 0) {
      const [, , name = ''] = m;
      const end = endOf(i, 0);
      const { start } = decorators(i);
      const exported = !name.startsWith('_');
      emit(name, 'class', i, { exported, start, end, decl: header(i) });
      let body = ind + 4;
      for (let j = i + 1; j <= end; j++)
        if (!skippable(lines[j] ?? '')) {
          body = indentOf(lines[j] ?? '');
          break;
        }
      currentClass = { name, exported, end, body };
    } else if ((m = PY_DEF.exec(line))) {
      const [, , name = ''] = m;
      const asMethod = currentClass !== null && ind === currentClass.body;
      if (ind !== 0 && !asMethod) continue;
      const end = endOf(i, ind);
      const { start, route } = decorators(i);
      if (route) {
        emit(route, 'route', i, { start, end, decl: header(i) });
      } else if (asMethod && currentClass) {
        emit(`${currentClass.name}.${name}`, 'method', i, {
          exported: currentClass.exported && !name.startsWith('_'),
          start,
          end,
          decl: header(i),
        });
      } else {
        emit(name, 'function', i, { exported: !name.startsWith('_'), start, end, decl: header(i) });
      }
    } else if (ind === 0 && (m = PY_CONST.exec(line))) {
      const [, name = ''] = m;
      emit(name, 'constant', i, { end: endOf(i, 0), decl: collapse(line.split('=')[0] ?? '') });
    }
  }
  return symbols;
}

const FROM_IMPORT = /^[ \t]*from\s+(\.*)([\w.]*)\s+import\s+([^\n#]+)/gm;
const IMPORT = /^[ \t]*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm;

/** The first word of "name as alias". */
const nameOf = (part: string): string => part.trim().split(/\s+as\s+/)[0] ?? '';

function extractImports(text: string): ImportOf<'py'>[] {
  const refs: ImportOf<'py'>[] = [];
  for (const m of matchAll(text, FROM_IMPORT)) {
    const [, dots = '', spec = '', list = ''] = m;
    const names = list
      .replace(/[()\\]/g, ' ')
      .split(',')
      .map(nameOf)
      .filter((n) => /^\w+$/.test(n));
    if (spec || names.length > 0) refs.push({ lang: 'py', spec, dots: dots.length, names });
  }
  for (const m of matchAll(text, IMPORT)) {
    const [, list = ''] = m;
    for (const part of list.split(',')) {
      const spec = nameOf(part);
      if (spec) refs.push({ lang: 'py', spec, dots: 0, names: [] });
    }
  }
  return refs;
}

function resolveImport(importer: string, ref: ImportOf<'py'>, index: ImportIndex): string[] {
  const modulePath = ref.spec.replace(/\./g, '/');
  const roots: string[] = [];
  if (ref.dots > 0) {
    let dir = dirname(importer);
    for (let i = 1; i < ref.dots; i++) dir = dirname(dir);
    roots.push(dir);
  } else {
    const pkg = packageRootOf(importer);
    roots.push('', 'src', pkg, joinPosix(pkg, 'src'), importer.split('/')[0] ?? '');
  }
  const found: string[] = [];
  for (const root of [...new Set(roots)]) {
    const base = joinPosix(root, modulePath);
    const candidates = [
      `${base}.py`,
      `${base}/__init__.py`,
      ...ref.names.flatMap((n) => [`${base}/${n}.py`, `${base}/${n}/__init__.py`]),
    ];
    for (const c of candidates) {
      const n = normalizePosix(c);
      if (n !== null && index.known.has(n)) found.push(n);
    }
    if (found.length > 0) break;
  }
  return [...new Set(found)];
}

const IMPORTS: ImportSupport<ImportOf<'py'>> = {
  lang: 'py',
  extract: extractImports,
  resolve: resolveImport,
};

export const PYTHON: readonly LanguageSupport[] = [
  {
    extensions: ['.py'],
    symbols: detectPython,
    imports: IMPORTS,
    comments: HASH_COMMENTS,
    indentSensitive: true,
  },
  // Type stubs: their declarations and imports are not read.
  { extensions: ['.pyi'], comments: HASH_COMMENTS, indentSensitive: true },
];
