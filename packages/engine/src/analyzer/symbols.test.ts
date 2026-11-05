import { describe, expect, it } from 'vitest';
import { buildChange } from '../testing/change.ts';
import { classifySymbols } from './symbol-changes.ts';
import { detectSymbols } from './symbols.ts';

function find(path: string, content: string, name: string) {
  return detectSymbols(path, content).find((s) => s.name === name);
}

function lineOf(content: string, needle: string): number {
  return content.split('\n').findIndex((l) => l.includes(needle)) + 1;
}

const TS = `import { x } from './x';

export interface Options {
  retries: number;
}

export type Backoff = 'linear' | 'exponential';

export const DEFAULT_RETRIES = 3;
const internal = 5;

export async function retry<T>(fn: () => Promise<T>, options: Options): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > options.retries) throw new Error(\`gave up after \${attempt} { tries\`);
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private cache = new Map();
  constructor(private readonly base: string) {}
  async get(path: string): Promise<string> {
    return fetch(this.base + path).then((r) => r.text());
  }
  private helper() {
    return 1;
  }
}

app.get('/users/:id', async (req, res) => {
  res.json({});
});
`;

describe('TypeScript symbols', () => {
  const symbols = detectSymbols('src/retry.ts', TS);
  const names = symbols.map((s) => s.name);

  it('finds declarations with kinds and export flags', () => {
    expect(find('src/retry.ts', TS, 'Options')).toMatchObject({ kind: 'interface', exported: true });
    expect(find('src/retry.ts', TS, 'Backoff')).toMatchObject({ kind: 'type', exported: true });
    expect(find('src/retry.ts', TS, 'DEFAULT_RETRIES')).toMatchObject({ kind: 'constant', exported: true });
    expect(find('src/retry.ts', TS, 'retry')).toMatchObject({ kind: 'function', exported: true });
    expect(find('src/retry.ts', TS, 'sleep')).toMatchObject({ kind: 'function', exported: true });
    expect(find('src/retry.ts', TS, 'HttpClient')).toMatchObject({ kind: 'class', exported: true });
    expect(names).not.toContain('internal');
  });

  it('computes line ranges with brace matching that ignores strings and templates', () => {
    const retry = find('src/retry.ts', TS, 'retry')!;
    expect(retry.startLine).toBe(lineOf(TS, 'export async function retry'));
    expect(retry.endLine).toBe(lineOf(TS, 'export const sleep') - 2);
    const klass = find('src/retry.ts', TS, 'HttpClient')!;
    expect(klass.endLine).toBe(lineOf(TS, 'app.get') - 2);
  });

  it('finds class methods and respects private members', () => {
    expect(find('src/retry.ts', TS, 'HttpClient.get')).toMatchObject({ kind: 'method', exported: true });
    expect(find('src/retry.ts', TS, 'HttpClient.helper')).toMatchObject({ kind: 'method', exported: false });
    expect(names).toContain('HttpClient.constructor');
  });

  it('finds Express-style routes', () => {
    const route = find('src/retry.ts', TS, 'GET /users/:id')!;
    expect(route).toMatchObject({ kind: 'route', exported: true });
    expect(route.startLine).toBe(lineOf(TS, 'app.get'));
    expect(route.endLine).toBe(route.startLine + 2);
  });

  it('detects React components in tsx files only', () => {
    const source = `export const Button = (props: Props) => {\n  return <button>{props.label}</button>;\n};\nexport function Panel() {\n  return <div />;\n}\n`;
    expect(find('src/Button.tsx', source, 'Button')?.kind).toBe('component');
    expect(find('src/Button.tsx', source, 'Panel')?.kind).toBe('component');
    expect(find('src/button.ts', source, 'Button')?.kind).toBe('function');
  });

  it('handles multi-line arrow functions and typed consts', () => {
    const source = `export const load = async (\n  id: string,\n  opts: Opts,\n): Promise<void> => {\n  await run(id);\n};\nexport const table: Record<string, number> = {\n  a: 1,\n};\n`;
    expect(find('a.ts', source, 'load')).toMatchObject({ kind: 'function', startLine: 1, endLine: 6 });
    expect(find('a.ts', source, 'table')).toMatchObject({ kind: 'constant', startLine: 7, endLine: 9 });
  });

  it('treats generic arrow functions as functions', () => {
    const source =
      'export const identity = <T,>(value: T): T => value;\nexport const wrap = async <T>(fn: () => T) => {\n  return fn();\n};\n';
    expect(find('a.ts', source, 'identity')).toMatchObject({ kind: 'function', exported: true });
    expect(find('a.ts', source, 'wrap')).toMatchObject({ kind: 'function', startLine: 2, endLine: 4 });
  });

  it('finds Next.js route handlers', () => {
    const source = `export async function GET(request: Request) {\n  return Response.json({});\n}\n`;
    expect(find('app/api/users/route.ts', source, 'GET /api/users')).toMatchObject({
      kind: 'route',
      exported: true,
    });
  });

  it('finds NestJS controller routes', () => {
    const source = `@Controller('users')\nexport class UsersController {\n  @Get(':id')\n  findOne() {\n    return 1;\n  }\n}\n`;
    expect(find('src/users.controller.ts', source, 'GET /users/:id')).toMatchObject({ kind: 'route' });
  });
});

const PY = `import os
from fastapi import FastAPI

app = FastAPI()
MAX_RETRIES = 3
_private = 1


@app.get("/users/{user_id}")
async def get_user(user_id: int):
    return {"id": user_id}


@app.route("/items", methods=["POST", "PUT"])
def create_item():
    pass


def retry(fn, attempts=3):
    """Retry."""
    for i in range(attempts):
        try:
            return fn()
        except Exception:
            pass


class Client:
    def __init__(self, base):
        self.base = base

    def get(self, path):
        def inner():
            return 1
        return inner()

    def _hidden(self):
        pass
`;

describe('statements that continue on the next line', () => {
  const source = [
    'export const Schema = z',
    '  .object({',
    '    a: z.string(),',
    '  })',
    '  .strict();',
    '',
    'export type Mode =',
    "  | 'a'",
    "  | 'b';",
    '',
    'export const total =',
    '  compute(1) +',
    '  compute(2);',
    '',
    '/**',
    ' * Doc for next.',
    ' */',
    'export const next = 1;',
  ].join('\n');

  it('follows chained calls, leading operators and trailing assignments', () => {
    expect(find('a.ts', source, 'Schema')).toMatchObject({ startLine: 1, endLine: 5 });
    expect(find('a.ts', source, 'Mode')).toMatchObject({ startLine: 7, endLine: 9 });
    expect(find('a.ts', source, 'total')).toMatchObject({ startLine: 11, endLine: 13 });
  });

  it('does not swallow the next declaration or its doc comment', () => {
    expect(find('a.ts', source, 'next')).toMatchObject({ startLine: 18, endLine: 18 });
  });
});

describe('Python symbols', () => {
  const names = detectSymbols('app.py', PY).map((s) => s.name);

  it('finds functions, classes, methods and constants', () => {
    expect(find('app.py', PY, 'retry')).toMatchObject({ kind: 'function', exported: true });
    expect(find('app.py', PY, 'Client')).toMatchObject({ kind: 'class', exported: true });
    expect(find('app.py', PY, 'Client.get')).toMatchObject({ kind: 'method', exported: true });
    expect(find('app.py', PY, 'Client._hidden')).toMatchObject({ kind: 'method', exported: false });
    expect(find('app.py', PY, 'MAX_RETRIES')).toMatchObject({ kind: 'constant', exported: true });
    expect(names).not.toContain('inner');
    expect(names).not.toContain('_private');
  });

  it('uses indentation for ranges', () => {
    const retry = find('app.py', PY, 'retry')!;
    expect(retry.startLine).toBe(lineOf(PY, 'def retry'));
    expect(retry.endLine).toBe(lineOf(PY, '            pass'));
    const client = find('app.py', PY, 'Client')!;
    expect(client.endLine).toBe(PY.trimEnd().split('\n').length);
  });

  it('turns decorated handlers into routes that include the decorator lines', () => {
    const get = find('app.py', PY, 'GET /users/{user_id}')!;
    expect(get).toMatchObject({
      kind: 'route',
      startLine: lineOf(PY, '@app.get'),
      declLine: lineOf(PY, 'async def get_user'),
    });
    expect(find('app.py', PY, 'POST,PUT /items')).toMatchObject({ kind: 'route' });
  });
});

describe('other languages', () => {
  it('Go', () => {
    const go = `package retry\n\ntype Client struct {\n\tbase string\n}\n\ntype Doer interface {\n\tDo() error\n}\n\nconst DefaultRetries = 3\n\nfunc New(base string) *Client {\n\treturn &Client{base: base}\n}\n\nfunc (c *Client) Get(path string) (string, error) {\n\treturn "}", nil\n}\n\nfunc helper() {}\n`;
    expect(find('a.go', go, 'Client')).toMatchObject({ kind: 'class', exported: true });
    expect(find('a.go', go, 'Doer')).toMatchObject({ kind: 'interface' });
    expect(find('a.go', go, 'DefaultRetries')).toMatchObject({ kind: 'constant', exported: true });
    expect(find('a.go', go, 'New')).toMatchObject({ kind: 'function', exported: true });
    expect(find('a.go', go, 'Client.Get')).toMatchObject({
      kind: 'method',
      exported: true,
      endLine: lineOf(go, 'func helper') - 2,
    });
    expect(find('a.go', go, 'helper')).toMatchObject({ kind: 'function', exported: false });
  });

  it('Rust', () => {
    const rs = `pub struct Client { base: String }\npub trait Doer { fn run(&self); }\nimpl Client {\n    pub fn new(base: String) -> Self { Client { base } }\n    fn private(&self) {}\n}\npub fn retry<'a>(x: &'a str) {}\nfn hidden() {}\n`;
    expect(find('a.rs', rs, 'Client')).toMatchObject({ kind: 'class', exported: true });
    expect(find('a.rs', rs, 'Doer')).toMatchObject({ kind: 'interface', exported: true });
    expect(find('a.rs', rs, 'Client.new')).toMatchObject({ kind: 'method', exported: true });
    expect(find('a.rs', rs, 'Client.private')).toMatchObject({ exported: false });
    expect(find('a.rs', rs, 'retry')).toMatchObject({ kind: 'function', exported: true });
    expect(find('a.rs', rs, 'hidden')).toMatchObject({ exported: false });
  });

  it('Java', () => {
    const java = `package com.acme;\n\npublic class Report {\n    private final int total;\n\n    public Report(int total) {\n        this.total = total;\n    }\n\n    public int total() {\n        return total;\n    }\n\n    private void audit() {}\n}\n`;
    expect(find('Report.java', java, 'Report')).toMatchObject({ kind: 'class', exported: true });
    expect(find('Report.java', java, 'Report.total')).toMatchObject({ kind: 'method', exported: true });
    expect(find('Report.java', java, 'Report.audit')).toMatchObject({ exported: false });
    expect(find('Report.java', java, 'Report.Report')).toBeDefined();
  });

  it('Kotlin', () => {
    const kt = `data class User(val name: String)\n\nfun greet(user: User): String {\n    return "hi"\n}\n\nprivate fun secret() = 1\n`;
    expect(find('a.kt', kt, 'User')).toMatchObject({ kind: 'class' });
    expect(find('a.kt', kt, 'greet')).toMatchObject({ kind: 'function', exported: true });
    expect(find('a.kt', kt, 'secret')).toMatchObject({ exported: false });
  });

  it('Ruby', () => {
    const rb = `class User\n  def name\n    @name\n  end\n\n  private\n\n  def secret\n    1\n  end\nend\n`;
    expect(find('user.rb', rb, 'User')).toMatchObject({ kind: 'class', startLine: 1, endLine: 11 });
    expect(find('user.rb', rb, 'User.name')).toMatchObject({ kind: 'method', exported: true, endLine: 4 });
    expect(find('user.rb', rb, 'User.secret')).toMatchObject({ exported: false });
  });

  it('PHP', () => {
    const php = `<?php\nclass Report {\n    public function total() { return 1; }\n    private function audit() {}\n}\nfunction helper() {}\n`;
    expect(find('a.php', php, 'Report')).toMatchObject({ kind: 'class' });
    expect(find('a.php', php, 'Report.total')).toMatchObject({ kind: 'method', exported: true });
    expect(find('a.php', php, 'Report.audit')).toMatchObject({ exported: false });
    expect(find('a.php', php, 'helper')).toMatchObject({ kind: 'function' });
  });

  it('Go routes', () => {
    const go = [
      'package main',
      '',
      'func main() {',
      '\tr.GET("/users", list)',
      '\tr.Handle("/raw", raw)',
      '\tmux.Get("GET /spaced/path", spaced)',
      '\te.POST("no-slash", skipped)',
      '}',
    ].join('\n');
    const routes = detectSymbols('main.go', go).filter((s) => s.kind === 'route');
    expect(routes.map((s) => [s.name, s.startLine])).toEqual([
      ['GET /users', 4],
      ['ALL /raw', 5],
      ['GET /spaced/path', 6],
    ]);
  });

  it('Go: a method is exported only when its type is', () => {
    const go =
      'package a\n\nfunc (c *client) Get() {}\n\nfunc (c *Client) Put() {}\n\nfunc (c Client) get() {}\n';
    expect(find('a.go', go, 'client.Get')).toMatchObject({ kind: 'method', exported: false });
    expect(find('a.go', go, 'Client.Put')).toMatchObject({ kind: 'method', exported: true });
    expect(find('a.go', go, 'Client.get')).toMatchObject({ kind: 'method', exported: false });
  });

  it('Rust routes and trait methods', () => {
    const rs = [
      '#[get("/attr")]',
      'async fn attr_handler() {}',
      'fn app() -> Router {',
      '    Router::new().route("/axum", post(handler))',
      '}',
      'pub trait Doer {',
      '    fn run(&self);',
      '}',
      'impl Doer for Wrapper {',
      '    fn run(&self) {}',
      '}',
      'impl Plain {',
      '    fn hidden(&self) {}',
      '}',
    ].join('\n');
    expect(find('a.rs', rs, 'GET /attr')).toMatchObject({ kind: 'route', startLine: 2 });
    expect(find('a.rs', rs, 'POST /axum')).toMatchObject({ kind: 'route', startLine: 4 });
    expect(find('a.rs', rs, 'Doer.run')).toMatchObject({ kind: 'method', exported: true });
    expect(find('a.rs', rs, 'Wrapper.run')).toMatchObject({ kind: 'method', exported: true });
    expect(find('a.rs', rs, 'Plain.hidden')).toMatchObject({ kind: 'method', exported: false });
  });

  it('Spring routes, with the path of the class in front', () => {
    const java = [
      '@RestController',
      '@RequestMapping("/cities")',
      'public class Cities {',
      '    @GetMapping("/{id}")',
      '    public int one() { return 1; }',
      '',
      '    @PostMapping(value = "/create")',
      '    public void create() {}',
      '',
      '    @RequestMapping(path = "/any")',
      '    void any() {}',
      '}',
    ].join('\n');
    const names = detectSymbols('Cities.java', java).map((s) => s.name);
    expect(names).toEqual(['Cities', 'GET /cities/{id}', 'POST /cities/create', 'ALL /cities/any']);
  });

  it('Kotlin routes', () => {
    const kt =
      '@RequestMapping("/api")\nclass Controller {\n    @GetMapping("/x")\n    fun get() {}\n\n    fun plain() {}\n}\n';
    expect(find('a.kt', kt, 'GET /api/x')).toMatchObject({ kind: 'route', startLine: 4 });
    expect(find('a.kt', kt, 'Controller.plain')).toMatchObject({ kind: 'method', exported: true });
  });

  it('C# members and attribute routes', () => {
    const cs = [
      'namespace Shop;',
      '[ApiController]',
      '[Route("api/orders")]',
      'public class Orders : ControllerBase {',
      '    [HttpGet("{id}")]',
      '    public IActionResult Get(int id) { return Ok(); }',
      '',
      '    internal void Audit() {}',
      '}',
    ].join('\n');
    expect(find('Orders.cs', cs, 'Orders')).toMatchObject({ kind: 'class', exported: true });
    expect(find('Orders.cs', cs, 'GET /api/orders/{id}')).toMatchObject({ kind: 'route', startLine: 6 });
    expect(find('Orders.cs', cs, 'Orders.Audit')).toMatchObject({ kind: 'method', exported: false });
  });

  it('Ruby routes are read in routes.rb only', () => {
    const rb = "get '/users', to: 'users#index'\npost \"/items\", to: 'items#create'\n";
    expect(detectSymbols('config/routes.rb', rb).map((s) => s.name)).toEqual(['GET /users', 'POST /items']);
    expect(detectSymbols('app/other.rb', rb)).toEqual([]);
  });

  it('Ruby: nested classes and the visibility keywords', () => {
    const rb = [
      'module Shop',
      '  class Order',
      '    def total; end',
      '',
      '    private',
      '',
      '    def secret; end',
      '  end',
      'end',
    ].join('\n');
    expect(find('order.rb', rb, 'Shop')).toMatchObject({ kind: 'other' });
    expect(find('order.rb', rb, 'Shop::Order')).toMatchObject({ kind: 'class', startLine: 2, endLine: 8 });
    expect(find('order.rb', rb, 'Shop::Order.total')).toMatchObject({ exported: true });
    expect(find('order.rb', rb, 'Shop::Order.secret')).toMatchObject({ exported: false });
  });

  it('PHP routes', () => {
    const php = "<?php\nRoute::get('/home', fn() => 1);\nRoute::any('/any', fn() => 2);\n";
    expect(detectSymbols('routes/web.php', php).map((s) => s.name)).toEqual(['GET /home', 'ALL /any']);
  });

  it('returns nothing for unknown languages and huge files', () => {
    expect(detectSymbols('a.txt', 'function x() {}')).toEqual([]);
    expect(detectSymbols('a.ts', 'x\n'.repeat(25_000))).toEqual([]);
  });
});

describe('classifySymbols', () => {
  const base = `export function keep() {
  return 1;
}

export function change(a: number) {
  return a;
}

export function gone() {
  return 2;
}

export function sig(a: number) {
  return a;
}

export function trim() {
  const a = 1;
  const b = 2;
  return a + b;
}
`;
  const head = `export function keep() {
  return 1;
}

export function change(a: number) {
  const b = a + 1;
  return b;
}

export function fresh() {
  return 3;
}

export function sig(a: number, b: string) {
  return a;
}

export function trim() {
  const a = 1;
  return a;
}
`;

  it('classifies added, modified and removed symbols', () => {
    const { changeSet } = buildChange([{ path: 'src/a.ts', base, head }]);
    const result = classifySymbols(changeSet.files[0]!, head, base);
    const by = Object.fromEntries(result.map((s) => [s.name, s]));
    expect(by.keep).toBeUndefined();
    expect(by.change).toMatchObject({ change: 'modified', side: 'head', signatureChanged: false });
    expect(by.fresh).toMatchObject({ change: 'added', side: 'head', exported: true });
    expect(by.gone).toMatchObject({ change: 'removed', side: 'base' });
    expect(by.sig).toMatchObject({ change: 'modified', signatureChanged: true });
    expect(by.trim).toMatchObject({ change: 'modified' });
    expect(by.gone?.startLine).toBe(lineOf(base, 'export function gone'));
    expect(by.fresh?.startLine).toBe(lineOf(head, 'export function fresh'));
  });

  it('classifies Python changes, keeping decorated routes modified when only a decorator is added', () => {
    const pyBase = '@app.get("/a")\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n';
    const pyHead =
      '@app.get("/a")\n@cache\ndef a():\n    return 1\n\n\ndef b():\n    return 3\n\n\n@app.post("/c")\ndef c():\n    return 4\n';
    const { changeSet } = buildChange([{ path: 'app.py', base: pyBase, head: pyHead }]);
    const by = Object.fromEntries(
      classifySymbols(changeSet.files[0]!, pyHead, pyBase).map((s) => [s.name, s]),
    );
    expect(by['GET /a']).toMatchObject({ change: 'modified', signatureChanged: false, kind: 'route' });
    expect(by.b).toMatchObject({ change: 'modified' });
    expect(by['POST /c']).toMatchObject({ change: 'added', kind: 'route' });
  });

  it('classifies Go changes', () => {
    const goBase = 'package a\n\nfunc Keep() int {\n\treturn 1\n}\n\nfunc Gone() int {\n\treturn 2\n}\n';
    const goHead = 'package a\n\nfunc Keep() int {\n\treturn 10\n}\n\nfunc Fresh() int {\n\treturn 3\n}\n';
    const { changeSet } = buildChange([{ path: 'a.go', base: goBase, head: goHead }]);
    const by = Object.fromEntries(
      classifySymbols(changeSet.files[0]!, goHead, goBase).map((s) => [s.name, s]),
    );
    expect(by.Keep).toMatchObject({ change: 'modified', side: 'head' });
    expect(by.Fresh).toMatchObject({ change: 'added' });
    expect(by.Gone).toMatchObject({ change: 'removed', side: 'base' });
  });

  it('treats every symbol of a new file as added and of a deleted file as removed', () => {
    const added = buildChange([{ path: 'src/a.ts', base: null, head }]).changeSet.files[0]!;
    expect(classifySymbols(added, head, null).every((s) => s.change === 'added')).toBe(true);
    const deleted = buildChange([{ path: 'src/a.ts', base, head: null }]).changeSet.files[0]!;
    const removed = classifySymbols(deleted, null, base);
    expect(removed.length).toBe(5);
    expect(removed.every((s) => s.change === 'removed' && s.side === 'base')).toBe(true);
  });

  it('does nothing for sensitive or binary files', () => {
    const file = buildChange([{ path: 'src/a.ts', base, head, sensitive: true }]).changeSet.files[0]!;
    expect(classifySymbols(file, head, base)).toEqual([]);
  });
});
