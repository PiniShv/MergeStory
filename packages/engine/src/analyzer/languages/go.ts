// biome-ignore-all lint/suspicious/noAssignInExpressions: regex matches are assigned in the condition so the else-if chain stays flat
/** Go, with the routes of calls such as `r.GET("/users", handler)`. */
import { joinPosix } from '../../core/posix.ts';
import { nestingDepths, type ScanProfile } from '../scan.ts';
import type { RawSymbol } from '../symbol-types.ts';
import { C_COMMENTS, matchAll, symbolEmitter } from './shared.ts';
import type { ImportOf, ImportSupport, LanguageSupport } from './types.ts';

const PROFILE: ScanProfile = { lineComments: ['//'], blockComments: true, backtick: true };

const GO_FUNC = /^func\s+(?:\(\s*(?:\w+\s+)?\*?([\w.]+)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*[[(]/;
const GO_TYPE = /^type\s+(\w+)(?:\[[^\]]*\])?\s+(struct|interface)?/;
const GO_VAR = /^(const|var)\s+(\w+)\b/;
const GO_ROUTE =
  /\b\w+\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Handle|HandleFunc)\(\s*"([^"]*)"/;
const GO_SPACED_ROUTE = /^([A-Z]+)\s+(\/.*)$/;

function detectGo(lines: readonly string[]): RawSymbol[] {
  const depths = nestingDepths(lines, PROFILE);
  const { symbols, emit } = symbolEmitter(lines, depths);
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t || t.startsWith('//')) continue;
    const route = GO_ROUTE.exec(t);
    if (route) {
      const [, verb = '', target = ''] = route;
      const [, spacedMethod, spacedPath] = GO_SPACED_ROUTE.exec(target) ?? [];
      const method = spacedMethod ?? (/^(Handle|HandleFunc)$/.test(verb) ? 'ALL' : verb.toUpperCase());
      const path = spacedPath ?? target;
      if (path.startsWith('/')) emit(`${method} ${path}`, 'route', i);
    }
    if (depths[i] !== 0) continue;
    let m: RegExpExecArray | null;
    if ((m = GO_FUNC.exec(line))) {
      const [, receiver, name = ''] = m;
      const exported = /^[A-Z]/.test(name) && (!receiver || /^[A-Z]/.test(receiver.split('.').pop() ?? ''));
      emit(receiver ? `${receiver}.${name}` : name, receiver ? 'method' : 'function', i, { exported });
    } else if ((m = GO_TYPE.exec(line))) {
      const [, name = '', shape] = m;
      const kind = shape === 'struct' ? 'class' : shape === 'interface' ? 'interface' : 'type';
      emit(name, kind, i, { exported: /^[A-Z]/.test(name) });
    } else if ((m = GO_VAR.exec(line))) {
      const [, , name = ''] = m;
      emit(name, 'constant', i, { exported: /^[A-Z]/.test(name) });
    }
  }
  return symbols;
}

function extractImports(text: string): ImportOf<'go'>[] {
  const refs: ImportOf<'go'>[] = [];
  for (const block of matchAll(text, /^\s*import\s*\(([\s\S]*?)\)/gm)) {
    const [, body = ''] = block;
    for (const [, spec = ''] of matchAll(body, /"([^"\n]+)"/g)) refs.push({ lang: 'go', spec });
  }
  for (const [, spec = ''] of matchAll(text, /^\s*import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gm)) {
    refs.push({ lang: 'go', spec });
  }
  return refs;
}

const IMPORTS: ImportSupport<ImportOf<'go'>> = {
  lang: 'go',
  extract: extractImports,
  resolve(_importer, { spec }, index) {
    for (const { module, dir } of index.goModules) {
      if (spec === module || spec.startsWith(`${module}/`)) {
        const rest = spec.slice(module.length).replace(/^\//, '');
        return [joinPosix(dir, rest, '_package.go')];
      }
    }
    return [];
  },
};

export const GO: readonly LanguageSupport[] = [
  { extensions: ['.go'], symbols: detectGo, imports: IMPORTS, comments: C_COMMENTS },
];
