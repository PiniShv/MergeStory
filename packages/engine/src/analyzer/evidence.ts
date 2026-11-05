/** The evidence index: every citable fact, with a short label and a link when one exists. */

import { maskPrivate } from '../core/secrets.ts';
import { truncate } from '../core/text.ts';
import type {
  ChangeSet,
  CodeRef,
  Component,
  ContextInputs,
  DependencyChange,
  EvidenceItem,
  RiskSignal,
  SymbolChange,
} from '../core/types.ts';
import { hunkPath, hunkRange } from './hunks.ts';
import { blobUrl, shortSha } from './util.ts';

/** Mask secrets and e-mail addresses in text that ends up in a label. */
export function cleanLabel(text: string, max: number): string {
  // Labels always mask e-mail addresses, whatever the privacy setting.
  return truncate(maskPrivate(text.replace(/\s+/g, ' ').trim(), { maskEmails: true }), max);
}

export interface EvidenceSources {
  changeSet: ChangeSet;
  inputs: ContextInputs;
  /** File ids whose content is hidden: they get a file item but no hunk items. */
  hiddenFileIds: ReadonlySet<string>;
  components: readonly Component[];
  symbols: readonly SymbolChange[];
  risks: readonly RiskSignal[];
  dependencies: readonly DependencyChange[];
}

export function buildEvidenceIndex(src: EvidenceSources): EvidenceItem[] {
  const { changeSet, inputs } = src;
  const web = changeSet.repo.webUrl;
  const headSha = changeSet.head.sha;
  const baseSha = changeSet.base.sha;
  const urlFor = (ref: CodeRef): string | null =>
    blobUrl(web, ref.side === 'head' ? headSha : baseSha, ref.path, ref.startLine, ref.endLine);
  const items: EvidenceItem[] = [];
  const add = (
    id: string,
    kind: EvidenceItem['kind'],
    label: string,
    ref: CodeRef | null,
    url: string | null,
  ): void => {
    items.push({ id, kind, label, ref, url });
  };

  if (changeSet.pr) add('PR', 'pr', 'PR description', null, changeSet.pr.url || null);
  if (inputs.task?.trim()) add('TASK', 'task', 'Task description', null, null);
  if (inputs.notes?.trim()) add('NOTES', 'notes', 'Implementation notes', null, null);
  for (const t of inputs.tests) {
    add(
      t.id,
      'test',
      `Test run: ${cleanLabel(t.command, 60)} (${t.passed ? 'passed' : 'failed'}, reported by the caller)`,
      null,
      null,
    );
  }
  for (const issue of changeSet.linkedIssues) {
    add(issue.id, 'issue', `Issue #${issue.number}: ${cleanLabel(issue.title, 60)}`, null, issue.url || null);
  }
  for (const c of changeSet.commits) {
    const url = web ? `${web.replace(/\/+$/, '')}/commit/${c.sha}` : null;
    add(c.id, 'commit', `Commit ${shortSha(c.sha)}: ${cleanLabel(c.subject, 70)}`, null, url);
  }

  for (const file of changeSet.files) {
    const side = file.status === 'deleted' ? 'base' : 'head';
    add(
      file.id,
      'file',
      cleanLabel(file.path, 120),
      null,
      blobUrl(web, side === 'head' ? headSha : baseSha, file.path),
    );
    if (src.hiddenFileIds.has(file.id)) continue;
    for (const hunk of file.hunks) {
      const range = hunkRange(hunk);
      const path = hunkPath(file, range);
      const ref: CodeRef = { path, ...range };
      add(hunk.id, 'hunk', `${cleanLabel(path, 100)}:${range.startLine}-${range.endLine}`, ref, urlFor(ref));
    }
  }

  for (const s of src.symbols) {
    const ref: CodeRef = { path: s.path, side: s.side, startLine: s.startLine, endLine: s.endLine };
    add(
      s.id,
      'symbol',
      `${cleanLabel(s.name, 80)} (${cleanLabel(s.path, 80)}:${s.startLine}-${s.endLine})`,
      ref,
      urlFor(ref),
    );
  }
  for (const m of src.components) {
    const url =
      web && m.path !== '.'
        ? `${web.replace(/\/+$/, '')}/tree/${headSha}/${m.path.split('/').map(encodeURIComponent).join('/')}`
        : null;
    add(
      m.id,
      'component',
      `${cleanLabel(m.name, 60)} (${cleanLabel(m.path, 80)})`,
      null,
      m.status === 'removed' ? null : url,
    );
  }
  for (const r of src.risks) add(r.id, 'risk', cleanLabel(r.title, 100), r.ref, r.ref ? urlFor(r.ref) : null);

  const fileById = new Map(changeSet.files.map((f) => [f.id, f]));
  for (const d of src.dependencies) {
    const file = fileById.get(d.fileId);
    const detail = d.change === 'removed' ? 'removed' : `${d.change} ${d.to ?? ''}`.trim();
    const url = file ? blobUrl(web, file.status === 'deleted' ? baseSha : headSha, file.path) : null;
    add(d.id, 'dependency', `${cleanLabel(d.name, 80)} (${detail})`, null, url);
  }
  for (const s of inputs.screenshots)
    add(s.id, 'screenshot', cleanLabel(s.caption || `Screenshot (${s.moment})`, 100), null, null);
  add('REPO', 'repo', 'Repository structure', null, web);
  return items;
}
