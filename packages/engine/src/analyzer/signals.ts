/** Factual one-line architecture signals derived from the diff. Nothing here is inferred beyond what the files show. */

import { plural } from '../core/text.ts';
import type { Component, DependencyChange, FileRole, FileStatus, SymbolChange } from '../core/types.ts';
import { cleanLabel } from './evidence.ts';
import type { CodeSite } from './risks.ts';

export interface SignalFile {
  fileId: string;
  path: string;
  role: FileRole;
  trivialReason: string | null;
  status: FileStatus;
  oldPath: string | null;
  hidden: boolean;
}

function kindLabel(kind: string): string {
  return kind === 'module' || kind === 'package' || kind === 'service' ? kind : `${kind} module`;
}

function capped(items: string[], max: number, noun: string): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `${items.length - max} more ${noun}`];
}

export function architectureSignals(args: {
  components: readonly Component[];
  files: readonly SignalFile[];
  dependencies: readonly DependencyChange[];
  symbols: readonly SymbolChange[];
  envVars: readonly CodeSite[];
  cliCommands: readonly CodeSite[];
}): string[] {
  const out: string[] = [];
  const text = (value: string, max = 80): string => cleanLabel(value, max);

  const structural = args.components.filter(
    (m) => m.path !== '.' && !['tests', 'docs', 'config'].includes(m.kind),
  );
  for (const m of structural.filter((c) => c.status === 'added')) {
    out.push(`New ${kindLabel(m.kind)} \`${text(m.path)}\` (${plural(m.fileIds.length, 'file')})`);
  }
  for (const m of structural.filter((c) => c.status === 'removed')) {
    out.push(`Deleted ${kindLabel(m.kind)} \`${text(m.path)}\` (${plural(m.fileIds.length, 'file')})`);
  }

  const added = args.dependencies.filter((d) => d.change === 'added');
  for (const d of added.slice(0, 5))
    out.push(`New dependency ${text(d.name, 60)} (${d.ecosystem}${d.dev ? ', dev' : ''})`);
  if (added.length > 5) out.push(`${added.length - 5} more new dependencies`);

  const routes = args.symbols.filter((s) => s.kind === 'route' && s.change === 'added');
  for (const r of routes.slice(0, 6)) out.push(`New HTTP route ${text(r.name, 60)} in ${text(r.path)}`);
  if (routes.length > 6) out.push(`${routes.length - 6} more new HTTP routes`);

  for (const c of args.cliCommands.slice(0, 5))
    out.push(`New CLI command \`${text(c.name, 40)}\` in ${text(c.path)}`);
  for (const e of args.envVars.slice(0, 5))
    out.push(`New environment variable ${text(e.name, 60)} read in ${text(e.path)}`);

  const visible = args.files.filter((f) => !f.hidden);
  const migrations = visible
    .filter((f) => f.role === 'migration' && f.status === 'added')
    .map((f) => `New migration ${text(f.path)}`);
  out.push(...capped(migrations, 4, 'new migrations'));
  const configs = visible
    .filter((f) => f.role === 'config' && f.status === 'added')
    .map((f) => `New config file ${text(f.path)}`);
  out.push(...capped(configs, 4, 'new config files'));
  const renames = visible
    .filter((f) => f.status === 'renamed' && f.oldPath && f.trivialReason?.startsWith('pure rename'))
    .map((f) => `Renamed ${text(f.oldPath as string)} to ${text(f.path)}`);
  out.push(...capped(renames, 3, 'renames'));
  return out.slice(0, 16);
}
