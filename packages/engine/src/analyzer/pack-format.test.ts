import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../core/types.ts';
import {
  cell,
  code,
  compressHunkIds,
  compressIds,
  createMasker,
  fence,
  numberedLine,
} from './pack-format.ts';

describe('compressIds', () => {
  it('collapses runs of consecutive ids with the same prefix', () => {
    expect(compressIds(['F1', 'F2', 'F3', 'F5', 'S1', 'S2', 'PR', 'REPO', 'M1'])).toBe(
      'F1-F3, F5, S1-S2, PR, REPO, M1',
    );
  });

  it('does not join ids with different prefixes or gaps', () => {
    expect(compressIds(['F1', 'S2', 'F3'])).toBe('F1, S2, F3');
  });
});

describe('compressHunkIds', () => {
  it('collapses hunks of one file and runs of files that only have their first hunk', () => {
    expect(
      compressHunkIds([
        'F1.H1',
        'F1.H2',
        'F1.H3',
        'F2.H1',
        'F3.H1',
        'F4.H1',
        'F6.H1',
        'F7.H2',
        'F7.H3',
        'F9.H1',
      ]),
    ).toBe('F1.H1-H3, F2.H1-F4.H1, F6.H1, F7.H2-H3, F9.H1');
  });

  it('keeps an id of another shape instead of dropping it', () => {
    expect(compressHunkIds(['F1.H1', 'F1.H2', 'H9', 'F3'])).toBe('F1.H1-H2, H9, F3');
  });

  it('keeps gaps inside one file', () => {
    expect(compressHunkIds(['F1.H1', 'F1.H2', 'F1.H4'])).toBe('F1.H1-H2, F1.H4');
  });
});

describe('formatting helpers', () => {
  it('uses a fence longer than any backtick run in the text', () => {
    expect(fence('plain')).toBe('```\nplain\n```');
    expect(fence('a ``` b')).toBe('````\na ``` b\n````');
    expect(fence('`````')).toBe('``````\n`````\n``````');
  });

  it('keeps table cells and code spans on one line', () => {
    expect(cell('a|b\nc`d')).toBe("a\\|b c'd");
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
    expect(code('a`b\nc')).toBe('`a b c`');
  });

  it('right-aligns line numbers', () => {
    expect(numberedLine(42, '+', 'x')).toBe('  42 + x');
    expect(numberedLine(7, '-', 'y')).toBe('   7 - y');
    expect(numberedLine(12345, ' ', 'z')).toBe('12345   z');
  });
});

describe('masker', () => {
  const line = (text: string): DiffLine => ({ kind: 'add', text, oldLine: null, newLine: 1 });

  it('masks a private key block that spans lines, and long key-like lines', () => {
    const masker = createMasker(true);
    const masked = masker.hunk([
      line('before'),
      line('-----BEGIN PRIVATE KEY-----'),
      line('short body'),
      line('-----END PRIVATE KEY-----'),
      line('after'),
      line('A'.repeat(64)),
    ]);
    expect(masked[0]).toBe('before');
    expect(masked.slice(1, 4)).toEqual(['••••••••', '••••••••', '••••••••']);
    expect(masked[4]).toBe('after');
    expect(masked[5]).toBe('••••••••');
  });

  it('collapses line breaks in text but keeps them in blocks', () => {
    const masker = createMasker(true);
    expect(masker.text('a\nb\r\nc')).toBe('a b c');
    expect(masker.block('a\nb')).toBe('a\nb');
  });

  it('masks e-mail addresses only when asked to', () => {
    expect(createMasker(true).text('write to jo@example.com')).not.toContain('jo@example.com');
    expect(createMasker(false).text('write to jo@example.com')).toContain('jo@example.com');
  });

  it('shortens very long code lines after masking them', () => {
    const masker = createMasker(true);
    const masked = masker.code(`token = "ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(20)}" ${'x'.repeat(400)}`);
    expect(masked.length).toBeLessThanOrEqual(240);
    expect(masked).not.toContain('ghp_');
  });
});
