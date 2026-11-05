import { describe, expect, it } from 'vitest';
import { symbolEmitter } from './shared.ts';

const lines = ['export function a(x) {   ', '  return x;', '}', '', 'const b = 2;'];
// Bracket depth at the start of each line, and after the last one.
const depths = [0, 1, 1, 0, 0, 0];

describe('symbolEmitter', () => {
  it('records 1-based lines, exported by default, with the declaring line up to its first brace', () => {
    const { symbols, emit } = symbolEmitter(lines);
    emit('a', 'function', 0);
    expect(symbols).toEqual([
      { name: 'a', kind: 'function', exported: true, decl: 'export function a(x)', startLine: 1, endLine: 1 },
    ]);
  });

  it('ends where the bracket block closes when it is given the depths', () => {
    const { symbols, emit } = symbolEmitter(lines, depths);
    emit('a', 'function', 0);
    emit('b', 'constant', 4);
    expect(symbols.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ['a', 1, 3],
      ['b', 5, 5],
    ]);
  });

  it('takes the end, the declaration and the export flag from the options', () => {
    const { symbols, emit } = symbolEmitter(lines, depths);
    emit('a', 'function', 0, { exported: false, end: 1, decl: 'a(x)' });
    expect(symbols).toEqual([
      { name: 'a', kind: 'function', exported: false, decl: 'a(x)', startLine: 1, endLine: 2 },
    ]);
  });

  it('notes the declaring line when decorators come first', () => {
    const { symbols, emit } = symbolEmitter(lines);
    emit('a', 'route', 2, { start: 0, end: 4 });
    expect(symbols[0]).toMatchObject({ startLine: 1, declLine: 3, endLine: 5 });
  });

  it('leaves out the declaring line when nothing comes before it', () => {
    const { symbols, emit } = symbolEmitter(lines);
    emit('b', 'constant', 4);
    expect(symbols[0]).not.toHaveProperty('declLine');
  });

  it('collects symbols in the order they were recorded', () => {
    const { symbols, emit } = symbolEmitter(lines);
    emit('second', 'constant', 4);
    emit('first', 'function', 0);
    expect(symbols.map((s) => s.name)).toEqual(['second', 'first']);
  });
});
