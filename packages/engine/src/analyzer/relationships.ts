/** Component-to-component relationships derived from import statements. */
import type { ChangedFile, FileRole, Relationship } from '../core/types.ts';
import type { ComponentGrouping } from './components.ts';
import { extractImports, type ImportResolver } from './imports.ts';
import { detectRole } from './roles.ts';

export interface RelationshipFile {
  file: ChangedFile;
  role: FileRole;
  /** Head content, or null when unavailable (deleted, binary, hidden). */
  head: string | null;
}

const IMPORT_ROLES = new Set<FileRole>(['source', 'test', 'migration', 'build']);

/** Numeric part of an evidence id such as "M12". */
export function idNumber(id: string): number {
  const m = /(\d+)/.exec(id);
  return m ? Number(m[1]) : 0;
}

export function buildRelationships(args: {
  files: readonly RelationshipFile[];
  grouping: ComponentGrouping;
  resolver: ImportResolver;
}): Relationship[] {
  const { grouping, resolver } = args;
  const edges = new Map<string, Relationship>();
  for (const { file, role, head } of args.files) {
    if (head === null || file.status === 'deleted' || !IMPORT_ROLES.has(role)) continue;
    const from = grouping.byFile.get(file.id);
    if (!from) continue;
    for (const ref of extractImports(file.path, head)) {
      for (const target of resolver.resolve(file.path, ref)) {
        if (target === file.path || detectRole(target) === 'test') continue;
        const to = grouping.componentForPath(target);
        if (!to || to === from) continue;
        const kind = role === 'test' ? 'tests' : 'imports';
        const key = `${from}|${to}|${kind}`;
        if (!edges.has(key)) edges.set(key, { from, to, kind, evidence: file.id });
      }
    }
  }
  return [...edges.values()].sort(
    (a, b) =>
      idNumber(a.from) - idNumber(b.from) || idNumber(a.to) - idNumber(b.to) || a.kind.localeCompare(b.kind),
  );
}
