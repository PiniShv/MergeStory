import { describe, expect, it } from 'vitest';
import type { FilesResolved } from '../../core/render-plan.ts';
import {
  FILES_DENSITIES,
  FILES_INNER_HEIGHT,
  type FilesCell,
  flattenFiles,
  planFilesLayout,
  splitColumns,
} from './files.ts';

type Group = FilesResolved['groups'][number];

function group(component: string, count: number, prefix = component): Group {
  return {
    component,
    files: Array.from({ length: count }, (_, i) => ({
      path: `src/${prefix}/file-${i + 1}.ts`,
      status: 'modified' as const,
      additions: i + 1,
      deletions: 0,
      highlighted: false,
      trivial: false,
    })),
  };
}

function height(cells: FilesCell[], row: number, groupHeight: number): number {
  return cells.reduce((sum, c) => sum + (c.kind === 'group' ? groupHeight : row), 0);
}

function fileCount(columns: FilesCell[][]): number {
  return columns.flat().filter((c) => c.kind === 'file').length;
}

function noteCount(columns: FilesCell[][]): number {
  return columns.flat().reduce((sum, c) => sum + (c.kind === 'more' ? c.count : 0), 0);
}

describe('flattenFiles', () => {
  it('puts a header before each group and the note last', () => {
    const cells = flattenFiles([group('api', 2), group('tests', 1)], 3);
    expect(cells.map((c) => c.kind)).toEqual(['group', 'file', 'file', 'group', 'file', 'more']);
  });

  it('skips empty groups and the note when nothing is hidden', () => {
    const cells = flattenFiles([group('empty', 0), group('api', 1)], 0);
    expect(cells.map((c) => c.kind)).toEqual(['group', 'file']);
  });
});

describe('planFilesLayout', () => {
  it('uses one roomy column for a short list', () => {
    const layout = planFilesLayout([group('api', 4)], 0);
    expect(layout.columns).toHaveLength(1);
    expect(layout.density).toEqual(FILES_DENSITIES[0]);
  });

  it('uses two columns when one cannot hold the list', () => {
    const layout = planFilesLayout([group('api', 6), group('worker', 5), group('tests', 5)], 4);
    expect(layout.columns).toHaveLength(2);
    expect(fileCount(layout.columns)).toBe(16);
    expect(noteCount(layout.columns)).toBe(4);
  });

  it('fits every column in the available height', () => {
    for (const rows of [4, 9, 16, 22, 40]) {
      const { columns, density } = planFilesLayout(
        [group('a', Math.ceil(rows / 2)), group('b', Math.floor(rows / 2))],
        0,
      );
      for (const col of columns)
        expect(height(col, density.row, density.group)).toBeLessThanOrEqual(FILES_INNER_HEIGHT);
    }
  });

  it('never leaves a component header alone at the bottom of a column', () => {
    for (let a = 1; a <= 9; a++) {
      for (let b = 1; b <= 9; b++) {
        const { columns } = planFilesLayout([group('a', a), group('b', b), group('c', 3)], 0);
        for (const col of columns) expect(col[col.length - 1]!.kind).not.toBe('group');
      }
    }
  });

  it('repeats the header when a component continues in the second column', () => {
    const layout = planFilesLayout([group('big', 20)], 0);
    expect(layout.columns).toHaveLength(2);
    const second = layout.columns[1]![0]!;
    expect(second).toMatchObject({ kind: 'group', component: 'big', cont: true });
  });

  it('keeps the file order across columns', () => {
    const layout = planFilesLayout([group('api', 8), group('tests', 8)], 0);
    const paths = layout.columns.flat().flatMap((c) => (c.kind === 'file' ? [c.file.path] : []));
    expect(paths).toEqual([...group('api', 8).files, ...group('tests', 8).files].map((f) => f.path));
  });

  it('folds trailing files into the note when even the compact layout is too tall, and keeps the count honest', () => {
    const groups = [group('a', 30), group('b', 30)];
    const layout = planFilesLayout(groups, 5);
    const shown = fileCount(layout.columns);
    expect(shown).toBeLessThan(60);
    expect(shown + noteCount(layout.columns)).toBe(65);
    for (const col of layout.columns) {
      expect(height(col, layout.density.row, layout.density.group)).toBeLessThanOrEqual(FILES_INNER_HEIGHT);
    }
  });

  it('copes with no files', () => {
    const layout = planFilesLayout([], 0);
    expect(fileCount(layout.columns)).toBe(0);
  });
});

describe('splitColumns', () => {
  it('balances the two columns', () => {
    const cells = flattenFiles([group('a', 10)], 0);
    const [first, second] = splitColumns(cells, FILES_DENSITIES[0]!);
    const h1 = height(first!, 56, 66);
    const h2 = height(second!, 56, 66);
    expect(Math.abs(h1 - h2)).toBeLessThanOrEqual(66 + 56);
  });
});
