// biome-ignore-all lint/suspicious/noAssignInExpressions: regex matches are assigned in the condition so the else-if chain stays flat
/** Rust, with the routes of `#[get("/x")]` attributes and axum's `.route("/x", get(handler))`. */
import { basename, dirname, joinPosix } from '../../core/posix.ts';
import { blockEnd, nestingDepths, type ScanProfile } from '../scan.ts';
import type { RawSymbol } from '../symbol-types.ts';
import { C_COMMENTS, matchAll, packageRootOf, symbolEmitter } from './shared.ts';
import type { ImportIndex, ImportOf, ImportSupport, LanguageSupport } from './types.ts';

const PROFILE: ScanProfile = { lineComments: ['//'], blockComments: true, rustLifetimes: true };

const PUB = '(pub(?:\\([^)]*\\))?\\s+)?';
const RS_FN = new RegExp(`^${PUB}(?:(?:async|unsafe|const|default)\\s+|extern\\s+"[^"]*"\\s+)*fn\\s+(\\w+)`);
const RS_ADT = new RegExp(`^${PUB}(struct|enum|trait|union)\\s+(\\w+)`);
const RS_TYPE = new RegExp(`^${PUB}type\\s+(\\w+)`);
const RS_CONST = new RegExp(`^${PUB}(?:const|static)\\s+(?:mut\\s+)?(\\w+)\\s*:`);
const RS_ATTR_ROUTE = /^#\[(get|post|put|patch|delete|head|options)\(\s*"([^"]*)"/;
const RS_AXUM = /\.route\(\s*"([^"]*)"\s*,\s*(get|post|put|patch|delete)\(/;

/** Type name and trait-impl flag of an `impl` header line, or null when the line is not one. */
function rustImpl(line: string): { type: string; viaTrait: boolean } | null {
  if (!/^impl\b/.test(line)) return null;
  let head = line
    .replace(/\{.*$/, '')
    .replace(/^impl\b/, '')
    .trim();
  if (head.startsWith('<')) {
    let depth = 0;
    let end = 0;
    for (let k = 0; k < head.length; k++) {
      if (head[k] === '<') depth++;
      else if (head[k] === '>' && --depth === 0) {
        end = k + 1;
        break;
      }
    }
    head = head.slice(end).trim();
  }
  const viaTrait = /\sfor\s/.test(head);
  const typePart = viaTrait ? head.slice(head.search(/\sfor\s/) + 5) : head;
  const type = /^[&\s]*(?:mut\s+)?([\w:]+)/.exec(typePart)?.[1];
  return type ? { type: type.split('::').pop() ?? type, viaTrait } : null;
}

function detectRust(lines: readonly string[]): RawSymbol[] {
  const depths = nestingDepths(lines, PROFILE);
  const { symbols, emit } = symbolEmitter(lines, depths);
  let block: { type: string; viaTrait: boolean; end: number; trait: boolean } | null = null;
  let pending: string | null = null;
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t || t.startsWith('//')) continue;
    const axum = RS_AXUM.exec(t);
    if (axum) {
      const [, path = '', verb = ''] = axum;
      emit(`${verb.toUpperCase()} ${path}`, 'route', i);
    }
    if (block && i > block.end) block = null;
    const attr = RS_ATTR_ROUTE.exec(t);
    if (attr) {
      const [, verb = '', path = ''] = attr;
      pending = `${verb.toUpperCase()} ${path}`;
      continue;
    }
    let m: RegExpExecArray | null;
    if (depths[i] === 0) {
      const impl = rustImpl(t);
      if (impl) {
        block = { ...impl, end: blockEnd(depths, i, lines.length), trait: false };
        continue;
      }
      if ((m = RS_ADT.exec(t))) {
        const [, pub, keyword = '', name = ''] = m;
        const end = blockEnd(depths, i, lines.length);
        const kind = keyword === 'trait' ? 'interface' : keyword === 'enum' ? 'type' : 'class';
        emit(name, kind, i, { exported: !!pub, end });
        if (keyword === 'trait') block = { type: name, viaTrait: false, end, trait: true };
      } else if ((m = RS_FN.exec(t))) {
        const [, pub, name = ''] = m;
        if (pending) emit(pending, 'route', i);
        else emit(name, 'function', i, { exported: !!pub });
        pending = null;
      } else if ((m = RS_TYPE.exec(t))) {
        const [, pub, name = ''] = m;
        emit(name, 'type', i, { exported: !!pub });
      } else if ((m = RS_CONST.exec(t))) {
        const [, pub, name = ''] = m;
        emit(name, 'constant', i, { exported: !!pub });
      }
    } else if (block && depths[i] === 1 && (m = RS_FN.exec(t))) {
      const [, pub, name = ''] = m;
      if (pending) emit(pending, 'route', i);
      else emit(`${block.type}.${name}`, 'method', i, { exported: !!pub || block.viaTrait || block.trait });
      pending = null;
    }
  }
  return symbols;
}

function extractImports(text: string): ImportOf<'rs'>[] {
  const refs: ImportOf<'rs'>[] = [];
  for (const [, spec = ''] of matchAll(text, /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) {
    refs.push({ lang: 'rs', spec, isMod: true });
  }
  for (const [, spec = ''] of matchAll(text, /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/gm)) {
    refs.push({ lang: 'rs', spec, isMod: false });
  }
  return refs;
}

function resolveImport(importer: string, ref: ImportOf<'rs'>, index: ImportIndex): string[] {
  const root = packageRootOf(importer);
  const crateSrc = joinPosix(root, 'src');
  const toFiles = (dir: string, parts: string[]): string[] => {
    const out: string[] = [];
    for (let n = parts.length; n >= 1; n--) {
      const base = joinPosix(dir, ...parts.slice(0, n));
      out.push(`${base}.rs`, `${base}/mod.rs`);
    }
    return out;
  };
  const pick = (candidates: string[], fallbackDir: string, name: string | undefined): string[] => {
    const hit = index.firstKnown(candidates);
    if (hit) return [hit];
    return name ? [joinPosix(fallbackDir, `${name}.rs`)] : [];
  };
  if (ref.isMod) {
    const name = basename(importer);
    const dir =
      name === 'lib.rs' || name === 'main.rs' || name === 'mod.rs'
        ? dirname(importer)
        : joinPosix(dirname(importer), name.replace(/\.rs$/, ''));
    return [index.firstKnown(toFiles(dir, [ref.spec])) ?? joinPosix(dir, `${ref.spec}.rs`)];
  }
  const parts = ref.spec.split('::').filter(Boolean);
  const head = parts[0];
  if (head === 'crate') return pick(toFiles(crateSrc, parts.slice(1)), crateSrc, parts[1]);
  if (head === 'super')
    return pick(toFiles(dirname(dirname(importer)), parts.slice(1)), dirname(dirname(importer)), parts[1]);
  if (head && index.known.size > 0) {
    for (const p of index.known) {
      const crate = /^(?:crates|packages|libs)\/([^/]+)\/Cargo\.toml$/.exec(p)?.[1];
      if (crate?.replace(/-/g, '_') === head) {
        const src = `${p.split('/').slice(0, 2).join('/')}/src`;
        return pick(toFiles(src, parts.slice(1)), src, parts[1]);
      }
    }
  }
  return [];
}

const IMPORTS: ImportSupport<ImportOf<'rs'>> = {
  lang: 'rs',
  extract: extractImports,
  resolve: resolveImport,
};

export const RUST: readonly LanguageSupport[] = [
  { extensions: ['.rs'], symbols: detectRust, imports: IMPORTS, comments: C_COMMENTS },
];
