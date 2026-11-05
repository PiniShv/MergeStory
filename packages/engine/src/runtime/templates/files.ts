/** Changed files grouped by component, with status, change bars and counting totals. */
import { CONTENT_W, type FilesResolved } from '../../core/render-plan.ts';
import { countUp, enter, progress } from '../anim.ts';
import { css, h } from '../dom.ts';
import { formatInt, monoChars, monoWidth, truncatePath } from '../fit.ts';
import { rise } from '../motion.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';

type FilesGroup = FilesResolved['groups'][number];
type FilesFile = FilesGroup['files'][number];

/** One line in a files column: a component header, a file row, or the "+N more" note. */
export type FilesCell =
  | { kind: 'group'; component: string; count: number; cont: boolean }
  | { kind: 'file'; file: FilesFile }
  | { kind: 'more'; count: number };

export interface FilesDensity {
  /** Height of a file row including the gap below it. */
  row: number;
  /** Height of a component header including the space above it. */
  group: number;
  /** Font size of paths and numbers. */
  font: number;
}

export interface FilesLayout {
  columns: FilesCell[][];
  density: FilesDensity;
}

/** From roomy to compact. The first one that fits is used. */
export const FILES_DENSITIES: readonly FilesDensity[] = [
  { row: 56, group: 66, font: 24 },
  { row: 50, group: 60, font: 24 },
  { row: 44, group: 54, font: 22 },
  { row: 40, group: 50, font: 22 },
];

/** Height available for rows inside a column card, in pixels. */
export const FILES_INNER_HEIGHT = 556;

function cellHeight(cell: FilesCell, d: FilesDensity): number {
  return cell.kind === 'group' ? d.group : d.row;
}

function columnHeight(cells: readonly FilesCell[], d: FilesDensity): number {
  return cells.reduce((sum, c) => sum + cellHeight(c, d), 0);
}

/** Flatten groups into cells: a header, then its files, group after group. */
export function flattenFiles(groups: readonly FilesGroup[], hiddenCount: number): FilesCell[] {
  const cells: FilesCell[] = [];
  for (const group of groups) {
    if (group.files.length === 0) continue;
    cells.push({ kind: 'group', component: group.component, count: group.files.length, cont: false });
    for (const file of group.files) cells.push({ kind: 'file', file });
  }
  if (hiddenCount > 0) cells.push({ kind: 'more', count: hiddenCount });
  return cells;
}

/** The group header that governs the cell at `index` (the nearest one above it). */
function headerFor(cells: readonly FilesCell[], index: number): Extract<FilesCell, { kind: 'group' }> | null {
  for (let i = index; i >= 0; i--) {
    const c = cells[i]!;
    if (c.kind === 'group') return c;
  }
  return null;
}

/**
 * Split cells into two columns of similar height. A header is never left alone at the bottom of
 * the first column, and a group that spans both columns repeats its header ("cont.").
 */
export function splitColumns(cells: readonly FilesCell[], d: FilesDensity): FilesCell[][] {
  let best: { split: number; cost: number; second: FilesCell[] } | null = null;
  for (let split = 1; split < cells.length; split++) {
    if (cells[split - 1]!.kind === 'group') continue;
    const second: FilesCell[] = cells.slice(split);
    const head = second[0]!;
    if (head.kind === 'file') {
      const header = headerFor(cells, split - 1);
      if (header) second.unshift({ ...header, cont: true });
    }
    const cost = Math.max(columnHeight(cells.slice(0, split), d), columnHeight(second, d));
    if (!best || cost < best.cost) best = { split, cost, second };
  }
  if (!best) return [cells.slice()];
  return [cells.slice(0, best.split), best.second];
}

/**
 * Choose the number of columns and the row density so every row fits the content area (up to
 * 2 columns). If even the most compact layout is too tall, trailing files fold into the
 * "+N more files" note rather than overflowing.
 */
export function planFilesLayout(
  groups: readonly FilesGroup[],
  hiddenCount: number,
  innerHeight = FILES_INNER_HEIGHT,
): FilesLayout {
  const cells = flattenFiles(groups, hiddenCount);
  for (const density of FILES_DENSITIES) {
    if (columnHeight(cells, density) <= innerHeight) return { columns: [cells], density };
    const columns = splitColumns(cells, density);
    if (columns.every((col) => columnHeight(col, density) <= innerHeight)) return { columns, density };
  }
  const density = FILES_DENSITIES[FILES_DENSITIES.length - 1]!;
  return { columns: truncateToFit(groups, hiddenCount, density, innerHeight), density };
}

/**
 * Last resort for very long lists: keep as many leading files as fit in two columns and count the
 * rest in the "+N more files" note, so nothing overflows and the count stays honest.
 */
function truncateToFit(
  groups: readonly FilesGroup[],
  hiddenCount: number,
  d: FilesDensity,
  innerHeight: number,
): FilesCell[][] {
  const total = groups.reduce((sum, g) => sum + g.files.length, 0);
  for (let keep = total - 1; keep >= 0; keep--) {
    let left = keep;
    const kept: FilesGroup[] = [];
    for (const group of groups) {
      if (left <= 0) break;
      const files = group.files.slice(0, left);
      if (files.length === 0) continue;
      kept.push({ ...group, files });
      left -= files.length;
    }
    const cells = flattenFiles(kept, hiddenCount + (total - keep));
    const columns = columnHeight(cells, d) <= innerHeight ? [cells] : splitColumns(cells, d);
    if (columns.every((col) => columnHeight(col, d) <= innerHeight)) return columns;
  }
  return [flattenFiles([], hiddenCount + total)];
}

const FILES_CSS = String.raw`
.ms-files__head { display: flex; align-items: flex-end; justify-content: space-between; height: 92px; padding-bottom: 6px; }
.ms-files__title { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ms-files__caption { font-size: 26px; font-weight: 450; color: var(--text-2); max-width: 900px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ms-files__totals { display: flex; align-items: baseline; gap: 34px; font-size: 50px; font-weight: 700; letter-spacing: -0.02em; font-feature-settings: 'cv11', 'ss01', 'tnum'; }
.ms-files__totals small { margin-left: 10px; font-size: 28px; font-weight: 500; letter-spacing: 0; color: var(--text-2); }
.ms-files__add { color: var(--add); }
.ms-files__del { color: var(--del); }

.ms-files__cols { display: grid; gap: 28px; margin-top: 18px; align-items: stretch; }
.ms-files__col { padding: 12px 22px; border-radius: 28px; }

.ms-files__group { display: flex; align-items: flex-end; gap: 18px; padding-bottom: 10px; }
.ms-files__group-name { font-size: 22px; font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); white-space: nowrap; }
.ms-files__group-count { font-size: 22px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
.ms-files__group-rule { flex: 1; height: 1px; margin-bottom: 9px; background: var(--border-1); }

.ms-files__row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  border-radius: 14px;
  background: var(--surface-inset);
}
.ms-files__glow { position: absolute; inset: 0; border-radius: 14px; background: var(--accent-soft); box-shadow: var(--glow-accent); opacity: 0; pointer-events: none; }
.ms-files__pill {
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  background: var(--status-soft);
  color: var(--status);
  font-family: var(--font-code);
  font-size: 22px;
  font-weight: 700;
}
.ms-files__path { position: relative; flex: 1; min-width: 0; font-family: var(--font-code); white-space: nowrap; overflow: hidden; color: var(--text-0); }
.ms-files__path i { font-style: normal; color: var(--text-2); }
.ms-files__row.ms-status-deleted .ms-files__path { text-decoration: line-through; text-decoration-color: var(--del); color: var(--text-1); }
.ms-files__bar { position: relative; display: flex; flex: none; height: 10px; border-radius: 5px; background: var(--border-1); overflow: hidden; }
.ms-files__bar-fill { display: flex; height: 100%; }
.ms-files__bar-fill b { display: block; height: 100%; }
.ms-files__bar-fill .a { background: var(--add); }
.ms-files__bar-fill .d { background: var(--del); }
.ms-files__num { position: relative; flex: none; text-align: right; font-family: var(--font-code); font-weight: 500; font-feature-settings: normal; }
.ms-files__num--add { color: var(--add); }
.ms-files__num--del { color: var(--del); }
.ms-files__more { display: flex; align-items: center; padding: 0 14px; color: var(--text-2); font-weight: 600; }
.ms-files__empty { padding: 40px; font-size: 30px; color: var(--text-2); }
`;

const ENTRY_START = 0.5;
const ENTRY_STEP = 0.07;

const STATUS_LETTER: Record<FilesFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
};

interface RowParts {
  glow: HTMLElement;
  /** Position in the reveal order, so the glow can follow the row's own entrance. */
  order: number;
}

export const filesTemplate: TemplateFactory<FilesResolved> = (visual, ctx) => {
  css('files', FILES_CSS);
  const { sw } = ctx;
  const layout = planFilesLayout(visual.groups, visual.hiddenCount);
  const { density } = layout;
  const columnCount = Math.max(1, layout.columns.length);
  const colInner = columnCount === 1 ? CONTENT_W - 44 : (CONTENT_W - 28) / 2 - 44;

  const shown = layout.columns
    .flat()
    .filter((c): c is Extract<FilesCell, { kind: 'file' }> => c.kind === 'file');
  const maxChanges = Math.max(1, ...shown.map((c) => c.file.additions + c.file.deletions));
  const barWidth = columnCount === 1 ? 180 : 96;
  // Number columns are only as wide as the longest value; a column with no values is dropped.
  const labelWidth = (labels: string[]) =>
    labels.length === 0
      ? 0
      : Math.ceil(monoWidth(Math.max(...labels.map((l) => l.length)), density.font)) + 4;
  const addLabels = shown.filter((c) => c.file.additions > 0).map((c) => `+${formatInt(c.file.additions)}`);
  const delLabels = shown
    .filter((c) => c.file.deletions > 0)
    .map((c) => `\u2212${formatInt(c.file.deletions)}`);
  const addWidth = labelWidth(addLabels);
  const delWidth = labelWidth(delLabels);
  const rowItems = 3 + (addWidth > 0 ? 1 : 0) + (delWidth > 0 ? 1 : 0);
  const pathWidth = colInner - 28 - 36 - barWidth - addWidth - delWidth - 16 * (rowItems - 1);
  const pathChars = monoChars(pathWidth, density.font);

  const rows: RowParts[] = [];
  const timed: { el: HTMLElement; max: number }[] = [];

  const buildCell = (cell: FilesCell): HTMLElement => {
    if (cell.kind === 'group') {
      const el = h(
        'div',
        { class: 'ms-files__group', style: { height: `${density.group}px` } },
        h('div', { class: 'ms-files__group-name', text: cell.component + (cell.cont ? ' (cont.)' : '') }),
        h('div', {
          class: 'ms-files__group-count',
          text: `${cell.count} ${cell.count === 1 ? 'file' : 'files'}`,
        }),
        h('div', { class: 'ms-files__group-rule' }),
      );
      timed.push({ el, max: 1 });
      return el;
    }
    if (cell.kind === 'more') {
      const el = h('div', {
        class: 'ms-files__more',
        style: { height: `${density.row - 6}px`, 'margin-bottom': '6px', 'font-size': `${density.font}px` },
        text: `+ ${formatInt(cell.count)} more ${cell.count === 1 ? 'file' : 'files'}`,
      });
      timed.push({ el, max: 1 });
      return el;
    }
    const { file } = cell;
    const label = truncatePath(file.path, pathChars);
    const slash = label.lastIndexOf('/');
    const pathEl = h(
      'div',
      { class: 'ms-files__path', style: { 'font-size': `${density.font}px` } },
      slash >= 0 ? h('i', { text: label.slice(0, slash + 1) }) : null,
      slash >= 0 ? label.slice(slash + 1) : label,
    );
    const total = file.additions + file.deletions;
    const fillWidth = total === 0 ? 0 : Math.max(8, Math.round((barWidth * total) / maxChanges));
    const addPart = total === 0 ? 0 : Math.round((fillWidth * file.additions) / total);
    const bar = h(
      'div',
      { class: 'ms-files__bar', style: { width: `${barWidth}px` } },
      h(
        'div',
        { class: 'ms-files__bar-fill', style: { width: `${fillWidth}px` } },
        h('b', { class: 'a', style: { width: `${addPart}px` } }),
        h('b', { class: 'd', style: { width: `${fillWidth - addPart}px` } }),
      ),
    );
    const glow = file.highlighted && !file.trivial ? h('div', { class: 'ms-files__glow' }) : null;
    const el = h(
      'div',
      {
        class: `ms-files__row ms-status-${file.status}`,
        style: { height: `${density.row - 6}px`, 'margin-bottom': '6px' },
      },
      glow,
      h('div', { class: 'ms-files__pill', text: STATUS_LETTER[file.status] }),
      pathEl,
      bar,
      h('div', {
        class: 'ms-files__num ms-files__num--add',
        style: { 'font-size': `${density.font}px` },
        text: file.additions > 0 ? `+${formatInt(file.additions)}` : '',
      }),
      h('div', {
        class: 'ms-files__num ms-files__num--del',
        style: { 'font-size': `${density.font}px` },
        text: file.deletions > 0 ? `−${formatInt(file.deletions)}` : '',
      }),
    );
    if (glow) rows.push({ glow, order: timed.length });
    timed.push({ el, max: file.trivial ? 0.5 : 1 });
    return el;
  };

  const cards =
    shown.length === 0
      ? [h('div', { class: 'ms-card ms-files__col ms-files__empty', text: 'No file changes to show.' })]
      : layout.columns.map((cells) => h('div', { class: 'ms-card ms-files__col' }, ...cells.map(buildCell)));
  const cols = h(
    'div',
    { class: 'ms-files__cols', style: { 'grid-template-columns': `repeat(${columnCount}, 1fr)` } },
    ...cards,
  );

  const totals = visual.totals;
  const filesNum = h('span', { text: '0' });
  const addNum = h('span', { text: '0' });
  const delNum = h('span', { text: '0' });
  const head = h(
    'div',
    { class: 'ms-files__head' },
    h(
      'div',
      { class: 'ms-files__title' },
      h('div', { class: 'ms-h2', text: 'Files changed' }),
      visual.caption ? h('div', { class: 'ms-files__caption', text: visual.caption }) : null,
    ),
    h(
      'div',
      { class: 'ms-files__totals' },
      h('span', {}, filesNum, h('small', { text: totals.files === 1 ? 'file' : 'files' })),
      h('span', { class: 'ms-files__add' }, '+', addNum),
      h('span', { class: 'ms-files__del' }, '−', delNum),
    ),
  );

  const root = h('div', { class: 'ms-content' }, head, cols);

  const instance: SceneInstance = {
    root,
    update(t) {
      const headIn = enter(t, 0.15, 0.6);
      rise(sw, head, headIn, 16);
      const p = progress(t, 0.4, 1.2);
      sw.text(filesNum, formatInt(countUp(totals.files, p)));
      sw.text(addNum, formatInt(countUp(totals.additions, p)));
      sw.text(delNum, formatInt(countUp(totals.deletions, p)));

      cards.forEach((card, i) => rise(sw, card, enter(t, 0.2 + i * 0.12, 0.6), 18));
      timed.forEach(({ el, max }, i) => rise(sw, el, enter(t, ENTRY_START + i * ENTRY_STEP, 0.5), 14, max));
      for (const row of rows)
        sw.opacity(row.glow, enter(t, ENTRY_START + row.order * ENTRY_STEP + 0.35, 0.7));
    },
  };
  return instance;
};
