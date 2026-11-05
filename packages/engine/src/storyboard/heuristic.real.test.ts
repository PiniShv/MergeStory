/**
 * The offline storyboard for changes that the real analyzer has read: several languages, shapes of
 * change and sizes. Every storyboard has to pass the grounding validator without a single warning
 * or repair, and every code scene has to talk only about code that is on screen.
 */
import { describe, expect, it } from 'vitest';
import type { Scene } from '../core/storyboard-schema.ts';
import {
  type AnalysedChange,
  analysedChange,
  expectCleanStoryboard,
  focusProblems,
  symbolsOffScreen,
} from '../testing/analysed.ts';

const text = (...lines: string[]): string => `${lines.join('\n')}\n`;
const sentences = (scene: Scene): string[] => scene.narration.map((line) => line.text);

const CASES: Record<string, () => Promise<AnalysedChange>> = {
  'a Python module with a new function, a modified one and a test': () =>
    analysedChange(
      [
        {
          path: 'app/reports.py',
          language: 'python',
          base: text(
            'from decimal import Decimal',
            '',
            '',
            'def format_report(number, lines):',
            '    """Return the report as text."""',
            '    out = [f"Report {number}"]',
            '    for name, price in lines:',
            '        out.append(f"{name}: {price}")',
            '    out.append(f"Total: {sum(price for _, price in lines)}")',
            '    return "\\n".join(out)',
          ),
          head: text(
            'from decimal import Decimal',
            '',
            'BONUS_RATE = Decimal("0.2")',
            '',
            '',
            'def total_with_bonus(lines):',
            '    """Return the sum of all line prices plus the bonus."""',
            '    base_total = sum(price for _, price in lines)',
            '    return base_total * (1 + BONUS_RATE)',
            '',
            '',
            'def format_report(number, lines):',
            '    """Return the report as text."""',
            '    out = [f"Report {number}"]',
            '    for name, price in lines:',
            '        out.append(f"{name}: {price}")',
            '    out.append(f"Total: {total_with_bonus(lines)}")',
            '    return "\\n".join(out)',
          ),
        },
        {
          path: 'tests/test_reports.py',
          language: 'python',
          head: text(
            'from app.reports import total_with_bonus',
            '',
            'def test_total():',
            '    assert total_with_bonus([("a", 10)]) == 12',
          ),
        },
      ],
      {
        task: 'Add a bonus to every report. Keep the line scores as they are.',
        notes: '- total_with_bonus adds a flat BONUS_RATE of 20 percent to the sum of the line prices.',
      },
    ),

  'a Go handler with a new constant, a new function and a modified function': () =>
    analysedChange([
      {
        path: 'server/handler.go',
        language: 'go',
        base: text(
          'package server',
          '',
          'import "net/http"',
          '',
          'func Health(w http.ResponseWriter, r *http.Request) {',
          '\tw.WriteHeader(http.StatusOK)',
          '}',
        ),
        head: text(
          'package server',
          '',
          'import "net/http"',
          '',
          '// MaxBodyBytes limits the size of a request body.',
          'const MaxBodyBytes = 1 << 20',
          '',
          'func Health(w http.ResponseWriter, r *http.Request) {',
          '\tw.WriteHeader(http.StatusOK)',
          '\tw.Write([]byte("ok"))',
          '}',
          '',
          'func Ready(w http.ResponseWriter, r *http.Request) {',
          '\tif !started {',
          '\t\tw.WriteHeader(http.StatusServiceUnavailable)',
          '\t\treturn',
          '\t}',
          '\tw.WriteHeader(http.StatusOK)',
          '}',
        ),
      },
    ]),

  'a Java class with a modified method and a new method': () =>
    analysedChange(
      [
        {
          path: 'src/main/java/com/acme/Cart.java',
          language: 'java',
          base: text(
            'package com.acme;',
            '',
            'public class Cart {',
            '    private final List<Item> items = new ArrayList<>();',
            '',
            '    public int total() {',
            '        int sum = 0;',
            '        for (Item item : items) {',
            '            sum += item.price();',
            '        }',
            '        return sum;',
            '    }',
            '}',
          ),
          head: text(
            'package com.acme;',
            '',
            'public class Cart {',
            '    private final List<Item> items = new ArrayList<>();',
            '',
            '    public int total() {',
            '        int sum = 0;',
            '        for (Item item : items) {',
            '            sum += item.price() * item.quantity();',
            '        }',
            '        return sum;',
            '    }',
            '',
            '    public void applyCoupon(String code) {',
            '        coupons.add(code);',
            '    }',
            '}',
          ),
        },
      ],
      {
        pr: {
          title: 'Count quantities in the cart total',
          body: 'The cart total multiplies each price by its quantity.',
        },
      },
    ),

  'a workflow file': () =>
    analysedChange([
      {
        path: '.github/workflows/ci.yml',
        language: 'yaml',
        base: text(
          'name: ci',
          'on: [push]',
          'jobs:',
          '  test:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: npm test',
        ),
        head: text(
          'name: ci',
          'on: [push, pull_request]',
          'jobs:',
          '  test:',
          '    runs-on: ubuntu-latest',
          '    timeout-minutes: 15',
          '    steps:',
          '      - uses: actions/setup-node@v4',
          '        with:',
          '          node-version: 22',
          '      - run: npm ci',
          '      - run: npm test',
        ),
      },
    ]),

  'a change to documentation only': () =>
    analysedChange([
      {
        path: 'docs/guide.md',
        language: 'markdown',
        base: text('# Guide', '', 'Install it.'),
        head: text('# Guide', '', 'Install it.', '', '## Usage', '', 'Run the tool with a path.'),
      },
    ]),

  'a deleted file and the call that went with it': () =>
    analysedChange([
      {
        path: 'src/old.ts',
        language: 'typescript',
        status: 'deleted',
        base: text(
          'export function legacy(a: number): number {',
          '  return a * 2;',
          '}',
          '',
          'export const LEGACY_LIMIT = 5;',
        ),
      },
      {
        path: 'src/main.ts',
        language: 'typescript',
        base: text("import { legacy } from './old.ts';", 'export const run = () => legacy(2);'),
        head: text('export const run = () => 4;'),
      },
    ]),

  'a renamed file with one edit': () =>
    analysedChange([
      {
        path: 'src/helpers.ts',
        oldPath: 'src/util.ts',
        status: 'renamed',
        language: 'typescript',
        base: text(
          'export function slug(text: string): string {',
          '  return text.toLowerCase().replace(/ /g, "-");',
          '}',
        ),
        head: text(
          'export function slug(text: string): string {',
          '  return text.trim().toLowerCase().replace(/\\s+/g, "-");',
          '}',
        ),
      },
    ]),

  'three packages that import from each other': () =>
    analysedChange(
      [
        {
          path: 'packages/core/src/auth.ts',
          language: 'typescript',
          head: text(
            'export function verifyToken(token: string): boolean {',
            '  return token.length > 10;',
            '}',
            '',
            'export const TOKEN_TTL_SECONDS = 3600;',
          ),
        },
        {
          path: 'packages/api/src/routes.ts',
          language: 'typescript',
          base: text(
            "import { json } from './json.ts';",
            '',
            'export function health() {',
            '  return json({ ok: true });',
            '}',
          ),
          head: text(
            "import { json } from './json.ts';",
            "import { verifyToken } from '../../core/src/auth.ts';",
            '',
            'export function health() {',
            '  return json({ ok: true });',
            '}',
            '',
            'export function me(token: string) {',
            '  if (!verifyToken(token)) return json({ error: "denied" });',
            '  return json({ ok: true });',
            '}',
          ),
        },
        {
          path: 'packages/web/src/login.ts',
          language: 'typescript',
          base: text('export function login() {', '  return fetch("/login");', '}'),
          head: text(
            "import { verifyToken } from '../../core/src/auth.ts';",
            '',
            'export function login(token: string) {',
            '  if (!verifyToken(token)) return null;',
            '  return fetch("/login");',
            '}',
          ),
        },
      ],
      {
        pr: {
          title: 'Check tokens before login',
          body: 'Both the API and the web app now verify the token first.',
        },
        notes: '- verifyToken only checks the length of the token.',
      },
    ),

  'a dependency update with the code that uses it': () =>
    analysedChange([
      {
        path: 'package.json',
        language: 'json',
        base: text('{', '  "name": "app",', '  "dependencies": {', '    "undici": "6.0.0"', '  }', '}'),
        head: text(
          '{',
          '  "name": "app",',
          '  "dependencies": {',
          '    "undici": "6.1.0",',
          '    "zod": "4.0.0"',
          '  }',
          '}',
        ),
      },
      {
        path: 'src/app.ts',
        language: 'typescript',
        base: text('export const NAME = "app";'),
        head: text('import { z } from "zod";', 'export const NAME = z.string().parse("app");'),
      },
    ]),

  'a migration and the model it changes': () =>
    analysedChange([
      {
        path: 'db/migrations/002_add_email.sql',
        language: 'sql',
        head: text(
          'ALTER TABLE users ADD COLUMN email TEXT;',
          'CREATE UNIQUE INDEX users_email ON users (email);',
        ),
      },
      {
        path: 'app/models.py',
        language: 'python',
        base: text('class User:', '    name: str'),
        head: text('class User:', '    name: str', '    email: str'),
      },
    ]),

  'a long function that changed in the middle': () => {
    const body = (marker: string) =>
      Array.from({ length: 50 }, (_, i) => `  total += ${i === 30 ? marker : i};`);
    return analysedChange([
      {
        path: 'src/sum.ts',
        language: 'typescript',
        base: text(
          'export function sum(): number {',
          '  let total = 0;',
          ...body('30'),
          '  return total;',
          '}',
        ),
        head: text(
          'export function sum(): number {',
          '  let total = 0;',
          ...body('threshold'),
          '  return total;',
          '}',
        ),
      },
    ]);
  },
};

describe('the offline storyboard for changes read by the real analyzer', () => {
  it.each(Object.entries(CASES))('is clean and describes only code on screen: %s', async (_name, create) => {
    const change = await create();
    for (const targetSec of [1, 20, 45, 100, 150, 300]) {
      const storyboard = change.storyboard(targetSec);
      expect(await expectCleanStoryboard(change, storyboard)).toEqual([]);
      expect(focusProblems(storyboard)).toEqual([]);
      expect(symbolsOffScreen(storyboard, change.analysis)).toEqual([]);
    }
    expect(change.storyboard(100)).toEqual(change.storyboard(100));
  });

  it('describes a modified method and a new one in one window, and not the class around them', async () => {
    const change = await CASES['a Java class with a modified method and a new method']!();
    const scenes = change.storyboard(300).scenes.filter((s) => s.visual.type === 'code');
    expect(scenes).toHaveLength(1);
    expect(sentences(scenes[0]!).join(' ')).toContain('the method Cart.applyCoupon is new and public');
    expect(sentences(scenes[0]!).join(' ')).toContain('The method Cart.total was changed too');
    expect(sentences(scenes[0]!).join(' ')).not.toContain('class Cart');
  });

  it('says what a Go function is: exported, new', async () => {
    const change = await CASES['a Go handler with a new constant, a new function and a modified function']!();
    const first = change.storyboard(300).scenes.find((s) => s.visual.type === 'code')!;
    expect(sentences(first)[0]).toBe('In handler.go, the function Ready is new and exported.');
  });

  it('shows documentation, workflows and migrations as files, and says only what changed', async () => {
    for (const name of ['a change to documentation only', 'a workflow file']) {
      const change = await CASES[name]!();
      const storyboard = change.storyboard(150);
      expect(storyboard.scenes[1]!.visual.type).toBe('files');
      const code = storyboard.scenes.find((s) => s.visual.type === 'code')!;
      expect(sentences(code)[0]).toMatch(/changes here, with \d+ lines? added/);
    }
  });

  it('draws the packages and the imports between them', async () => {
    const change = await CASES['three packages that import from each other']!();
    const scene = change.storyboard(150).scenes[1]!;
    expect(scene.visual.type).toBe('architecture');
    if (scene.visual.type !== 'architecture') return;
    expect(scene.visual.nodes.map((n) => n.label)).toEqual(['api', 'core', 'web']);
    expect(scene.visual.edges.map((e) => e.label)).toEqual(['imports', 'imports']);
    expect(sentences(scene)).toEqual([
      'The change touches 3 files in 3 components.',
      'The biggest part is the api code, with 6 lines added.',
      'The api code imports from the core package. The web package imports from the core package.',
    ]);
  });

  it('says a constant is its own value, and names the symbol a review signal was found in', async () => {
    const change = await CASES['three packages that import from each other']!();
    const storyboard = change.storyboard(300);
    const code = storyboard.scenes.find((s) => s.visual.type === 'code')!;
    expect(sentences(code)).toContain('TOKEN_TTL_SECONDS is 3600.');
    const review = storyboard.scenes.find((s) => s.role === 'review')!;
    expect(sentences(review)).toContain(
      'Second: Confirm the change to security-sensitive code is intended, in verifyToken. The analysis rates it medium.',
    );
    // The value belongs to the constant itself, so the signal does not say where it is.
    expect(sentences(review).join(' ')).toContain(
      'Check the changed timeout, retry or interval values. It sets TOKEN_TTL_SECONDS to 3600.',
    );
  });

  it('names what changed in a dependency file and what was imported', async () => {
    const change = await CASES['a dependency update with the code that uses it']!();
    const files = change.storyboard(300).scenes[1]!;
    expect(sentences(files).at(-1)).toBe(
      'It adds the dependency zod. It updates undici from 6.0.0 to 6.1.0.',
    );
  });

  it('says in the review which dependencies a signal is about', async () => {
    const change = await CASES['a dependency update with the code that uses it']!();
    const review = change.storyboard(300).scenes.find((s) => s.role === 'review')!;
    expect(sentences(review)).toContain(
      'First: Confirm the new dependencies are needed and maintained, in package.json. It adds zod.',
    );
  });

  it('keeps the signature on screen when only the middle of a function changed, and points at the change', async () => {
    const change = await CASES['a long function that changed in the middle']!();
    const code = change.storyboard(150).scenes.find((s) => s.visual.type === 'code')!;
    if (code.visual.type !== 'code') return;
    expect(code.visual.ref.endLine - code.visual.ref.startLine + 1).toBe(18);
    // Line 33 holds the change (the first line is the signature, the second declares total).
    expect(code.visual.ref.startLine).toBeLessThanOrEqual(33);
    expect(code.visual.ref.endLine).toBeGreaterThanOrEqual(33);
    expect(code.visual.focus[0]).toMatchObject({ note: 'Changed function sum' });
    expect(sentences(code)[0]).toBe('In sum.ts, the function sum was changed and is exported.');
  });

  it('tells a removed function and its constant, from the base side of the deleted file', async () => {
    const change = await CASES['a deleted file and the call that went with it']!();
    const code = change
      .storyboard(300)
      .scenes.find((s) => s.visual.type === 'code' && s.visual.ref.path === 'src/old.ts')!;
    expect(code.visual.type === 'code' && code.visual.ref.side).toBe('base');
    expect(sentences(code)).toEqual([
      'In old.ts, the function legacy was removed. It was exported.',
      'The constant LEGACY_LIMIT was removed too.',
    ]);
  });

  it('shows both sides of a renamed file with one small edit', async () => {
    const change = await CASES['a renamed file with one edit']!();
    const scene = change.storyboard(150).scenes.find((s) => s.role === 'before-after')!;
    if (scene.visual.type !== 'before-after') throw new Error('expected a before-after scene');
    expect(scene.visual.before.codeRef).toMatchObject({
      path: 'src/helpers.ts',
      side: 'base',
      startLine: 1,
      endLine: 3,
    });
    expect(scene.visual.after.codeRef).toMatchObject({
      path: 'src/helpers.ts',
      side: 'head',
      startLine: 1,
      endLine: 3,
    });
  });

  it('quotes the notes next to the function they name', async () => {
    const change = await CASES['a Python module with a new function, a modified one and a test']!();
    const code = change.storyboard(300).scenes.find((s) => s.visual.type === 'code')!;
    expect(sentences(code)).toContain(
      'The notes say: total_with_bonus adds a flat BONUS_RATE of 20 percent to the sum of the line prices.',
    );
  });

  it('keeps its promises when privacy settings hide part of the change', async () => {
    const change = await analysedChange(
      [
        {
          path: 'src/secret/keys.ts',
          language: 'typescript',
          head: text('export function loadKeys(): string[] {', '  return [];', '}'),
        },
        {
          path: 'src/open.ts',
          language: 'typescript',
          head: text('export function openDoor(): void {', '  go();', '}'),
        },
      ],
      { config: { privacy: { excludePaths: ['src/secret/'] } } },
    );
    for (const targetSec of [20, 100, 300]) {
      const storyboard = change.storyboard(targetSec);
      expect(await expectCleanStoryboard(change, storyboard)).toEqual([]);
      expect(JSON.stringify(storyboard)).not.toMatch(/keys\.ts|loadKeys/);
    }
  });
});
