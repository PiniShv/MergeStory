/**
 * The documentation is part of the product. Links must lead to a file and a heading that exist, and
 * the pages that list the command line, the settings and the environment variables must name every
 * one of them, with the defaults the code has. A page that sends people to a missing file, or leaves a
 * flag out, is a bug.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createIo } from '../src/cli/io.ts';
import { buildProgram } from '../src/cli/program.ts';
import { CliRuntime } from '../src/cli/runtime.ts';
import { ConfigSchema, configFromEnv, QUALITY_PRESETS, SECRET_ENV_VARS } from '../src/core/config.ts';
import { EXIT_CODES } from '../src/core/errors.ts';

const engine = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(engine, '..', '..');
const hasDocs = existsSync(join(repository, 'docs', 'cli.md'));

function read(...parts: string[]): string {
  return readFileSync(join(repository, ...parts), 'utf8');
}

function files(dir: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (keep(entry.name)) found.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/** Every Markdown page of the repository, except the files of the demo repository itself. */
function markdownPages(): string[] {
  const pages = ['docs', 'plugins', 'examples']
    .flatMap((dir) => files(join(repository, dir), (name) => name.endsWith('.md')))
    .filter((path) => !/examples[\\/]demo[\\/](base|feature)[\\/]/.test(path));
  for (const name of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
    if (existsSync(join(repository, name))) pages.push(join(repository, name));
  }
  return pages;
}

/** The lines of a page, with the lines of fenced code blocks blanked out. */
function linesWithoutFences(text: string): string[] {
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    return line;
  });
}

/** The anchor that GitHub makes from a heading: lower case, no punctuation, hyphens for spaces. */
function slugOf(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of linesWithoutFences(text)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = slugOf(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** The targets of the links of a page. Code is not a link, so code blocks and code spans are skipped. */
function linkTargets(text: string): string[] {
  const prose = linesWithoutFences(text)
    .map((line) => line.replace(/`[^`\n]*`/g, ''))
    .join('\n');
  return [...prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] as string);
}

describe.skipIf(!hasDocs)('the Markdown pages', () => {
  it('only link to files and headings that exist', () => {
    const broken: string[] = [];
    for (const page of markdownPages()) {
      const text = readFileSync(page, 'utf8');
      for (const target of linkTargets(text)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
        const [path = '', anchor] = target.split('#');
        const file = path === '' ? page : resolve(dirname(page), decodeURI(path));
        const name = `${relative(repository, page)} -> ${target}`;
        if (!existsSync(file)) {
          broken.push(`${name} (no such file)`);
        } else if (anchor && file.endsWith('.md') && !anchorsOf(readFileSync(file, 'utf8')).has(anchor)) {
          broken.push(`${name} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('only say "see docs/..." about pages that exist, in the docs, the example workflow and the hints', () => {
    const sources = files(join(engine, 'src'), (name) => name.endsWith('.ts') && !/\.test\.ts$/.test(name));
    const places = [
      ...markdownPages(),
      join(repository, 'examples', 'github-actions', 'mergestory.yml'),
      ...sources,
    ];
    const missing: string[] = [];
    let mentions = 0;
    for (const place of places) {
      for (const match of readFileSync(place, 'utf8').matchAll(/[Ss]ee (docs\/[A-Za-z0-9_./-]+\.md)/g)) {
        mentions += 1;
        if (!existsSync(join(repository, match[1] as string)))
          missing.push(`${relative(repository, place)}: ${match[1]}`);
      }
    }
    expect(mentions).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

/** The text of the section that starts with this heading line, up to the next heading of the same or a higher level. */
function section(page: string, heading: string): string {
  const lines = page.split('\n');
  // A "#" line inside a code block is a comment, not a heading.
  const outside = linesWithoutFences(page);
  const start = lines.indexOf(heading);
  if (start < 0) return '';
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const found = /^(#+)\s/.exec(outside[i] as string)?.[1];
    if (found && found.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** Whether a page names a flag. `--task` is not found inside `--task-file`. */
function namesFlag(text: string, flag: string): boolean {
  return new RegExp(`${flag.replace(/-/g, '\\-')}(?![\\w-])`).test(text);
}

interface CommandInfo {
  path: string;
  flags: string[];
}

/** The commands that do something (not the ones that only group other commands), with their own flags. */
function leafCommands(command: Command, prefix = ''): CommandInfo[] {
  return command.commands.flatMap((child) => {
    const path = prefix === '' ? child.name() : `${prefix} ${child.name()}`;
    // "worker" is the internal command that `generate --async` starts. It is not documented on purpose.
    if (path === 'worker') return [];
    if (child.commands.length > 0) return leafCommands(child, path);
    return [{ path, flags: child.options.flatMap((option) => (option.long ? [option.long] : [])) }];
  });
}

describe.skipIf(!hasDocs)('docs/cli.md', () => {
  const page = hasDocs ? read('docs', 'cli.md') : '';
  const program = buildProgram(new CliRuntime(createIo(), new AbortController().signal));

  it('has a section for every command that names every flag of that command', () => {
    const problems: string[] = [];
    for (const { path, flags } of leafCommands(program)) {
      const text = section(page, `## \`mergestory ${path}\``);
      if (text === '') {
        problems.push(`no section for "mergestory ${path}"`);
        continue;
      }
      for (const flag of flags) if (!namesFlag(text, flag)) problems.push(`${path}: ${flag} is not named`);
    }
    expect(problems).toEqual([]);
  });

  it('names every global option', () => {
    const text = section(page, '### Global options');
    const missing = program.options.flatMap((option) =>
      option.long && !namesFlag(text, option.long) ? [option.long] : [],
    );
    expect(missing).toEqual([]);
  });

  it('lists every error code in the row of its exit code', () => {
    const rows = new Map<number, string>();
    for (const line of section(page, '## Exit codes').split('\n')) {
      const match = /^\|\s*(\d+)\s*\|(.*)$/.exec(line);
      if (match) rows.set(Number(match[1]), match[2] as string);
    }
    const wrong = Object.entries(EXIT_CODES).flatMap(([code, exit]) =>
      rows.get(exit)?.includes(`\`${code}\``) ? [] : [`${code} (exit code ${exit})`],
    );
    expect(wrong).toEqual([]);
  });
});

/** The dotted paths of every setting, taken from the defaults of the schema. */
function settingPaths(value: unknown, prefix = ''): { path: string; value: unknown }[] {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject || Object.keys(value).length === 0) return [{ path: prefix, value }];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    settingPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/** The environment variables that configFromEnv reads, found by watching which names it asks for. */
function variablesReadByConfig(): string[] {
  const asked = new Set<string>();
  const env = new Proxy({} as NodeJS.ProcessEnv, {
    get(_target, name) {
      if (typeof name === 'string') asked.add(name);
      return undefined;
    },
  });
  configFromEnv(env);
  return [...asked];
}

describe.skipIf(!hasDocs)('docs/configuration.md', () => {
  const page = hasDocs ? read('docs', 'configuration.md') : '';

  it('describes every setting, with the default of the code', () => {
    const rows = new Map<string, string[]>();
    for (const line of page.split('\n')) {
      const match = /^\|\s*`([A-Za-z0-9.]+)`\s*\|(.*)$/.exec(line);
      if (match)
        rows.set(
          match[1] as string,
          (match[2] as string).split('|').map((cell) => cell.trim()),
        );
    }
    const problems: string[] = [];
    for (const { path, value } of settingPaths(ConfigSchema.parse({}))) {
      const cells = rows.get(path);
      if (!cells) {
        problems.push(`${path} has no row`);
        continue;
      }
      const shown = (cells[0] ?? '').replace(/[`"]/g, '');
      const expected = Array.isArray(value)
        ? '[]'
        : value !== null && typeof value === 'object'
          ? '{}'
          : String(value);
      if (shown !== expected)
        problems.push(`${path}: the page says "${shown}", the default is "${expected}"`);
    }
    expect(problems).toEqual([]);
  });

  it('names every environment variable that MergeStory reads', () => {
    const others = [
      'MERGESTORY_CONFIG',
      'MERGESTORY_HOME',
      'MERGESTORY_LOG_LEVEL',
      'MERGESTORY_LOG_FORMAT',
      'MERGESTORY_KOKORO_DTYPE',
      'ANTHROPIC_BASE_URL',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'PLAYWRIGHT_BROWSERS_PATH',
      'NO_COLOR',
      'FORCE_COLOR',
    ];
    const names = [...new Set([...variablesReadByConfig(), ...SECRET_ENV_VARS, ...others])];
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((name) => !page.includes(`\`${name}\``))).toEqual([]);
  });

  it('lists the quality presets of the code', () => {
    const wrong = Object.entries(QUALITY_PRESETS).flatMap(([name, preset]) => {
      const row = page.split('\n').find((line) => line.startsWith(`| \`${name}\` | `)) ?? '';
      const cells = row.split('|').map((cell) => cell.trim().replace(/`/g, ''));
      const matches =
        cells[2] === `${preset.width} x ${preset.height}` &&
        cells[3] === String(preset.fps) &&
        cells[4] === String(preset.crf) &&
        cells[5] === preset.x264Preset;
      return matches ? [] : [name];
    });
    expect(wrong).toEqual([]);
  });
});

/** The first cell of every row of the tables whose first header cell is "Code". */
function codesInTables(page: string): string[] {
  const codes: string[] = [];
  let inTable = false;
  for (const line of page.split('\n')) {
    if (/^\|\s*Code\s*\|/.test(line)) {
      inTable = true;
    } else if (!line.startsWith('|')) {
      inTable = false;
    } else if (inTable) {
      const code = /^\|\s*`([a-z]+(?:-[a-z]+)*)`\s*\|/.exec(line)?.[1];
      if (code) codes.push(code);
    }
  }
  return codes;
}

describe.skipIf(!hasDocs)('the validator codes in the docs', () => {
  // A code only counts when it is written as a quoted string in the code that checks storyboards.
  const quoted = new Set<string>();
  for (const dir of ['storyboard', 'pipeline']) {
    for (const file of files(
      join(engine, 'src', dir),
      (name) => name.endsWith('.ts') && !/\.test\.ts$/.test(name),
    )) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'([a-z]+(?:-[a-z]+)*)'/g))
        quoted.add(match[1] as string);
    }
  }

  for (const [name, parts] of [
    ['docs/storyboard.md', ['docs', 'storyboard.md']],
    [
      'the skill troubleshooting guide',
      ['plugins', 'mergestory', 'skills', 'mergestory', 'references', 'troubleshooting.md'],
    ],
  ] as const) {
    it(`are all emitted by the validator (${name})`, () => {
      const codes = codesInTables(read(...parts));
      expect(codes.length).toBeGreaterThan(8);
      expect(codes.filter((code) => !quoted.has(code))).toEqual([]);
    });
  }
});

describe.skipIf(!hasDocs)('the other pages', () => {
  it('docs/github-actions.md names every variable and secret that the example workflow uses', () => {
    const workflow = read('examples', 'github-actions', 'mergestory.yml');
    const used = [
      ...new Set(
        [...workflow.matchAll(/\b(?:vars|secrets)\.([A-Z][A-Z0-9_]+)/g)].map((match) => match[1] as string),
      ),
    ];
    const page = read('docs', 'github-actions.md');
    expect(used.length).toBeGreaterThan(3);
    expect(used.filter((name) => !page.includes(`\`${name}\``))).toEqual([]);
  });

  it('docs/api.md names every route and every function of the library', () => {
    const page = read('docs', 'api.md');
    const wanted = ['GET /v1/health', 'POST /v1/jobs', 'GET /v1/jobs/:id', 'GET /v1/jobs?limit'];
    for (const name of ['generate', 'prepareAuthoring', 'checkStoryboard', 'publishRun', 'startServer'])
      wanted.push(`\`${name}\``);
    expect(wanted.filter((text) => !page.includes(text))).toEqual([]);
  });

  it('README.md links to every page of docs/', () => {
    const readme = read('README.md');
    const pages = readdirSync(join(repository, 'docs')).filter((name) => name.endsWith('.md'));
    expect(pages.filter((name) => !readme.includes(`(docs/${name})`))).toEqual([]);
  });
});
