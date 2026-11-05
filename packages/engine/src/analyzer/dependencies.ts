/** Dependency changes read from manifest files at base and head. */

import { basename } from '../core/posix.ts';
import type { ChangedFile, DependencyChange } from '../core/types.ts';

export interface DependencyEntry {
  name: string;
  version: string;
  dev: boolean;
}

type Ecosystem = DependencyChange['ecosystem'];
type ManifestKind =
  | 'package.json'
  | 'composer'
  | 'requirements'
  | 'go.mod'
  | 'cargo'
  | 'pyproject'
  | 'pipfile'
  | 'gemfile'
  | 'pom';

/** A requirements file for development: the file name says so, or it sits in a requirements/ folder. */
const DEV_REQUIREMENTS =
  /(?:^|\/)requirements[-_.]?(?:dev|test)[^/]*\.txt$|(?:^|\/)requirements\/(?:dev|test)[^/]*$/i;

const MANIFEST_KINDS: Record<
  ManifestKind,
  { ecosystem: Ecosystem; parse: (content: string, path: string) => DependencyEntry[] }
> = {
  'package.json': {
    ecosystem: 'npm',
    parse: (c) =>
      parsePackageJson(c, [
        ['dependencies', false],
        ['optionalDependencies', false],
        ['peerDependencies', false],
        ['devDependencies', true],
      ]),
  },
  composer: {
    ecosystem: 'other',
    parse: (c) =>
      parsePackageJson(c, [
        ['require', false],
        ['require-dev', true],
      ]),
  },
  requirements: { ecosystem: 'pypi', parse: (c, p) => parseRequirements(c, DEV_REQUIREMENTS.test(p)) },
  'go.mod': { ecosystem: 'go', parse: parseGoMod },
  cargo: { ecosystem: 'cargo', parse: parseCargo },
  pyproject: { ecosystem: 'pypi', parse: parsePyproject },
  pipfile: { ecosystem: 'pypi', parse: parsePipfile },
  gemfile: { ecosystem: 'rubygems', parse: parseGemfile },
  pom: { ecosystem: 'maven', parse: parsePom },
};

export function manifestKind(path: string): ManifestKind | null {
  const name = basename(path).toLowerCase();
  if (name === 'package.json') return 'package.json';
  if (name === 'composer.json') return 'composer';
  if (/^requirements([-_.][\w.-]+)?\.txt$/.test(name) || /(^|\/)requirements\/[^/]+\.txt$/.test(path))
    return 'requirements';
  if (name === 'go.mod') return 'go.mod';
  if (name === 'cargo.toml') return 'cargo';
  if (name === 'pyproject.toml') return 'pyproject';
  if (name === 'pipfile') return 'pipfile';
  if (name === 'gemfile') return 'gemfile';
  if (name === 'pom.xml') return 'pom';
  return null;
}

function parsePackageJson(content: string, sections: [string, boolean][]): DependencyEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object') return [];
  const seen = new Set<string>();
  const out: DependencyEntry[] = [];
  for (const [section, dev] of sections) {
    const table = (json as Record<string, unknown>)[section];
    if (!table || typeof table !== 'object') continue;
    for (const [name, version] of Object.entries(table as Record<string, unknown>)) {
      if (typeof version !== 'string' || name === 'php' || name.startsWith('ext-')) continue;
      const key = `${dev ? 'dev' : 'prod'}:${name}`;
      if (seen.has(key) || (!dev && seen.has(`prod:${name}`))) continue;
      seen.add(key);
      out.push({ name, version, dev });
    }
  }
  return out;
}

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([<>=!~][^;#]*)?/;

function requirementEntry(text: string, dev: boolean): DependencyEntry | null {
  const m = REQUIREMENT.exec(text.trim());
  if (!m) return null;
  const spec = (m[2] ?? '').replace(/\s+/g, '');
  return {
    name: (m[1] as string).toLowerCase().replace(/_/g, '-'),
    version: spec.replace(/^==/, '') || '*',
    dev,
  };
}

function parseRequirements(content: string, dev: boolean): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-') || /^(git\+|https?:|\.|\/)/.test(line))
      continue;
    const entry = requirementEntry(line, dev);
    if (entry) out.push(entry);
  }
  return out;
}

function parseGoMod(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)(.*)$/.exec(line);
    const block = inBlock ? /^(\S+)\s+(v\S+)(.*)$/.exec(line) : null;
    const m = single ?? block;
    if (m && !/\/\/\s*indirect/.test(m[3] as string))
      out.push({ name: m[1] as string, version: m[2] as string, dev: false });
  }
  return out;
}

interface TomlItem {
  table: string;
  key: string;
  value: string;
}

function stripTomlComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function bracketBalance(text: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth;
}

function scanToml(content: string): TomlItem[] {
  const items: TomlItem[] = [];
  const lines = content.split(/\r?\n/);
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i] as string).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = (header[1] as string).replace(/\s+/g, '').replace(/["']/g, '');
      continue;
    }
    const kv = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2] as string;
    while (bracketBalance(value) > 0 && i + 1 < lines.length) {
      i++;
      value += ` ${stripTomlComment(lines[i] as string).trim()}`;
    }
    items.push({ table, key: (kv[1] as string).replace(/["']/g, ''), value: value.trim() });
  }
  return items;
}

function tomlVersion(value: string): string {
  const plain = /^["']([^"']*)["']$/.exec(value);
  if (plain) return plain[1] || '*';
  const v = /\bversion\s*=\s*["']([^"']*)["']/.exec(value);
  if (v) return v[1] as string;
  if (/\bworkspace\s*=\s*true/.test(value)) return 'workspace';
  if (/\bpath\s*=/.test(value)) return 'path';
  if (/\bgit\s*=/.test(value)) return 'git';
  return '*';
}

function parseCargo(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const { table, key, value } of scanToml(content)) {
    const dev = /dev-dependencies/.test(table);
    if (/(^|\.)(dev-|build-)?dependencies$/.test(table)) {
      const dotted = /^([^.]+)\.workspace$/.exec(key);
      if (dotted) out.push({ name: dotted[1] as string, version: 'workspace', dev });
      else out.push({ name: key, version: tomlVersion(value), dev });
    } else {
      const sub = /^(?:.*\.)?(dev-|build-)?dependencies\.([^.]+)$/.exec(table);
      if (sub && key === 'version')
        out.push({ name: sub[2] as string, version: tomlVersion(value), dev: sub[1] === 'dev-' });
    }
  }
  return out;
}

function arrayEntries(value: string, dev: boolean): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const m of value.matchAll(/["']([^"']+)["']/g)) {
    const entry = requirementEntry(m[1] as string, dev);
    if (entry) out.push(entry);
  }
  return out;
}

function parsePyproject(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const { table, key, value } of scanToml(content)) {
    if (table === 'project' && key === 'dependencies') out.push(...arrayEntries(value, false));
    else if (table === 'project.optional-dependencies')
      out.push(...arrayEntries(value, /dev|test|lint|doc|type/i.test(key)));
    else if (table === 'dependency-groups') out.push(...arrayEntries(value, true));
    else if (table === 'tool.uv' && key === 'dev-dependencies') out.push(...arrayEntries(value, true));
    else if (
      /^tool\.poetry\.(dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/.test(table) &&
      key !== 'python'
    ) {
      out.push({
        name: key.toLowerCase().replace(/_/g, '-'),
        version: tomlVersion(value),
        dev: !/^tool\.poetry\.dependencies$/.test(table),
      });
    }
  }
  return out;
}

function parsePipfile(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const { table, key, value } of scanToml(content)) {
    if (table === 'packages' || table === 'dev-packages') {
      out.push({
        name: key.toLowerCase().replace(/_/g, '-'),
        version: tomlVersion(value).replace(/^==/, ''),
        dev: table === 'dev-packages',
      });
    }
  }
  return out;
}

function parseGemfile(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const groups: boolean[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^group\b.*\bdo\b/.test(line)) {
      groups.push(/:(development|test)\b/.test(line));
      continue;
    }
    if (/^end\b/.test(line) && groups.length > 0) {
      groups.pop();
      continue;
    }
    const gem = /^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(line);
    if (gem) out.push({ name: gem[1] as string, version: gem[2] ?? '*', dev: groups.some(Boolean) });
  }
  return out;
}

function parsePom(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const block of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const text = block[1] as string;
    const tag = (name: string): string | null =>
      new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(text)?.[1] ?? null;
    const group = tag('groupId');
    const artifact = tag('artifactId');
    if (!group || !artifact) continue;
    out.push({ name: `${group}:${artifact}`, version: tag('version') ?? '*', dev: tag('scope') === 'test' });
  }
  return out;
}

type DraftChange = Omit<DependencyChange, 'id'>;

/** Dependency changes in one manifest file. `base` and `head` are file contents (null when absent). */
export function diffManifest(file: ChangedFile, base: string | null, head: string | null): DraftChange[] {
  const kind = manifestKind(file.path);
  if (!kind) return [];
  const { ecosystem, parse } = MANIFEST_KINDS[kind];
  const toMap = (content: string | null, path: string): Map<string, DependencyEntry> => {
    const map = new Map<string, DependencyEntry>();
    if (content === null) return map;
    for (const e of parse(content, path))
      if (!map.has(`${e.dev ? 'dev' : 'prod'}:${e.name}`)) map.set(`${e.dev ? 'dev' : 'prod'}:${e.name}`, e);
    return map;
  };
  const before = toMap(base, file.oldPath ?? file.path);
  const after = toMap(head, file.path);

  const out: DraftChange[] = [];
  const make = (
    change: DraftChange['change'],
    entry: DependencyEntry,
    from: string | null,
    to: string | null,
  ): DraftChange => ({
    ecosystem,
    name: entry.name,
    change,
    from,
    to,
    dev: entry.dev,
    fileId: file.id,
  });
  for (const [key, h] of after) {
    const b = before.get(key);
    if (!b) out.push(make('added', h, null, h.version));
    else if (b.version !== h.version) out.push(make('updated', h, b.version, h.version));
  }
  for (const [key, b] of before) if (!after.has(key)) out.push(make('removed', b, b.version, null));

  // A dependency that moved between dev and prod with the same version is not a change.
  const moved = new Set<string>();
  for (const a of out) {
    if (a.change !== 'added') continue;
    const r = out.find(
      (x) => x.change === 'removed' && x.name === a.name && x.from === a.to && x.dev !== a.dev,
    );
    if (r) {
      moved.add(`added:${a.name}:${a.dev}`);
      moved.add(`removed:${r.name}:${r.dev}`);
    }
  }
  return out
    .filter((c) => !moved.has(`${c.change}:${c.name}:${c.dev}`))
    .sort((a, b) => a.name.localeCompare(b.name) || a.change.localeCompare(b.change));
}
