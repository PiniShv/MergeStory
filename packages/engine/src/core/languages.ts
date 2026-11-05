/**
 * The language registry: the Shiki language id of a repository path, and what the engine needs to know
 * about an id. The sources set `ChangedFile.language` from it; the later stages read that field and do
 * not guess from the path again.
 */

const BY_EXTENSION: Record<string, string> = {
  // JavaScript and TypeScript
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  // Data and markup
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  jsonl: 'jsonl',
  geojson: 'json',
  webmanifest: 'json',
  ipynb: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  properties: 'ini',
  editorconfig: 'ini',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  plist: 'xml',
  svg: 'xml',
  csproj: 'xml',
  vbproj: 'xml',
  fsproj: 'xml',
  props: 'xml',
  targets: 'xml',
  wsdl: 'xml',
  rss: 'xml',
  atom: 'xml',
  xaml: 'xml',
  csv: 'csv',
  tsv: 'tsv',
  diff: 'diff',
  patch: 'diff',
  log: 'log',
  // General purpose languages
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sc: 'scala',
  sbt: 'scala',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  ru: 'ruby',
  php: 'php',
  phtml: 'php',
  cs: 'csharp',
  csx: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  'h++': 'cpp',
  ipp: 'cpp',
  inl: 'cpp',
  tpp: 'cpp',
  swift: 'swift',
  m: 'objective-c',
  mm: 'objective-cpp',
  lua: 'lua',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  r: 'r',
  jl: 'julia',
  zig: 'zig',
  nim: 'nim',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  hs: 'haskell',
  ml: 'ocaml',
  mli: 'ocaml',
  fs: 'fsharp',
  fsx: 'fsharp',
  fsi: 'fsharp',
  pl: 'perl',
  pm: 'perl',
  vb: 'vb',
  sol: 'solidity',
  nix: 'nix',
  gleam: 'gleam',
  odin: 'odin',
  groovy: 'groovy',
  gradle: 'groovy',
  coffee: 'coffee',
  cr: 'crystal',
  // Shell and build
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ksh: 'shellscript',
  command: 'shellscript',
  fish: 'fish',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  mk: 'make',
  cmake: 'cmake',
  dockerfile: 'docker',
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'hcl',
  bicep: 'bicep',
  // Web
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  styl: 'stylus',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  pug: 'pug',
  jade: 'pug',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  twig: 'twig',
  liquid: 'liquid',
  jinja: 'jinja',
  j2: 'jinja',
  erb: 'erb',
  // Query, schema and interface languages
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  prisma: 'prisma',
  // Graphics
  glsl: 'glsl',
  vert: 'glsl',
  frag: 'glsl',
  wgsl: 'wgsl',
  hlsl: 'hlsl',
  // Documents
  tex: 'latex',
  rst: 'rst',
  adoc: 'asciidoc',
  asciidoc: 'asciidoc',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  http: 'http',
  vhd: 'vhdl',
  vhdl: 'vhdl',
  cue: 'cue',
  jsonnet: 'jsonnet',
  typ: 'typst',
};

/** Whole-file names (lower case) that have no useful extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  guardfile: 'ruby',
  podfile: 'ruby',
  fastfile: 'ruby',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  capfile: 'ruby',
  justfile: 'just',
  jenkinsfile: 'groovy',
  pipfile: 'toml',
  'cargo.lock': 'toml',
  'poetry.lock': 'toml',
  '.bashrc': 'shellscript',
  '.bash_profile': 'shellscript',
  '.bash_aliases': 'shellscript',
  '.zshrc': 'shellscript',
  '.zprofile': 'shellscript',
  '.zshenv': 'shellscript',
  '.profile': 'shellscript',
  '.gitconfig': 'ini',
  '.gitmodules': 'ini',
  '.babelrc': 'json',
  '.env': 'dotenv',
};

/** A table entry; members that every object inherits, such as "constructor", are not entries. */
function own(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Guess the Shiki language id for a repository path, or null when there is no good match. */
export function languageForPath(path: string): string | null {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (!base) return null;
  const byName = own(BY_NAME, base);
  if (byName) return byName;
  if (base.startsWith('dockerfile.') || base.startsWith('containerfile.')) return 'docker';
  if (base.startsWith('.env.')) return 'dotenv';
  // tsconfig.json and friends allow comments.
  if (/^(?:ts|js)config(?:\.[\w-]+)?\.json$/.test(base)) return 'jsonc';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  // A leading dot with no other dot is a hidden file name, not an extension.
  if (dot === 0) return null;
  return own(BY_EXTENSION, base.slice(dot + 1)) ?? null;
}

/** Every file extension (lower case, no dot) that maps to a language. */
export function fileExtensions(): string[] {
  return Object.keys(BY_EXTENSION);
}

/** Every language id `languageForPath` can return. */
export function languageIds(): string[] {
  return [
    ...new Set([...Object.values(BY_EXTENSION), ...Object.values(BY_NAME), 'jsonc', 'docker', 'dotenv']),
  ].sort();
}

/** Ids of prose, data, configuration and build files. A count of the languages of a project skips them. */
const NOT_CODE = new Set([
  'markdown',
  'mdx',
  'rst',
  'log',
  'diff',
  'json',
  'jsonc',
  'json5',
  'jsonl',
  'yaml',
  'toml',
  'ini',
  'xml',
  'csv',
  'tsv',
  'dotenv',
  'docker',
  'make',
  // Other names for the same things, and plain text, as a change set made by hand may write them.
  'dockerfile',
  'makefile',
  'properties',
  'text',
  'plaintext',
  'txt',
]);

/** JSX flavours count as their base language, so one TypeScript project is not split in two. */
const BASE_LANGUAGE: Record<string, string> = { tsx: 'typescript', jsx: 'javascript' };

export interface LanguageInfo {
  /** False for prose, data, configuration and build files. */
  isCode: boolean;
  /** The id the language is counted under: `tsx` counts as `typescript`. */
  base: string;
}

/** What the engine needs to know about a language id. An id the registry does not know is code. */
export function languageInfo(id: string): LanguageInfo {
  return { isCode: !NOT_CODE.has(id), base: own(BASE_LANGUAGE, id) ?? id };
}
