import { describe, expect, it } from 'vitest';
import { extractImports, ImportResolver, loadResolverOptions } from './imports.ts';

const specs = (path: string, content: string) => extractImports(path, content).map((r) => r.spec);

describe('extractImports', () => {
  it('reads TypeScript and JavaScript import forms and skips comments', () => {
    const source = `import a from './a';
import { b } from "../b.ts";
import type { T } from './types';
import './side-effect';
export { c } from './c';
export * from './d';
const e = require('./e');
const f = await import('./f');
// import skipped from './skipped';
 * import star from './star';
import {
  g,
  h,
} from './multi';
`;
    expect(specs('src/x.ts', source).sort()).toEqual(
      ['../b.ts', './a', './c', './d', './e', './f', './multi', './side-effect', './types'].sort(),
    );
  });

  it('reads Python imports with their dots and names', () => {
    const source = `import os, sys as system
import a.b.c
from . import sibling
from .mod import x
from ..pkg.sub import (y, z)
from pkg import thing as t
`;
    expect(extractImports('app/x.py', source)).toEqual([
      { lang: 'py', spec: '', dots: 1, names: ['sibling'] },
      { lang: 'py', spec: 'mod', dots: 1, names: ['x'] },
      { lang: 'py', spec: 'pkg.sub', dots: 2, names: ['y', 'z'] },
      { lang: 'py', spec: 'pkg', dots: 0, names: ['thing'] },
      { lang: 'py', spec: 'os', dots: 0, names: [] },
      { lang: 'py', spec: 'sys', dots: 0, names: [] },
      { lang: 'py', spec: 'a.b.c', dots: 0, names: [] },
    ]);
  });

  it('reads Go, Rust, Java, Ruby and PHP imports', () => {
    expect(
      specs(
        'a.go',
        'package a\n\nimport (\n\t"fmt"\n\tstore "example.com/weather/store"\n)\nimport "os"\n',
      ).sort(),
    ).toEqual(['example.com/weather/store', 'fmt', 'os']);
    const rust = extractImports(
      'src/lib.rs',
      'pub mod net;\nmod util;\nuse crate::net::Client;\nuse super::x;\nuse serde::Serialize;\n',
    );
    expect(rust).toEqual([
      { lang: 'rs', spec: 'net', isMod: true },
      { lang: 'rs', spec: 'util', isMod: true },
      { lang: 'rs', spec: 'crate::net::Client', isMod: false },
      { lang: 'rs', spec: 'super::x', isMod: false },
      { lang: 'rs', spec: 'serde::Serialize', isMod: false },
    ]);
    expect(
      specs('A.java', 'import com.acme.Foo;\nimport static com.acme.Util.helper;\nimport com.acme.*;\n'),
    ).toEqual(['com.acme.Foo', 'com.acme.Util.helper', 'com.acme']);
    expect(specs('a.rb', "require 'json'\nrequire_relative 'lib/helper'\n").sort()).toEqual([
      './lib/helper',
      'json',
    ]);
    expect(
      specs(
        'a.php',
        "<?php\nuse App\\Forecast\\Report;\nuse function App\\helper;\nrequire_once __DIR__ . '/boot.php';\n",
      ),
    ).toEqual(['App\\Forecast\\Report', './boot.php']);
  });

  it('reads the script of Vue and Svelte components', () => {
    const source = "<script>\nimport a from './a';\n</script>\n";
    expect(specs('A.vue', source)).toEqual(['./a']);
    expect(specs('A.svelte', source)).toEqual(['./a']);
  });

  it('reads Kotlin imports, and an aliased import not at all', () => {
    expect(specs('a.kt', 'import com.acme.Foo\nimport com.acme.Bar as B\nimport com.acme.*\n')).toEqual([
      'com.acme.Foo',
      'com.acme',
    ]);
  });

  it('ignores files in other languages', () => {
    expect(extractImports('a.txt', "import x from './x'")).toEqual([]);
    expect(extractImports('A.cs', 'using System;')).toEqual([]);
  });
});

function resolve(
  known: string[],
  importer: string,
  content: string,
  extra: ConstructorParameters<typeof ImportResolver>[0] extends infer O ? Partial<O> : never = {},
) {
  const resolver = new ImportResolver({ knownPaths: known, ...extra });
  return extractImports(importer, content).flatMap((r) => resolver.resolve(importer, r));
}

describe('ImportResolver', () => {
  it('resolves relative TypeScript imports to files, index files and .js specifiers', () => {
    const known = ['src/a.ts', 'src/util/index.ts', 'src/b.tsx', 'src/data.json'];
    const source =
      "import a from './a';\nimport u from './util';\nimport b from './b.js';\nimport d from './data.json';\n";
    expect(resolve(known, 'src/main.ts', source)).toEqual([
      'src/a.ts',
      'src/util/index.ts',
      'src/b.tsx',
      'src/data.json',
    ]);
  });

  it('keeps the textual path for relative imports of files that are not listed', () => {
    expect(resolve([], 'src/a/x.ts', "import y from '../b/y';\n")).toEqual(['src/b/y']);
  });

  it('resolves aliases and workspace package names', () => {
    const known = [
      'packages/web/src/lib/format.ts',
      'packages/core/src/index.ts',
      'packages/core/src/retry/index.ts',
    ];
    const packageDirs = new Map([['@acme/core', 'packages/core']]);
    expect(
      resolve(known, 'packages/web/src/page.ts', "import f from '@/lib/format';\n", { packageDirs }),
    ).toEqual(['packages/web/src/lib/format.ts']);
    expect(
      resolve(
        known,
        'packages/web/src/page.ts',
        "import { x } from '@acme/core';\nimport r from '@acme/core/retry';\nimport z from 'zod';\n",
        { packageDirs },
      ),
    ).toEqual(['packages/core/src/index.ts', 'packages/core/src/retry/index.ts']);
  });

  it('resolves the "#/" alias like the "@/" alias', () => {
    expect(resolve(['src/lib/q.ts'], 'src/a.ts', "import q from '#/lib/q';\n")).toEqual(['src/lib/q.ts']);
    expect(resolve(['src/lib/q.ts'], 'src/a.ts', "import q from '#lib/q';\n")).toEqual(['src/lib/q.ts']);
  });

  it('resolves Python relative and absolute imports', () => {
    const known = [
      'app/services/forecast.py',
      'app/models/user.py',
      'app/api/helpers.py',
      'src/pkg/__init__.py',
    ];
    const source =
      'from app.services import forecast\nfrom ..models import user\nfrom . import helpers\nimport pkg\n';
    expect(resolve(known, 'app/api/views.py', source).sort()).toEqual(
      ['app/api/helpers.py', 'app/models/user.py', 'app/services/forecast.py', 'src/pkg/__init__.py'].sort(),
    );
  });

  it('resolves Go imports through the module path', () => {
    const goModules = [{ module: 'example.com/weather', dir: '' }];
    expect(
      resolve([], 'cmd/main.go', 'import (\n\t"fmt"\n\t"example.com/weather/internal/store"\n)\n', {
        goModules,
      }),
    ).toEqual(['internal/store/_package.go']);
  });

  it('resolves a Go import through the most specific module', () => {
    const goModules = [
      { module: 'example.com/weather', dir: '' },
      { module: 'example.com/weather/pkg', dir: 'vendor/pkg' },
    ];
    expect(resolve([], 'main.go', 'import "example.com/weather/pkg/a"\n', { goModules })).toEqual([
      'vendor/pkg/a/_package.go',
    ]);
    expect(resolve([], 'main.go', 'import "example.com/weather/cmd"\n', { goModules })).toEqual([
      'cmd/_package.go',
    ]);
  });

  it('resolves Rust modules and crate paths', () => {
    const known = ['src/lib.rs', 'src/net.rs', 'src/util/mod.rs'];
    expect(resolve(known, 'src/lib.rs', 'mod net;\nmod util;\nuse crate::net::Client;\n')).toEqual([
      'src/net.rs',
      'src/util/mod.rs',
      'src/net.rs',
    ]);
  });

  it('resolves Java imports by package path and Ruby and PHP relative requires', () => {
    const known = ['src/main/java/com/acme/Foo.java', 'lib/helper.rb', 'app/Forecast/Report.php'];
    expect(
      resolve(known, 'src/main/java/com/acme/App.java', 'import com.acme.Foo;\nimport java.util.List;\n'),
    ).toEqual(['src/main/java/com/acme/Foo.java']);
    expect(resolve(known, 'app/a.rb', "require 'helper'\nrequire_relative 'x/y'\n").sort()).toEqual([
      'app/x/y.rb',
      'lib/helper.rb',
    ]);
    expect(resolve(known, 'app/Http/C.php', 'use App\\Forecast\\Report;\n')).toEqual([
      'app/Forecast/Report.php',
    ]);
  });

  it('does not resolve a PHP namespace by the name of its class alone', () => {
    expect(resolve(['other/Util.php'], 'app/C.php', 'use App\\Other\\Util;\n')).toEqual([]);
    expect(resolve(['x/Single.php'], 'app/C.php', 'use Single;\n')).toEqual(['x/Single.php']);
  });
});

describe('loadResolverOptions', () => {
  const files: Record<string, string> = {
    'packages/a/package.json': '{"name":"@acme/shared"}',
    'packages/b/package.json': '{"name":"@acme/shared"}',
    'packages/c/package.json': 'not json',
    'packages/d/package.json': '{"name":"@acme/d"}',
    'go.mod': 'module example.com/root\n',
    'services/api/go.mod': 'module example.com/root/api\n',
  };
  const load = (overrides: Partial<Parameters<typeof loadResolverOptions>[0]> = {}) =>
    loadResolverOptions({
      componentPaths: ['packages/a', 'packages/b', 'packages/c', 'packages/d', 'services/api', 'src'],
      languages: new Set(['js', 'go']),
      isExcluded: () => false,
      readHead: async (path) => files[path] ?? null,
      concurrency: 4,
      ...overrides,
    });

  it('reads package names and Go modules from the workspace directories', async () => {
    const { packageDirs, goModules } = await load();
    expect([...packageDirs]).toEqual([
      ['@acme/shared', 'packages/a'],
      ['@acme/d', 'packages/d'],
    ]);
    expect(goModules).toEqual([
      { module: 'example.com/root', dir: '' },
      { module: 'example.com/root/api', dir: 'services/api' },
    ]);
  });

  it('gives the same answer however the reads finish, and the first workspace keeps a shared name', async () => {
    const slowFirst = await load({
      readHead: async (path) => {
        await new Promise((resolve) => setTimeout(resolve, path.startsWith('packages/a') ? 20 : 0));
        return files[path] ?? null;
      },
    });
    expect(slowFirst.packageDirs.get('@acme/shared')).toBe('packages/a');
  });

  it('reads only what the languages of the change need', async () => {
    const asked: string[] = [];
    const readHead = async (path: string) => {
      asked.push(path);
      return files[path] ?? null;
    };
    await load({ languages: new Set(['go']), readHead });
    expect(asked.every((p) => p.endsWith('go.mod'))).toBe(true);
    asked.length = 0;
    await load({ languages: new Set(['js']), readHead });
    expect(asked.every((p) => p.endsWith('package.json'))).toBe(true);
    asked.length = 0;
    await load({ languages: new Set(), readHead });
    expect(asked).toEqual([]);
  });

  it('does not ask for a manifest in an excluded workspace', async () => {
    const asked: string[] = [];
    const { packageDirs } = await load({
      isExcluded: (path) => path.startsWith('packages/a/'),
      readHead: async (path) => {
        asked.push(path);
        return files[path] ?? null;
      },
    });
    expect(asked.some((p) => p.startsWith('packages/a/'))).toBe(false);
    expect(packageDirs.get('@acme/shared')).toBe('packages/b');
  });

  it('lets a failed read through, so a cancelled run stops', async () => {
    await expect(
      load({
        readHead: async () => {
          throw new Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
  });
});
