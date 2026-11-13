import { describe, expect, it } from 'vitest';
import { createPathPolicy } from '../core/path-policy.ts';
import type { CodeLine, CodeToken } from '../core/render-plan.ts';
import { MASK_CHAR } from '../core/secrets.ts';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import type { ChangedFile } from '../core/types.ts';
import { memoryReader, sampleChangeSet, sampleFiles } from '../testing/sample-change.ts';
import {
  CodeResolver,
  type CodeResolverDeps,
  MAX_LINE_CHARS,
  maskLines,
  normalizeLine,
  splitCodeLines,
} from './code.ts';

const shiki = 'github-dark-default';

const text = (tokens: CodeToken[]): string => tokens.map((t) => t.t).join('');
const texts = (lines: CodeLine[]): string[] => lines.map((l) => text(l.tokens));

function deps(files: Record<string, string> = sampleFiles()) {
  const reader = memoryReader(files);
  return { reader, changeSet: sampleChangeSet(), shiki };
}

/** Resolve one reference with a resolver of its own. */
function resolveCode(
  ref: Parameters<CodeResolver['resolve']>[0],
  mode: 'snippet' | 'diff',
  focus: Parameters<CodeResolver['resolve']>[2],
  resolverDeps: CodeResolverDeps,
) {
  return new CodeResolver(resolverDeps).resolve(ref, mode, focus);
}

/** A text file of the change with no hunks. A code reference may only point at a file the change holds. */
function changedFile(path: string, language: string | null): ChangedFile {
  return {
    id: 'F9',
    path,
    oldPath: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    binary: false,
    language,
    hunks: [],
    patchTruncated: false,
    sensitive: false,
  };
}

function numberedFile(count: number): string {
  return Array.from({ length: count }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';
}

describe('line preparation', () => {
  it('expands tabs to two spaces and drops trailing whitespace', () => {
    expect(normalizeLine('\tfoo()  \t')).toBe('  foo()');
    expect(splitCodeLines('a\r\n\tb  \r\n')).toEqual(['a', '  b']);
    expect(splitCodeLines('')).toEqual([]);
    expect(splitCodeLines('one\n')).toEqual(['one']);
    expect(splitCodeLines('one\n\n')).toEqual(['one', '']);
  });

  it('masks a secret that spans several lines without changing the line count', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
    const lines = [
      'const key = `-----BEGIN PRIVATE KEY-----',
      body,
      body,
      '-----END PRIVATE KEY-----`;',
      'next();',
    ];
    const result = maskLines(lines);
    expect(result.lines).toHaveLength(lines.length);
    expect(result.flags).toEqual([true, true, true, true, false]);
    expect(result.lines.join('\n')).not.toContain('MIIEvQ');
    expect(result.lines[4]).toBe('next();');
    expect(result.count).toBeGreaterThan(0);
  });

  it('leaves clean code alone', () => {
    const lines = ['export const a = 1;', 'const b = a + 1;'];
    expect(maskLines(lines)).toEqual({ lines, flags: [false, false], count: 0 });
  });
});

describe('snippet mode', () => {
  it('returns the lines of the range at the head side with new numbers and colours', async () => {
    const code = await resolveCode(
      { path: 'src/client.ts', side: 'head', startLine: 9, endLine: 13 },
      'snippet',
      [],
      deps(),
    );
    expect(code.path).toBe('src/client.ts');
    expect(code.language).toBe('typescript');
    expect(code.side).toBe('head');
    expect(code.masked).toBe(false);
    expect(code.truncated).toBe(false);
    expect(code.lines.map((l) => l.newNumber)).toEqual([9, 10, 11, 12, 13]);
    expect(code.lines.every((l) => l.kind === 'ctx' && l.oldNumber === null)).toBe(true);
    expect(texts(code.lines)[0]).toBe(
      'export async function send(options: ClientOptions, path: string): Promise<Response> {',
    );
    expect(texts(code.lines)[1]).toBe('  return withRetry(async () => {');
    // The keyword "export" is coloured; punctuation in the default colour has no colour.
    const first = code.lines[0]!.tokens;
    expect(first[0]).toMatchObject({ t: 'export' });
    expect(first[0]!.c).toMatch(/^#[0-9a-f]{6}$/);
    expect(code.lines.flatMap((l) => l.tokens).some((t) => t.c === null)).toBe(true);
  });

  it('reads the base side with old numbers', async () => {
    const code = await resolveCode(
      { path: 'src/client.ts', side: 'base', startLine: 8, endLine: 9 },
      'snippet',
      [],
      deps(),
    );
    expect(code.side).toBe('base');
    expect(code.lines.map((l) => [l.oldNumber, l.newNumber])).toEqual([
      [8, null],
      [9, null],
    ]);
    expect(texts(code.lines)[1]).toContain('const response = await request');
  });

  it('clamps a range that runs past the end of the file', async () => {
    const code = await resolveCode(
      { path: 'src/client.ts', side: 'head', startLine: 15, endLine: 99 },
      'snippet',
      [],
      deps(),
    );
    expect(code.lines.map((l) => l.newNumber)).toEqual([15, 16, 17]);
    expect(code.truncated).toBe(false);
  });

  it('uses the previous path to read the base side of a renamed file', async () => {
    const changeSet = sampleChangeSet();
    const renamed: ChangedFile = {
      ...changeSet.files[1]!,
      path: 'src/http-client.ts',
      oldPath: 'src/client.ts',
    };
    changeSet.files = [renamed];
    const reader = memoryReader({
      'base:src/client.ts': 'old line\n',
      'head:src/http-client.ts': 'new line\n',
    });
    const resolver = new CodeResolver({ reader, changeSet, shiki });
    const base = await resolver.resolve(
      { path: 'src/http-client.ts', side: 'base', startLine: 1, endLine: 1 },
      'snippet',
    );
    const head = await resolver.resolve(
      { path: 'src/http-client.ts', side: 'head', startLine: 1, endLine: 1 },
      'snippet',
    );
    expect(texts(base.lines)).toEqual(['old line']);
    expect(texts(head.lines)).toEqual(['new line']);
    expect(reader.reads).toEqual(['base:src/client.ts', 'head:src/http-client.ts']);
  });

  it('shows at most the line limit, positioned around the first focus range', async () => {
    const files = { 'head:big.ts': numberedFile(100) };
    const d = deps(files);
    d.changeSet.files = [changedFile('big.ts', 'typescript')];
    const code = await resolveCode(
      { path: 'big.ts', side: 'head', startLine: 1, endLine: 60 },
      'snippet',
      [{ startLine: 40, endLine: 41 }],
      d,
    );
    expect(code.lines).toHaveLength(STORYBOARD_LIMITS.maxCodeLines);
    expect(code.truncated).toBe(true);
    const numbers = code.lines.map((l) => l.newNumber!);
    expect(numbers).toContain(40);
    expect(numbers).toContain(41);
    const position = numbers.indexOf(40);
    expect(position).toBeGreaterThan(4);
    expect(position).toBeLessThan(13);
    // Consecutive lines of the real file, nothing skipped.
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => numbers[0]! + i));
  });

  it('starts at the beginning when there is no focus', async () => {
    const d = deps({ 'head:big.ts': numberedFile(100) });
    d.changeSet.files = [changedFile('big.ts', 'typescript')];
    const code = await resolveCode(
      { path: 'big.ts', side: 'head', startLine: 5, endLine: 80 },
      'snippet',
      [],
      d,
    );
    expect(code.lines[0]?.newNumber).toBe(5);
    expect(code.lines).toHaveLength(STORYBOARD_LIMITS.maxCodeLines);
    expect(code.truncated).toBe(true);
  });

  it('shows unknown languages as plain text', async () => {
    const d = deps({ 'head:notes.zzz': 'hello world\n' });
    d.changeSet.files = [changedFile('notes.zzz', null)];
    const code = await resolveCode(
      { path: 'notes.zzz', side: 'head', startLine: 1, endLine: 1 },
      'snippet',
      [],
      d,
    );
    expect(code.language).toBe('text');
    expect(code.lines[0]?.tokens).toEqual([{ t: 'hello world', c: null, s: 0 }]);
  });

  it('expands tabs, strips trailing spaces and handles Windows line endings', async () => {
    const d = deps({ 'head:a.ts': 'function f() {\r\n\treturn 1;   \r\n}\r\n' });
    d.changeSet.files = [changedFile('a.ts', 'typescript')];
    const code = await resolveCode(
      { path: 'a.ts', side: 'head', startLine: 1, endLine: 3 },
      'snippet',
      [],
      d,
    );
    expect(texts(code.lines)).toEqual(['function f() {', '  return 1;', '}']);
  });

  it('cuts very long lines with an ellipsis and says so', async () => {
    const d = deps({ 'head:min.js': `var a = "${'x'.repeat(600)}";\n` });
    d.changeSet.files = [changedFile('min.js', 'javascript')];
    const code = await resolveCode(
      { path: 'min.js', side: 'head', startLine: 1, endLine: 1 },
      'snippet',
      [],
      d,
    );
    const shown = text(code.lines[0]!.tokens);
    expect(shown.length).toBe(MAX_LINE_CHARS + 1);
    expect(shown.endsWith('…')).toBe(true);
    expect(code.truncated).toBe(true);
  });

  it('fails clearly when the lines do not exist', async () => {
    const d = deps();
    await expect(
      resolveCode({ path: 'src/client.ts', side: 'head', startLine: 500, endLine: 510 }, 'snippet', [], d),
    ).rejects.toMatchObject({ code: 'STORYBOARD_INVALID' });
    await expect(
      resolveCode({ path: 'src/missing.ts', side: 'head', startLine: 1, endLine: 2 }, 'snippet', [], d),
    ).rejects.toMatchObject({ code: 'STORYBOARD_INVALID' });
    await expect(
      resolveCode({ path: '../outside.ts', side: 'head', startLine: 1, endLine: 2 }, 'snippet', [], d),
    ).rejects.toMatchObject({ code: 'STORYBOARD_INVALID' });
  });

  it('refuses a path that the change does not hold, without reading it', async () => {
    const d = deps({ ...sampleFiles(), 'head:src/other.ts': 'readable\n' });
    await expect(
      resolveCode({ path: 'src/other.ts', side: 'head', startLine: 1, endLine: 1 }, 'snippet', [], d),
    ).rejects.toMatchObject({
      code: 'STORYBOARD_INVALID',
      message: 'A code reference points at src/other.ts, which is not part of the change.',
    });
    expect(d.reader.reads).toEqual([]);
  });

  it('takes the language from the change set and does not guess it from the path', async () => {
    const d = deps({ 'head:a.ts': 'const a = 1;\n', 'head:b.txt': 'const b = 1;\n' });
    d.changeSet.files = [changedFile('a.ts', null), changedFile('b.txt', 'typescript')];
    const plain = await resolveCode(
      { path: 'a.ts', side: 'head', startLine: 1, endLine: 1 },
      'snippet',
      [],
      d,
    );
    expect(plain.language).toBe('text');
    expect(plain.lines[0]?.tokens).toEqual([{ t: 'const a = 1;', c: null, s: 0 }]);
    const coloured = await resolveCode(
      { path: 'b.txt', side: 'head', startLine: 1, endLine: 1 },
      'snippet',
      [],
      d,
    );
    expect(coloured.language).toBe('typescript');
    expect(coloured.lines[0]!.tokens[0]).toMatchObject({ t: 'const' });
    expect(coloured.lines[0]!.tokens[0]!.c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('reads each file once, however many references use it', async () => {
    const d = deps();
    const resolver = new CodeResolver(d);
    await resolver.resolve({ path: 'src/client.ts', side: 'head', startLine: 1, endLine: 3 }, 'snippet');
    await resolver.resolve({ path: 'src/client.ts', side: 'head', startLine: 8, endLine: 12 }, 'snippet');
    await resolver.resolve({ path: 'src/client.ts', side: 'head', startLine: 8, endLine: 16 }, 'diff');
    expect(d.reader.reads.filter((r) => r === 'head:src/client.ts')).toHaveLength(1);
  });
});

describe('diff mode', () => {
  it('interleaves context, removed and added lines with old and new numbers', async () => {
    const code = await resolveCode(
      { path: 'src/client.ts', side: 'head', startLine: 8, endLine: 16 },
      'diff',
      [],
      deps(),
    );
    const summary = code.lines.map((l) => `${l.kind}:${l.oldNumber ?? '-'}:${l.newNumber ?? '-'}`);
    expect(summary).toEqual([
      'ctx:7:8',
      'ctx:8:9',
      'del:9:-',
      'del:10:-',
      'del:11:-',
      'del:12:-',
      'del:13:-',
      'add:-:10',
      'add:-:11',
      'add:-:12',
      'add:-:13',
      'add:-:14',
      'add:-:15',
      'add:-:16',
    ]);
    expect(code.lines.map((l) => l.kind)).toEqual([
      'ctx', // new line 8 (blank)
      'ctx', // new line 9 (function signature)
      'del',
      'del',
      'del',
      'del',
      'del',
      'add',
      'add',
      'add',
      'add',
      'add',
      'add',
      'add',
    ]);
    const deleted = code.lines.filter((l) => l.kind === 'del');
    expect(deleted.map((l) => l.oldNumber)).toEqual([9, 10, 11, 12, 13]);
    expect(deleted.every((l) => l.newNumber === null)).toBe(true);
    expect(texts(deleted)[2]).toBe('    throw new Error(`HTTP ${response.status}`);');
    const added = code.lines.filter((l) => l.kind === 'add');
    expect(added.map((l) => l.newNumber)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(texts(added)[3]).toBe('      throw new HttpError(response.status);');
  });

  it('limits the lines to the reference range, keeping the removed lines next to it', async () => {
    const code = await resolveCode(
      { path: 'src/client.ts', side: 'head', startLine: 10, endLine: 12 },
      'diff',
      [],
      deps(),
    );
    const kinds = code.lines.map((l) => l.kind);
    expect(kinds).toEqual(['del', 'del', 'del', 'del', 'del', 'add', 'add', 'add']);
    expect(code.lines.filter((l) => l.kind === 'add').map((l) => l.newNumber)).toEqual([10, 11, 12]);
  });

  it('takes tokens for removed lines from the base file and for the rest from the head file', async () => {
    const d = deps();
    const code = await resolveCode(
      { path: 'src/client.ts', side: 'head', startLine: 10, endLine: 12 },
      'diff',
      [],
      d,
    );
    expect(d.reader.reads.sort()).toEqual(['base:src/client.ts', 'head:src/client.ts']);
    expect(code.lines.flatMap((l) => l.tokens).some((t) => t.c !== null)).toBe(true);
  });

  it('works from the hunk text when files cannot be read', async () => {
    const d = deps({});
    const code = await resolveCode(
      { path: 'src/client.ts', side: 'head', startLine: 10, endLine: 12 },
      'diff',
      [],
      d,
    );
    expect(code.lines.map((l) => l.kind)).toEqual(['del', 'del', 'del', 'del', 'del', 'add', 'add', 'add']);
    expect(texts(code.lines)[5]).toBe('  return withRetry(async () => {');
    expect(texts(code.lines)[6]).toBe(
      '    const response = await request(options.baseUrl + path, { timeout: options.timeoutMs });',
    );
    expect(code.lines.flatMap((l) => l.tokens).some((t) => t.c !== null)).toBe(true);
  });

  it('shows an added file as added lines, without reading it', async () => {
    const d = deps({});
    const code = await resolveCode(
      { path: 'src/retry/backoff.ts', side: 'head', startLine: 1, endLine: 4 },
      'diff',
      [],
      d,
    );
    expect(code.lines.every((l) => l.kind === 'add')).toBe(true);
    expect(code.lines.map((l) => l.newNumber)).toEqual([1, 2, 3, 4]);
    expect(d.reader.reads).not.toContain('base:src/retry/backoff.ts');
  });

  it('limits a long diff to the line limit around the first focus', async () => {
    const d = deps({});
    const code = await resolveCode(
      { path: 'src/retry/backoff.ts', side: 'head', startLine: 1, endLine: 27 },
      'diff',
      [{ startLine: 20, endLine: 20 }],
      d,
    );
    expect(code.lines).toHaveLength(STORYBOARD_LIMITS.maxCodeLines);
    expect(code.truncated).toBe(true);
    expect(code.lines.map((l) => l.newNumber)).toContain(20);
  });

  it('falls back to a snippet when the file has no hunk around the range', async () => {
    const d = deps({ ...sampleFiles(), 'head:src/other.ts': 'a\nb\nc\n' });
    d.changeSet.files.push(changedFile('src/other.ts', 'typescript'));
    const other = await resolveCode(
      { path: 'src/other.ts', side: 'head', startLine: 1, endLine: 2 },
      'diff',
      [],
      d,
    );
    expect(other.lines.every((l) => l.kind === 'ctx')).toBe(true);
    expect(texts(other.lines)).toEqual(['a', 'b']);
  });

  it('reports lines that exist neither in a hunk nor in the file', async () => {
    await expect(
      resolveCode({ path: 'src/client.ts', side: 'head', startLine: 100, endLine: 101 }, 'diff', [], deps()),
    ).rejects.toMatchObject({ code: 'STORYBOARD_INVALID' });
  });
});

describe('protection', () => {
  const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

  it('masks secrets before highlighting and reports it', async () => {
    const d = deps({ 'head:config.ts': `export const token = '${secret}';\nexport const name = 'ok';\n` });
    d.changeSet.files = [changedFile('config.ts', 'typescript')];
    const code = await resolveCode(
      { path: 'config.ts', side: 'head', startLine: 1, endLine: 2 },
      'snippet',
      [],
      d,
    );
    expect(code.masked).toBe(true);
    const shown = texts(code.lines).join('\n');
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain('ghp_');
    expect(shown).toContain(MASK_CHAR.repeat(8));
    expect(texts(code.lines)[1]).toBe("export const name = 'ok';");
  });

  it('does not report masking for lines outside the shown range', async () => {
    const d = deps({ 'head:config.ts': `export const token = '${secret}';\nexport const name = 'ok';\n` });
    d.changeSet.files = [changedFile('config.ts', 'typescript')];
    const code = await resolveCode(
      { path: 'config.ts', side: 'head', startLine: 2, endLine: 2 },
      'snippet',
      [],
      d,
    );
    expect(code.masked).toBe(false);
  });

  it('masks private keys on every line', async () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
    const content = ['const pem = `-----BEGIN PRIVATE KEY-----', body, '-----END PRIVATE KEY-----`;'].join(
      '\n',
    );
    const d = deps({ 'head:keys.ts': content });
    d.changeSet.files = [changedFile('keys.ts', 'typescript')];
    const code = await resolveCode(
      { path: 'keys.ts', side: 'head', startLine: 1, endLine: 3 },
      'snippet',
      [],
      d,
    );
    expect(code.masked).toBe(true);
    expect(code.lines).toHaveLength(3);
    expect(texts(code.lines).join('\n')).not.toContain('MIIEvQ');
  });

  it('masks secrets in diff lines too', async () => {
    const changeSet = sampleChangeSet();
    changeSet.files = [
      {
        ...changeSet.files[1]!,
        path: 'src/settings.ts',
        hunks: [
          {
            id: 'F2.H1',
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            header: '',
            lines: [
              { kind: 'del', text: "const token = 'old';", oldLine: 1, newLine: null },
              { kind: 'add', text: `const token = '${secret}';`, oldLine: null, newLine: 1 },
            ],
          },
        ],
      },
    ];
    const reader = memoryReader({});
    const code = await resolveCode(
      { path: 'src/settings.ts', side: 'head', startLine: 1, endLine: 1 },
      'diff',
      [],
      { reader, changeSet, shiki },
    );
    expect(code.masked).toBe(true);
    expect(texts(code.lines).join('\n')).not.toContain(secret);
  });

  it('never reads or shows sensitive files', async () => {
    const changeSet = sampleChangeSet();
    changeSet.files = [{ ...changeSet.files[1]!, path: 'config/.env', sensitive: true }];
    const reader = memoryReader({ 'head:config/.env': 'API_KEY=abcdef123456\n' });
    const code = await resolveCode(
      { path: 'config/.env', side: 'head', startLine: 1, endLine: 1 },
      'snippet',
      [],
      { reader, changeSet, shiki },
    );
    expect(reader.reads).toEqual([]);
    expect(code.masked).toBe(true);
    expect(texts(code.lines).join('')).not.toContain('abcdef');
    expect(code.lines).toHaveLength(1);
  });

  it('shows the protected panel for a built-in sensitive path and an excluded path alike', async () => {
    // The source marks a file sensitive from the path policy, and the resolver reads only that mark.
    const isProtected = createPathPolicy(['internal/**']);
    const reader = memoryReader({
      'head:deploy/id_rsa': 'private-key-text\n',
      'head:internal/plan.ts': 'secret plan\n',
      'head:src/ok.ts': 'fine\n',
    });
    const changeSet = sampleChangeSet();
    changeSet.files = ['deploy/id_rsa', 'internal/plan.ts', 'src/ok.ts'].map((path) => ({
      ...changedFile(path, 'typescript'),
      sensitive: isProtected(path),
    }));
    const show = (path: string) =>
      resolveCode({ path, side: 'head', startLine: 1, endLine: 1 }, 'snippet', [], {
        reader,
        changeSet,
        shiki,
      });
    for (const path of ['deploy/id_rsa', 'internal/plan.ts']) {
      const code = await show(path);
      expect(code.masked).toBe(true);
      expect(texts(code.lines)).toEqual(['Protected file: its contents are never shown.']);
    }
    expect(texts((await show('src/ok.ts')).lines)).toEqual(['fine']);
    expect(reader.reads).toEqual(['head:src/ok.ts']);
  });

  it('protects a renamed file at its new and at its previous path', async () => {
    const changeSet = sampleChangeSet();
    changeSet.files = [
      {
        ...changedFile('src/keys.ts', 'typescript'),
        oldPath: 'internal/keys.ts',
        status: 'renamed',
        sensitive: true,
      },
    ];
    const reader = memoryReader({ 'head:src/keys.ts': 'new\n', 'base:internal/keys.ts': 'old\n' });
    for (const [path, side] of [
      ['src/keys.ts', 'head'],
      ['internal/keys.ts', 'base'],
    ] as const) {
      const code = await resolveCode({ path, side, startLine: 1, endLine: 1 }, 'snippet', [], {
        reader,
        changeSet,
        shiki,
      });
      expect(texts(code.lines)).toEqual(['Protected file: its contents are never shown.']);
    }
    expect(reader.reads).toEqual([]);
  });
});
