import { bundledLanguagesInfo } from 'shiki';
import { describe, expect, it } from 'vitest';
import { languageForPath, languageIds, languageInfo } from './languages.ts';

describe('languageForPath', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['lib/types.d.ts', 'typescript'],
    ['ui/App.tsx', 'tsx'],
    ['a.js', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['view.jsx', 'jsx'],
    ['package.json', 'json'],
    ['tsconfig.json', 'jsonc'],
    ['tsconfig.build.json', 'jsonc'],
    ['README.md', 'markdown'],
    ['docs/page.mdx', 'mdx'],
    ['tool.py', 'python'],
    ['TOOL.PY', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['A.java', 'java'],
    ['A.kt', 'kotlin'],
    ['build.gradle.kts', 'kotlin'],
    ['build.gradle', 'groovy'],
    ['x.rb', 'ruby'],
    ['Gemfile', 'ruby'],
    ['x.php', 'php'],
    ['x.cs', 'csharp'],
    ['x.c', 'c'],
    ['x.h', 'c'],
    ['x.cpp', 'cpp'],
    ['x.hpp', 'cpp'],
    ['x.swift', 'swift'],
    ['x.m', 'objective-c'],
    ['run.sh', 'shellscript'],
    ['run.bash', 'shellscript'],
    ['run.zsh', 'shellscript'],
    ['.bashrc', 'shellscript'],
    ['x.ps1', 'powershell'],
    ['ci.yaml', 'yaml'],
    ['ci.yml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['x.ini', 'ini'],
    ['q.sql', 'sql'],
    ['index.html', 'html'],
    ['a.css', 'css'],
    ['a.scss', 'scss'],
    ['a.less', 'less'],
    ['A.vue', 'vue'],
    ['A.svelte', 'svelte'],
    ['A.astro', 'astro'],
    ['Dockerfile', 'docker'],
    ['docker/Dockerfile.dev', 'docker'],
    ['web.dockerfile', 'docker'],
    ['Makefile', 'make'],
    ['rules.mk', 'make'],
    ['schema.graphql', 'graphql'],
    ['api.proto', 'proto'],
    ['infra/main.tf', 'terraform'],
    ['infra/main.hcl', 'hcl'],
    ['x.lua', 'lua'],
    ['x.dart', 'dart'],
    ['x.ex', 'elixir'],
    ['x.exs', 'elixir'],
    ['x.erl', 'erlang'],
    ['x.r', 'r'],
    ['x.jl', 'julia'],
    ['x.zig', 'zig'],
    ['x.nim', 'nim'],
    ['pom.xml', 'xml'],
    ['x.prisma', 'prisma'],
    ['.env', 'dotenv'],
    ['.env.local', 'dotenv'],
  ])('%s -> %s', (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each([
    'LICENSE',
    'notes.txt',
    '.gitignore',
    'data.unknownext',
    'folder/',
    '',
    'x.',
    'constructor',
    'src/__proto__',
    'x.constructor',
  ])('has no language for %j', (path) => {
    expect(languageForPath(path)).toBeNull();
  });

  it('only returns ids that Shiki can load', () => {
    const known = new Set(bundledLanguagesInfo.map((info) => info.id));
    const unknown = languageIds().filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });
});

describe('languageInfo', () => {
  const info = (path: string) => languageInfo(languageForPath(path) ?? 'none');

  it.each([
    'src/a.ts',
    'ui/App.tsx',
    'tool.py',
    'main.go',
    'index.html',
    'a.css',
    'q.sql',
    'api.proto',
    'schema.graphql',
    'infra/main.tf',
    'CMakeLists.txt',
    'run.sh',
  ])('counts %s as code', (path) => {
    expect(info(path).isCode).toBe(true);
  });

  it.each([
    'README.md',
    'docs/page.mdx',
    'notes.rst',
    'package.json',
    'tsconfig.json',
    'config.json5',
    'ci.yml',
    'Cargo.toml',
    'x.ini',
    'pom.xml',
    'data.csv',
    'data.tsv',
    'events.jsonl',
    'x.diff',
    'build.log',
    '.env',
    'Dockerfile',
    'Containerfile',
    'docker/Dockerfile.dev',
    'web.dockerfile',
    'Makefile',
    'GNUmakefile',
    'rules.mk',
  ])('does not count %s as a language', (path) => {
    expect(info(path).isCode).toBe(false);
  });

  it('flags exactly the prose, data, configuration and build ids that the registry returns', () => {
    const notCode = languageIds().filter((id) => !languageInfo(id).isCode);
    expect(notCode).toEqual([
      'csv',
      'diff',
      'docker',
      'dotenv',
      'ini',
      'json',
      'json5',
      'jsonc',
      'jsonl',
      'log',
      'make',
      'markdown',
      'mdx',
      'rst',
      'toml',
      'tsv',
      'xml',
      'yaml',
    ]);
  });

  it('also leaves out plain text and the other names of build files', () => {
    for (const id of ['text', 'plaintext', 'txt', 'dockerfile', 'makefile', 'properties']) {
      expect(languageInfo(id).isCode, id).toBe(false);
    }
  });

  it('counts the JSX flavours as their base language', () => {
    expect(languageInfo('tsx').base).toBe('typescript');
    expect(languageInfo('jsx').base).toBe('javascript');
    expect(languageInfo('typescript').base).toBe('typescript');
    expect(languageInfo('python').base).toBe('python');
  });

  it('treats an id it does not know as code, whatever its name', () => {
    expect(languageInfo('brainfuck')).toEqual({ isCode: true, base: 'brainfuck' });
    expect(languageInfo('constructor')).toEqual({ isCode: true, base: 'constructor' });
  });
});
