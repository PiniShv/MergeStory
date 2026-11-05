import { describe, expect, it } from 'vitest';
import type { Analysis, RiskSignal } from '../core/types.ts';
import { buildChange, emptyInputs, type FixtureFile } from '../testing/change.ts';
import { testContext } from '../testing/context.ts';
import { analyze } from './analyze.ts';
import { LINE_RULES, RISK_KINDS } from './risk-rules.ts';

async function run(files: FixtureFile[], inputs = emptyInputs()): Promise<Analysis> {
  const { changeSet, reader } = buildChange(files);
  return analyze(changeSet, reader, inputs, testContext().ctx);
}

const TEST_FILE: FixtureFile = { path: 'src/a.test.ts', base: null, head: "it('works', () => {});\n" };

function titled(analysis: Analysis, pattern: RegExp): RiskSignal | undefined {
  return analysis.risks.find((r) => pattern.test(r.title));
}

describe('risk detection', () => {
  it('flags an added eval() as a high security review prompt', async () => {
    const analysis = await run([
      {
        path: 'src/run.ts',
        base: 'export function run(x: string) {\n  return x;\n}\n',
        head: 'export function run(x: string) {\n  return eval(x);\n}\n',
      },
      TEST_FILE,
    ]);
    const risk = titled(analysis, /dynamic code evaluation/)!;
    expect(risk).toMatchObject({ category: 'security', severity: 'high', id: 'R1' });
    expect(risk.title).toMatch(/^(Check|Confirm)/);
    expect(risk.evidence).toEqual(expect.arrayContaining(['F1', 'F1.H1']));
    expect(risk.evidence).toContain('S1');
    expect(risk.ref).toMatchObject({ path: 'src/run.ts', side: 'head', startLine: 2, endLine: 2 });
    expect(risk.detail).not.toMatch(/bug|vulnerab/i);
  });

  it('reports a risk on a deleted line of a renamed file at the old path', async () => {
    const analysis = await run([
      {
        path: 'src/handler.ts',
        oldPath: 'src/old-handler.ts',
        status: 'renamed',
        base: 'export function handle(req: Request) {\n  if (!isAuthenticated(req)) throw new Error("no");\n  return ok();\n}\n',
        head: 'export function handle(req: Request) {\n  return ok();\n}\n',
      },
      TEST_FILE,
    ]);
    const risk = titled(analysis, /security check/i)!;
    expect(risk.ref).toMatchObject({ path: 'src/old-handler.ts', side: 'base' });
    expect(risk.detail).toContain('src/old-handler.ts');
    expect(risk.detail).not.toContain('src/handler.ts');
  });

  it('ignores eval in comments and method calls', async () => {
    const analysis = await run([
      {
        path: 'src/run.ts',
        base: 'a\n',
        head: 'a\n// eval(x) is not used\nconst v = model.eval();\nconst w = page.$eval(s);\n',
      },
      TEST_FILE,
    ]);
    expect(titled(analysis, /dynamic code evaluation/)).toBeUndefined();
  });

  it('flags a removed try/catch', async () => {
    const base =
      'export function load() {\n  try {\n    return read();\n  } catch (err) {\n    return null;\n  }\n}\n';
    const head = 'export function load() {\n  return read();\n}\n';
    const analysis = await run([{ path: 'src/load.ts', base, head }, TEST_FILE]);
    const risk = titled(analysis, /removed error handling/)!;
    expect(risk).toMatchObject({ category: 'error-handling', severity: 'medium' });
    expect(risk.ref?.side).toBe('base');
  });

  it('does not flag try/catch that merely moved within the file', async () => {
    const base = 'function a() {\n  try {\n    one();\n  } catch (e) {\n    two();\n  }\n}\n';
    const head = 'function a() {\n  try {\n    one();\n  } catch (e) {\n    three();\n  }\n}\n';
    const analysis = await run([{ path: 'src/a.ts', base, head }, TEST_FILE]);
    expect(titled(analysis, /removed error handling/)).toBeUndefined();
  });

  it('flags new empty error handlers on one line and on two lines', async () => {
    const one = await run([
      { path: 'src/a.ts', base: 'a();\n', head: 'a();\ntry { b(); } catch (e) {}\n' },
      TEST_FILE,
    ]);
    expect(titled(one, /ignores the error/)).toMatchObject({ category: 'error-handling' });
    const two = await run([
      { path: 'src/a.ts', base: 'a();\n', head: 'a();\ntry {\n  b();\n} catch (e) {\n}\n' },
      TEST_FILE,
    ]);
    expect(titled(two, /ignores the error/)).toBeDefined();
    const py = await run([
      { path: 'src/a.py', base: 'a()\n', head: 'a()\ntry:\n    b()\nexcept Exception:\n    pass\n' },
      { path: 'tests/test_a.py', base: null, head: 'def test_a():\n    pass\n' },
    ]);
    expect(titled(py, /ignores the error/)).toBeDefined();
  });

  it('flags a new dependency with its dependency ids', async () => {
    const analysis = await run([
      {
        path: 'package.json',
        base: '{"dependencies":{"a":"1.0.0"}}\n',
        head: '{"dependencies":{"a":"1.0.0","left-pad":"^1.3.0"}}\n',
      },
    ]);
    const risk = titled(analysis, /new dependencies/)!;
    expect(risk).toMatchObject({ category: 'dependency', severity: 'low' });
    expect(risk.evidence).toEqual(expect.arrayContaining(['D1', 'F1']));
    expect(risk.detail).toContain('left-pad');
    expect(analysis.dependencies).toEqual([
      expect.objectContaining({
        id: 'D1',
        name: 'left-pad',
        change: 'added',
        to: '^1.3.0',
        ecosystem: 'npm',
        dev: false,
        fileId: 'F1',
      }),
    ]);
  });

  it('points dependency risks at the line that adds the dependency', async () => {
    const manifest = (deps: string) => `{\n  "name": "x",\n  "dependencies": {\n${deps}\n  }\n}\n`;
    const analysis = await run([
      {
        path: 'package.json',
        base: manifest('    "a": "1.0.0"'),
        head: manifest('    "a": "1.0.0",\n    "left-pad": "^1.3.0"'),
      },
    ]);
    const risk = titled(analysis, /new dependencies/)!;
    expect(risk.ref).toEqual({ path: 'package.json', side: 'head', startLine: 5, endLine: 5 });
    expect(risk.evidence).toEqual(expect.arrayContaining(['F1', 'F1.H1', 'D1']));
  });

  it('flags destructive and ordinary migrations differently', async () => {
    const destructive = await run([
      { path: 'db/migrations/002_drop.sql', base: null, head: 'DROP TABLE legacy_users;\n' },
    ]);
    expect(titled(destructive, /destructive schema change/)).toMatchObject({
      category: 'migration',
      severity: 'high',
    });
    const alter = await run([
      { path: 'db/migrations/003_alter.sql', base: null, head: 'ALTER TABLE users ADD COLUMN age int;\n' },
    ]);
    expect(titled(alter, /schema change against existing rows/)).toMatchObject({
      category: 'migration',
      severity: 'medium',
    });
    const create = await run([
      { path: 'db/migrations/001_init.sql', base: null, head: 'CREATE TABLE users (id int);\n' },
    ]);
    expect(titled(create, /new migration/)).toMatchObject({ category: 'migration', severity: 'low' });
    const edited = await run([
      {
        path: 'db/migrations/001_init.sql',
        base: 'CREATE TABLE users (id int);\n',
        head: 'CREATE TABLE users (id bigint);\n',
      },
    ]);
    expect(titled(edited, /editing an existing migration/)).toBeDefined();
  });

  it('detects destructive SQL in application code', async () => {
    const analysis = await run([
      { path: 'src/reset.ts', base: 'a\n', head: 'a\nawait db.query("DROP TABLE sessions");\n' },
      TEST_FILE,
    ]);
    expect(titled(analysis, /destructive statement/)).toMatchObject({ category: 'data', severity: 'high' });
  });

  it('detects SQL built by string concatenation', async () => {
    const analysis = await run([
      {
        path: 'src/q.ts',
        base: 'a\n',
        head: 'a\nconst q = "SELECT * FROM users WHERE id = " + id;\nconst r = `SELECT * FROM t WHERE x = ${x}`;\n',
      },
      TEST_FILE,
    ]);
    expect(titled(analysis, /bound parameters/)).toMatchObject({ category: 'security' });
    const safe = await run([
      { path: 'src/q.ts', base: 'a\n', head: 'a\nconst q = "SELECT * FROM users WHERE id = $1";\n' },
      TEST_FILE,
    ]);
    expect(titled(safe, /bound parameters/)).toBeUndefined();
  });

  it('detects new environment variables and reports them as architecture signals', async () => {
    const analysis = await run([
      {
        path: 'src/config.ts',
        base: 'export const port = process.env.PORT;\n',
        head: 'export const port = process.env.PORT;\nexport const key = process.env.WEATHER_API_KEY;\n',
      },
      TEST_FILE,
    ]);
    const risk = titled(analysis, /environment variables/)!;
    expect(risk).toMatchObject({ category: 'config', severity: 'low' });
    expect(risk.detail).toContain('WEATHER_API_KEY');
    expect(risk.detail).not.toContain('PORT');
    expect(analysis.architectureSignals.some((s) => s.includes('WEATHER_API_KEY'))).toBe(true);
  });

  it('flags source changes that come without test changes', async () => {
    const files: FixtureFile[] = [{ path: 'src/a.ts', base: 'a\n', head: 'a\nb\nc\n' }];
    const without = await run(files);
    expect(titled(without, /covered by tests/)).toMatchObject({ category: 'tests', severity: 'low' });
    const withTests = await run([...files, TEST_FILE]);
    expect(titled(withTests, /covered by tests/)).toBeUndefined();
    const docsOnly = await run([{ path: 'README.md', base: 'a\n', head: 'b\n' }]);
    expect(titled(docsOnly, /covered by tests/)).toBeUndefined();
  });

  it('reports a deleted migration at line 1 on the base side', async () => {
    const analysis = await run([
      { path: 'db/migrations/001_init.sql', base: 'CREATE TABLE users (id int);\n', head: null },
    ]);
    const risk = titled(analysis, /deleting this migration/)!;
    expect(risk.ref).toEqual({ path: 'db/migrations/001_init.sql', side: 'base', startLine: 1, endLine: 1 });
    expect(risk.detail).not.toContain(':0');
  });

  it('never reports a file-level site at line 0 when the first hunk only deletes lines', async () => {
    const analysis = await run([{ path: 'src/a.ts', base: 'const a = 1;\nconst b = 2;\n', head: '' }]);
    const risk = titled(analysis, /covered by tests/)!;
    expect(risk.ref!.startLine).toBeGreaterThanOrEqual(1);
    expect(risk.detail).not.toContain(':0');
  });

  it('flags deleted tests and skipped tests', async () => {
    const deleted = await run([{ path: 'src/a.test.ts', base: "it('a', () => {});\n", head: null }]);
    expect(titled(deleted, /deleted tests/)).toMatchObject({ category: 'tests', severity: 'medium' });
    const skipped = await run([
      { path: 'src/a.test.ts', base: "it('a', () => {});\n", head: "it.skip('a', () => {});\n" },
    ]);
    expect(titled(skipped, /skipped tests/)).toBeDefined();
  });

  it('flags lint suppressions and TODO notes added in changed lines', async () => {
    const analysis = await run([
      {
        path: 'src/a.ts',
        base: 'a\n',
        head: 'a\n// @ts-ignore\nconst x = y as any; // eslint-disable-line\n// TODO: handle retries\n',
      },
      TEST_FILE,
    ]);
    expect(titled(analysis, /suppression/)).toMatchObject({ category: 'error-handling', severity: 'low' });
    expect(titled(analysis, /TODO/)).toMatchObject({ category: 'complexity', severity: 'low' });
  });

  it('flags removed exports and changed signatures as public API changes', async () => {
    const base =
      'export function keep() {\n  return 1;\n}\n\nexport function gone() {\n  return 2;\n}\n\nexport function sig(a: number) {\n  return a;\n}\n';
    const head =
      'export function keep() {\n  return 1;\n}\n\nexport function sig(a: number, b: string) {\n  return a;\n}\n';
    const analysis = await run([{ path: 'src/api.ts', base, head }, TEST_FILE]);
    const removed = titled(analysis, /removed exports/)!;
    expect(removed).toMatchObject({ category: 'public-api', severity: 'medium' });
    expect(removed.detail).toContain('gone');
    expect(removed.evidence.some((id) => /^S\d+$/.test(id))).toBe(true);
    expect(titled(analysis, /changed signatures/)?.detail).toContain('sig');
  });

  it('flags concurrency primitives and awaits inside loops', async () => {
    const analysis = await run([
      {
        path: 'src/a.ts',
        base: 'a\n',
        head: 'a\nconst all = await Promise.all(jobs);\nfor (const job of jobs) {\n  await job.run();\n}\n',
      },
      TEST_FILE,
    ]);
    expect(titled(analysis, /concurrent code/)).toMatchObject({ category: 'concurrency' });
    expect(titled(analysis, /async calls inside a loop/)).toMatchObject({ category: 'concurrency' });
  });

  it('flags changed timeout and retry numbers', async () => {
    const analysis = await run([
      {
        path: 'src/http.ts',
        base: 'const options = {\n  timeoutMs: 1000,\n  retries: 3,\n};\n',
        head: 'const options = {\n  timeoutMs: 5000,\n  retries: 3,\n};\n',
      },
      TEST_FILE,
    ]);
    const risk = titled(analysis, /timeout, retry or interval/)!;
    expect(risk).toMatchObject({ category: 'performance', severity: 'low' });
    expect(risk.detail).toContain('timeoutMs: 1000 to 5000');
  });

  it('flags very large hunks and very long functions', async () => {
    const body = Array.from({ length: 140 }, (_, i) => `  total += ${i};`).join('\n');
    const head = `export function big() {\n  let total = 0;\n${body}\n  return total;\n}\n`;
    const analysis = await run([{ path: 'src/big.ts', base: null, head }, TEST_FILE]);
    expect(titled(analysis, /large change/)).toMatchObject({ category: 'complexity' });
    expect(titled(analysis, /long function/)?.detail).toMatch(/big spans 14\d lines/);
  });

  it('flags TLS verification turned off and unsafe HTML', async () => {
    const analysis = await run([
      {
        path: 'src/a.ts',
        base: 'a\n',
        head: 'a\nconst agent = { rejectUnauthorized: false };\nel.innerHTML = html;\n',
      },
      TEST_FILE,
    ]);
    expect(titled(analysis, /TLS certificate verification/)).toMatchObject({
      category: 'security',
      severity: 'high',
    });
    expect(titled(analysis, /HTML inserted here/)).toMatchObject({
      category: 'security',
      severity: 'medium',
    });
  });

  it('flags changes to security-sensitive files', async () => {
    const analysis = await run([{ path: 'src/auth/login.ts', base: 'a\n', head: 'b\n' }, TEST_FILE]);
    expect(titled(analysis, /security-sensitive code/)).toMatchObject({
      category: 'security',
      severity: 'medium',
    });
  });

  it('never inspects sensitive files', async () => {
    const analysis = await run([{ path: '.env', base: null, head: 'API=eval(x)\n', sensitive: true }]);
    expect(analysis.risks).toEqual([]);
  });

  it('keeps at most 10 risks, highest severity first, with sequential ids', async () => {
    const lines = [
      'eval(a);',
      'child_process.exec(a);',
      'el.innerHTML = a;',
      'const v = { rejectUnauthorized: false };',
      'try { a(); } catch (e) {}',
      'await Promise.all(a);',
      '// TODO: later',
      '// @ts-ignore',
      'const k = process.env.NEW_ONE;',
      'const t = { timeoutMs: 9000 };',
      'const q = "DELETE FROM users";',
      'const s = `SELECT * FROM t WHERE a = ${a}`;',
    ];
    const analysis = await run([
      { path: 'src/auth/session.ts', base: 'old\n', head: `old\n${lines.join('\n')}\n` },
      {
        path: 'package.json',
        base: '{"dependencies":{}}\n',
        head: '{"dependencies":{"a":"1","b":"1","c":"1","d":"1","e":"1"}}\n',
      },
      { path: 'db/migrations/9_drop.sql', base: null, head: 'DROP TABLE x;\n' },
    ]);
    expect(analysis.risks.length).toBe(10);
    const rank = { high: 3, medium: 2, low: 1, info: 0 } as const;
    const ranks = analysis.risks.map((r) => rank[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(analysis.risks.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `R${i + 1}`));
    expect(analysis.risks.every((r) => /^(Check|Confirm)\b/.test(r.title))).toBe(true);
  });
});

describe('risk kinds', () => {
  it('give every line rule a review prompt that asks, and a verb that matches what it watches', () => {
    for (const rule of LINE_RULES) {
      const kind = RISK_KINDS[rule.key];
      expect(kind.title, rule.key).toMatch(/^(Check|Confirm) /);
      expect(kind.verb, rule.key).toBe(rule.on === 'removed' ? 'Removes' : 'Adds');
    }
  });

  it('start every title with Check or Confirm', () => {
    for (const [key, kind] of Object.entries(RISK_KINDS))
      expect(kind.title, key).toMatch(/^(Check|Confirm) /);
  });
});
