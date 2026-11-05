import { describe, expect, it } from 'vitest';
import { hasImports, hasSymbols, importSupport, indexLanguages, languageSupport } from './index.ts';

describe('languageSupport', () => {
  it('finds a language by extension, whatever the case', () => {
    expect(languageSupport('src/a.ts')?.comments).toEqual(['//', '/*', '*']);
    expect(languageSupport('SRC/A.PY')?.comments).toEqual(['#']);
  });

  it('finds a language by file name', () => {
    expect(languageSupport('Makefile')?.indentSensitive).toBe(true);
    expect(languageSupport('build/makefile')?.indentSensitive).toBe(true);
    expect(languageSupport('docker/Dockerfile')?.comments).toEqual(['#']);
    expect(languageSupport('DOCKERFILE')?.comments).toEqual(['#']);
  });

  it('matches the whole name of a file, not a part of it', () => {
    for (const path of ['my-dockerfile', 'notmakefile', 'Makefile.am']) {
      expect(languageSupport(path), path).toBeNull();
    }
  });

  it.each(['LICENSE', 'notes.txt', '.gitignore', '.mk', 'folder/', '', 'x.', 'constructor', 'a.constructor'])(
    'knows nothing about %j',
    (path) => {
      expect(languageSupport(path)).toBeNull();
    },
  );
});

describe('what the analyzer reads', () => {
  it.each([
    'a.ts',
    'a.tsx',
    'a.js',
    'a.jsx',
    'a.mjs',
    'a.cjs',
    'a.mts',
    'a.cts',
    'a.py',
    'a.go',
    'a.rs',
    'A.java',
    'a.kt',
    'a.kts',
    'a.rb',
    'a.php',
  ])('finds declarations and imports in %s', (path) => {
    expect([hasSymbols(path), hasImports(path)]).toEqual([true, true]);
  });

  it.each(['A.vue', 'A.svelte'])('finds only imports in %s, a component', (path) => {
    expect([hasSymbols(path), hasImports(path)]).toEqual([false, true]);
  });

  it('finds only declarations in C#', () => {
    expect([hasSymbols('A.cs'), hasImports('A.cs')]).toEqual([true, false]);
  });

  it.each([
    'a.pyi',
    'a.scala',
    'a.swift',
    'a.c',
    'a.cpp',
    'a.css',
    'a.sh',
    'a.yaml',
    'a.sql',
    'a.html',
    'a.md',
    'a.txt',
    'Makefile',
    'Dockerfile',
    '',
  ])('reads neither in %j', (path) => {
    expect([hasSymbols(path), hasImports(path)]).toEqual([false, false]);
  });

  it('gives Java and Kotlin the same imports, and each language its own', () => {
    expect(languageSupport('A.java')?.imports).toBe(languageSupport('a.kt')?.imports);
    for (const [path, lang] of [
      ['a.ts', 'js'],
      ['a.vue', 'js'],
      ['a.py', 'py'],
      ['a.go', 'go'],
      ['a.rs', 'rs'],
      ['A.java', 'jvm'],
      ['a.kts', 'jvm'],
      ['a.rb', 'rb'],
      ['a.php', 'php'],
    ] as const) {
      expect(languageSupport(path)?.imports?.lang, path).toBe(lang);
    }
  });

  it('hands out the support of an import language to the resolver', () => {
    for (const lang of ['js', 'py', 'go', 'rs', 'jvm', 'rb', 'php'] as const) {
      expect(importSupport(lang)?.lang).toBe(lang);
    }
  });
});

describe('comment syntax', () => {
  const C = ['//', '/*', '*'];
  it.each([
    [['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts', 'A.vue', 'A.svelte'], C],
    [['a.go', 'a.rs', 'A.java', 'a.kt', 'a.kts', 'A.cs', 'a.scala', 'a.swift', 'a.groovy', 'a.dart'], C],
    [['a.c', 'a.h', 'a.cpp', 'a.cc', 'a.hpp', 'a.css', 'a.scss', 'a.less', 'a.proto'], C],
    [['a.php'], [...C, '#']],
    [['a.py', 'a.pyi', 'a.rb', 'a.sh', 'a.bash', 'a.zsh', 'a.yaml', 'a.yml', 'a.toml', 'Dockerfile'], ['#']],
    [['a.r', 'a.ex', 'a.exs', 'a.tf', 'a.hcl', 'a.nix'], ['#']],
    [['a.sql', 'a.lua', 'a.hs', 'a.elm'], ['--']],
    [
      ['a.html', 'a.htm', 'a.xml'],
      ['<!--', '-->'],
    ],
  ])('%j start with %j', (paths, prefixes) => {
    for (const path of paths) expect(languageSupport(path)?.comments, path).toEqual(prefixes);
  });

  it.each(['a.md', 'rules.mk', 'Makefile', 'a.pug', 'a.json', 'notes.txt'])('is not known for %s', (path) => {
    expect(languageSupport(path)?.comments).toBeUndefined();
  });
});

describe('indentation', () => {
  it.each([
    'a.py',
    'a.pyi',
    'a.yaml',
    'a.yml',
    'a.pug',
    'a.haml',
    'a.slim',
    'a.coffee',
    'a.styl',
    'a.nim',
    'rules.mk',
    'a.md',
    'Makefile',
    'makefile',
  ])('carries meaning in %s', (path) => {
    expect(languageSupport(path)?.indentSensitive).toBe(true);
  });

  it.each(['a.ts', 'a.go', 'a.rb', 'a.json', 'a.sql', 'a.html', 'Dockerfile', 'a.sh'])(
    'does not carry meaning in %s',
    (path) => {
      expect(languageSupport(path)?.indentSensitive).toBeFalsy();
    },
  );
});

describe('indexLanguages', () => {
  const entry = (extensions: string[], names?: string[]) => ({ extensions, names });

  it('refuses an extension or a name that two entries list', () => {
    expect(() => indexLanguages([entry(['.a']), entry(['.b', '.a'])])).toThrow('Two languages list ".a"');
    expect(() => indexLanguages([entry(['.a'], ['make']), entry(['.b'], ['make'])])).toThrow(
      'Two languages list "make"',
    );
  });

  it('lets an extension and a name be the same word', () => {
    expect(() => indexLanguages([entry(['.make'], ['.make'])])).not.toThrow();
  });

  it('refuses an extension without its dot', () => {
    expect(() => indexLanguages([entry(['ts'])])).toThrow('needs its dot');
  });

  it('refuses a key in upper case, which no lookup could find', () => {
    expect(() => indexLanguages([entry(['.TS'])])).toThrow('must be lower case');
    expect(() => indexLanguages([entry(['.ts'], ['Makefile'])])).toThrow('must be lower case');
  });
});
