/**
 * Narration text as it should be spoken.
 *
 * Captions show the text exactly as written. Speech engines read symbols, paths and
 * identifiers badly ("1.2s" becomes "one point twos", "e.g." becomes "E G"), so the text is
 * rewritten into plain words first. The rules are deliberately conservative: when a pattern is
 * ambiguous it is left alone.
 */

const HTML_TAGS =
  'b|i|u|em|strong|code|pre|p|br|hr|a|ul|ol|li|h[1-6]|span|div|kbd|sub|sup|details|summary|blockquote|table|tr|td|th|thead|tbody|img';

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Build a character class from code point ranges, so the source holds no invisible characters. */
function charClass(ranges: [number, number][]): RegExp {
  const body = ranges
    .map(([from, to]) =>
      from === to ? String.fromCodePoint(from) : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`,
    )
    .join('');
  return new RegExp(`[${body}]`, 'g');
}

const SPACE_LIKE = charClass([
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
]);
const ZERO_WIDTH = charClass([
  [0x200b, 0x200d],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
]);

/** Normalise unusual spaces and line endings. */
function normalizeCharacters(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(SPACE_LIKE, ' ').replace(ZERO_WIDTH, '');
}

/**
 * `*` and `**` between two operands are arithmetic, not emphasis: "x * 2 ** n" is "x times 2 to the
 * power of n". Markdown needs the stars to touch the words they stress, so a star with a space on
 * both sides, or `**` between a digit and a word, is an operator. This runs before the markup is
 * removed, which would take "* 2 *" for italics.
 */
function expandStarOperators(text: string): string {
  return text
    .replace(/(?<=\S)[ \t]\*\*[ \t](?=\S)/g, ' to the power of ')
    .replace(/(?<=\d)\*\*(?=\w)|(?<=\w)\*\*(?=\d)/g, ' to the power of ')
    .replace(/(?<=\S)[ \t]\*[ \t](?=\S)/g, ' times ');
}

/** Lines that start a new unit (list item, heading, quote, rule, code fence) instead of continuing a paragraph. */
const BLOCK_LINE = /^\s{0,3}(?:#{1,6}\s|>|(?:[-*+]|\d{1,3}[.)])\s|```|~~~|(?:[-*_]\s*){3,}$)/;

/** Remove markdown and HTML markup but keep the words. List items and paragraphs become sentences. */
function markupToSentences(text: string): string {
  const units: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) units.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) flush();
    else if (BLOCK_LINE.test(line)) {
      flush();
      units.push(line);
    } else paragraph.push(line.trim());
  }
  flush();
  const cleaned = units.map(stripInlineMarkup).filter(Boolean);
  return cleaned
    .map((unit, i) => (i < cleaned.length - 1 && !/[.!?:;,]["')\]]?$/.test(unit) ? `${unit}.` : unit))
    .join(' ');
}

function stripInlineMarkup(text: string): string {
  return text
    .replace(/^\s*(?:```|~~~)[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/`+/g, '')
    .replace(new RegExp(`</?(?:${HTML_TAGS})\\b[^>]*>`, 'gi'), ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<![A-Za-z0-9_])__([^_\n]+?)__(?![A-Za-z0-9_])/g, '$1')
    .replace(/\*([^*\n]+?)\*/g, '$1')
    .replace(/(?<![A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*+(?=\w)|(?<=\w)\*+/g, '')
    .trim();
}

function expandAbbreviations(text: string): string {
  const keepCase = (replacement: string, original: string): string =>
    /^[A-Z]/.test(original) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
  return text
    .replace(/\be\.g\./gi, (m) => keepCase('for example', m))
    .replace(/\bi\.e\./gi, (m) => keepCase('that is', m))
    .replace(/\betc\./gi, (m, offset: number, whole: string) => {
      const after = whole.slice(offset + m.length);
      const endsSentence = /^\s*$/.test(after) || /^\s+["'(]?[A-Z]/.test(after);
      return keepCase(endsSentence ? 'and so on.' : 'and so on', m);
    })
    .replace(/\bvs\b\.?/gi, (m) => keepCase('versus', m));
}

/** Product and engineering terms that the identifier rules below would split or misread. */
const TERMS: Record<string, string> = {
  SaaS: 'sass',
  PaaS: 'pass',
  IaaS: 'I as',
  PoC: 'POC',
  MoM: 'month over month',
  QoQ: 'quarter over quarter',
  YoY: 'year over year',
  WoW: 'week over week',
};

const TERM_WORDS = new RegExp(`\\b(?:${Object.keys(TERMS).join('|')})\\b`, 'g');

function replaceTerms(text: string): string {
  return text.replace(TERM_WORDS, (term) => TERMS[term] ?? term);
}

function replaceUrls(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, (match) => {
    const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? '';
    return `a link${trailing}`;
  });
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

function splitCamel(word: string): string {
  if (/^[a-z0-9]+$/.test(word) || /^[A-Z0-9]+$/.test(word) || /^[A-Z][a-z0-9]+$/.test(word)) return word;
  return word
    .replace(/([a-z]{2,})(?=[A-Z])/g, '$1 ')
    .replace(/([0-9])(?=[A-Z][a-z])/g, '$1 ')
    .replace(/([A-Z]+)(?=[A-Z][a-z]{2,})/g, '$1 ')
    .replace(/(?<=[A-Z][a-z])(?=[A-Z][a-z])/g, ' ');
}

/**
 * Break a name into words: "fetchWithRetry", "timeout_ms" and "retry-policy" become separate
 * words. Single-letter prefixes ("iPhone") and acronyms ("HTTP", "IPv4") stay whole.
 */
export function identifierToWords(name: string): string {
  return name
    .replace(/[_.-]+/g, ' ')
    .replace(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*/g, splitCamel)
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIdentifiers(text: string): string {
  return (
    text
      .replace(/(^|[\s("'])--?(?=[A-Za-z])/g, '$1')
      .replace(/(?<=[A-Za-z0-9])_+(?=[A-Za-z0-9])/g, ' ')
      .replace(/(?<![A-Za-z0-9])_+(?=[A-Za-z])|(?<=[A-Za-z0-9])_+(?![A-Za-z0-9_])/g, '')
      // A hyphen next to a single capital stays ("A-B test", "T-shirt", "A-P-I"). With a space instead,
      // the voice reads a lone A as the word "a" ("an A B test" says "uh B").
      .replace(/(?<=[A-Za-z])(?<!\b[A-Z])-(?![A-Z]\b)(?=[A-Za-z])/g, ' ')
      .replace(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*/g, splitCamel)
      .replace(/(?<=[A-Za-z0-9_])\(\)/g, '')
  );
}

/**
 * Words that people say as words even when they are written in capitals: common short words,
 * code words (MAX_RETRIES, DEV, ZIP) and abbreviations said as a word (RAM, GIF, LAN).
 */
const WORDS_IN_CAPITALS = new Set(
  (
    'abs add age ago all an and any app are arg arm as ask at bad bar baz be big bin bit bot box bug ' +
    'bus but buy by can cap cat col cos cow cut dag day dec def dev did dim div do doc dog dom dot ' +
    'dry due ear ego end env era err exp fan far fat fee few fit fix foo for fun gap gas gem get gif ' +
    'git go got had has he her hex him his hit hot how hub ice if in inc inf int is iso its jar jit job ' +
    'key kit lab lag lan law len let lib log lot low mac man map max may me min mix mod mul my nan ' +
    'nas nat net new nil no nor not now odd of off oh old on one ops or our out own pad pay pem ' +
    'per pin pod pop pow pre pro put ram raw red req res rip rom row run say sec see set she sim sin ' +
    'six so spa sum tab tag tan tap tar tax ten the tip to too top try two up use var via wan war was ' +
    'wav way we web who why win yes yet you zen zip'
  ).split(' '),
);

/**
 * Speech engines read a word of two or three capitals either as an abbreviation, letter by letter
 * ("DEV mode" becomes "D, E, V mode"), or, in a short phrase, as a word ("the CLI," becomes "cly").
 * Listed words are written in lower case, so they are always read as words. Any other such word
 * with a vowel is an abbreviation (API, CLI, KPI), so its letters are joined by hyphens, which every
 * engine spells. Without a vowel it is spelled anyway (SDK, PR). Runs after splitIdentifiers,
 * which first frees the capitals inside names (MAX_RETRIES, getAPIKey).
 */
function speakCapitals(text: string): string {
  return (
    text
      // "A/B", "CI/CD", "I/O": abbreviations joined by a slash are read one after the other.
      .replace(/(?<![\w/])([A-Z]{1,4})\/([A-Z]{1,4})(?![\w/])/g, (_m, a: string, b: string) =>
        a.length === 1 && b.length === 1 ? `${a}-${b}` : `${a} ${b}`,
      )
      .replace(/\b[A-Z]{2,3}\b(?![’']\w)/g, (word) => {
        const lower = word.toLowerCase();
        if (WORDS_IN_CAPITALS.has(lower)) return lower;
        // A lone A inside a hyphenated spelling is read as the article ("Q-A team" as "Q, uh, team"),
        // so an abbreviation with an A after its first letter keeps its plain form (QA, IAM, SLA).
        return /[AEIOU]/.test(word) && !/.A/.test(word) ? [...word].join('-') : word;
      })
  );
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

/**
 * First folders of a relative path that are clearly code locations. Everyday words such as
 * "test", "build" or "public" are left out on purpose, so "public/private keys" stays prose.
 */
const COMMON_DIRECTORIES = new Set([
  'src',
  'lib',
  'pkg',
  'cmd',
  'internal',
  'packages',
  'apps',
  'scripts',
  'dist',
  'node_modules',
  'vendor',
  'components',
  'utils',
  'services',
  'controllers',
  'routes',
  'pages',
  'e2e',
  'fixtures',
  'migrations',
  '.github',
]);

const DOMAIN_LIKE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co|gov|edu|me)$/i;

/** Product names that end in ".js" and are not files. */
const PRODUCT_NAMES =
  /^(?:node|next|nuxt|vue|react|express|d3|three|chart|ember|backbone|nest|socket|p5|moment|alpine|solid|preact)\.js$/i;

const FILE_EXTENSIONS =
  'tsx?|mts|cts|jsx?|mjs|cjs|jsonc?|mdx?|ya?ml|toml|py|go|rs|java|kts?|rb|php|c|h|cc|cpp|hpp|cs|swift|sh|bash|zsh|css|scss|html?|sql|txt|lock|xml|gradle|proto|vue|svelte|ini|cfg|conf|env|log|csv|tsv|tf';

const PATH_TOKEN =
  /(?<![\w/.@~-])((?:~\/|\.{1,2}\/|\/)?[\w@+~.-]+(?:\/[\w@+~.-]+)+\/?)(?::(\d+)(?:-(\d+))?)?(?![\w@~-])/g;

const BARE_FILE = new RegExp(
  String.raw`(?<![\w/.@~-])([A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9_@+-]+)*)\.(${FILE_EXTENSIONS})(?::(\d+)(?:-(\d+))?)?(?![\w@/-])`,
  'gi',
);

/** Wrap a spoken name with "the" and "file"/"folder", unless the sentence already has them. */
function describeThing(words: string, kind: 'file' | 'folder', before: string, after: string): string {
  const hasArticle = /\b(?:the|a|an|this|that|our|its|your|my)\s+$/i.test(before);
  const hasNoun =
    /^\s+(?:file|module|script|folder|directory|dir|config|configuration|class|component|tests?|helper|package)\b/i.test(
      after,
    );
  return `${hasArticle ? '' : 'the '}${words}${hasNoun ? '' : ` ${kind}`}`;
}

function lineSuffix(start: string | undefined, end: string | undefined): string {
  if (!start) return '';
  return end ? `, lines ${start} to ${end}` : `, line ${start}`;
}

function replacePaths(text: string): string {
  const withPaths = text.replace(
    PATH_TOKEN,
    (match, raw: string, l1: string | undefined, l2: string | undefined, offset: number, whole: string) => {
      const trailing = /[.,;:!?]+$/.exec(raw)?.[0] ?? '';
      const token = trailing ? raw.slice(0, -trailing.length) : raw;
      const segments = token.split('/').filter((s) => s && s !== '.' && s !== '..' && s !== '~');
      const first = segments[0];
      const last = segments[segments.length - 1];
      if (!first || !last || DOMAIN_LIKE.test(first)) return match;
      const marker = /^(?:~\/|\.{1,2}\/)/.test(token);
      const absolute = token.startsWith('/');
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      const ext = /\.([A-Za-z][A-Za-z0-9]{0,7})$/.exec(last)?.[1];
      if (ext) {
        const stem = last.slice(0, -(ext.length + 1)) || ext;
        const words = identifierToWords(stem);
        if (!words) return match;
        return `${describeThing(words, 'file', before, after)}${lineSuffix(l1, l2)}${trailing}`;
      }
      const isFolder = !absolute && (marker || token.endsWith('/') || COMMON_DIRECTORIES.has(first));
      if (!isFolder) return match;
      const words = identifierToWords(last);
      if (!words) return match;
      return `${describeThing(words, 'folder', before, after)}${trailing}`;
    },
  );
  return withPaths.replace(
    BARE_FILE,
    (
      match,
      stem: string,
      ext: string,
      l1: string | undefined,
      l2: string | undefined,
      offset: number,
      whole: string,
    ) => {
      if (PRODUCT_NAMES.test(`${stem}.${ext}`)) return match;
      const words = identifierToWords(stem);
      if (!words) return match;
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      return `${describeThing(words, 'file', before, after)}${lineSuffix(l1, l2)}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Symbols and units
// ---------------------------------------------------------------------------

/** Words that cannot be the thing a comparison is about: "or < 400" says "or less than 400", not "or is less than 400". */
const CONNECTIVES = new Set([
  'and',
  'or',
  'but',
  'nor',
  'than',
  'then',
  'if',
  'when',
  'while',
  'unless',
  'is',
  'are',
  'was',
  'were',
  'be',
  'not',
  'so',
  'that',
  'only',
  'also',
  'either',
  'neither',
  'between',
  'at',
]);

const SPOKEN_COMPARISON: Record<string, [withSubject: string, bare: string]> = {
  '===': ['equals', 'equals'],
  '==': ['equals', 'equals'],
  '!==': ['is not equal to', 'is not equal to'],
  '!=': ['is not equal to', 'is not equal to'],
  '>=': ['is at least', 'at least'],
  '<=': ['is at most', 'at most'],
  '>': ['is greater than', 'greater than'],
  '<': ['is less than', 'less than'],
};

/**
 * Comparison operators as words, with or without spaces around them. A `<` or `>` is only a
 * comparison when a number is next to it, or when it has a space on both sides and is not a menu path
 * ("Settings > Profile"). Anything else, such as the brackets of "Promise<Response>", is left for tidy().
 */
function expandComparisons(text: string): string {
  return text.replace(
    /[ \t]*(?<![<>=!])(===|!==|==|!=|>=|<=|<|>)(?![<>=])[ \t]*/g,
    (match, op: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      const left = before.slice(-1);
      const right = after.charAt(0);
      const operandBefore = /[\w)\]'"]/.test(left);
      const operandAfter = /[\w(\-+'"$.[]/.test(right);
      if (!operandAfter) return match;
      const equality = /^[!=]/.test(op);
      if (!equality) {
        const numeric = /^[+-]?\d/.test(after) || /\d$/.test(before);
        const spaced = /^[ \t]/.test(match) && /[ \t]$/.test(match);
        const leftWord = /(\w+)$/.exec(before)?.[1] ?? '';
        const rightWord = /^(\w+)/.exec(after)?.[1] ?? '';
        const menuPath = /^[A-Z]/.test(leftWord) && /^[A-Z]/.test(rightWord);
        const wordsBothSides = spaced && /\w/.test(left) && /\w/.test(right);
        if (!numeric && !(wordsBothSides && !menuPath)) return match;
      } else if (!operandBefore && before.trim() !== '' && !/[;,:(]$/.test(before.trim())) {
        return match;
      }
      const [withSubject, bare] = SPOKEN_COMPARISON[op] as [string, string];
      const lastWord = /(\w+)[ \t]*$/.exec(before)?.[1]?.toLowerCase() ?? '';
      const hasSubject = operandBefore && !CONNECTIVES.has(lastWord);
      return ` ${hasSubject ? withSubject : bare} `;
    },
  );
}

function expandSymbols(text: string): string {
  return expandComparisons(
    text
      .replace(/\s*(?:->|=>|→)\s*/g, ' to ')
      .replace(/\s*&&\s*/g, ' and ')
      .replace(/\s*\|\|\s*/g, ' or ')
      .replace(/\s*&\s*/g, ' and ')
      .replace(/(\d)\s?%/g, '$1 percent')
      .replace(/\b([CF])#(?![A-Za-z0-9])/g, '$1 sharp')
      .replace(/(?<![\w&#])#(\d{1,6})\b/g, 'number $1')
      .replace(/(?<![\w~])~(?=\d)/g, 'about ')
      .replace(/(?<=[\w)\]])\^(?=[\w(])|(?<=[\w)\]])[ \t]\^[ \t](?=[\w(])/g, ' to the power of '),
  );
}

interface UnitRule {
  /** Matches the unit text (case sensitive unless the flag is set). */
  unit: string;
  singular: string;
  plural: string;
  /** Allow one space between the number and the unit ("340 ms"). */
  spaced: boolean;
  /** Longest whole-number part, to keep "1990s" and similar out. */
  maxDigits?: number;
  ignoreCase?: boolean;
}

const UNIT_RULES: UnitRule[] = [
  { unit: 'ms', singular: 'millisecond', plural: 'milliseconds', spaced: true },
  { unit: '[µμ]s', singular: 'microsecond', plural: 'microseconds', spaced: true },
  { unit: 'ns', singular: 'nanosecond', plural: 'nanoseconds', spaced: true },
  { unit: 'secs?', singular: 'second', plural: 'seconds', spaced: true },
  { unit: 'mins?', singular: 'minute', plural: 'minutes', spaced: true },
  { unit: 'hrs?', singular: 'hour', plural: 'hours', spaced: true },
  { unit: 's', singular: 'second', plural: 'seconds', spaced: false, maxDigits: 3 },
  { unit: 'h', singular: 'hour', plural: 'hours', spaced: false, maxDigits: 3 },
  { unit: 'KiB', singular: 'kibibyte', plural: 'kibibytes', spaced: true },
  { unit: 'MiB', singular: 'mebibyte', plural: 'mebibytes', spaced: true },
  { unit: 'GiB', singular: 'gibibyte', plural: 'gibibytes', spaced: true },
  { unit: 'kb', singular: 'kilobyte', plural: 'kilobytes', spaced: true, ignoreCase: true },
  { unit: 'mb', singular: 'megabyte', plural: 'megabytes', spaced: true, ignoreCase: true },
  { unit: 'gb', singular: 'gigabyte', plural: 'gigabytes', spaced: true, ignoreCase: true },
  { unit: 'tb', singular: 'terabyte', plural: 'terabytes', spaced: true, ignoreCase: true },
  { unit: 'kHz', singular: 'kilohertz', plural: 'kilohertz', spaced: true },
  { unit: 'MHz', singular: 'megahertz', plural: 'megahertz', spaced: true },
  { unit: 'GHz', singular: 'gigahertz', plural: 'gigahertz', spaced: true },
  { unit: 'Hz', singular: 'hertz', plural: 'hertz', spaced: true },
  { unit: 'fps', singular: 'frame per second', plural: 'frames per second', spaced: true, ignoreCase: true },
  { unit: 'px', singular: 'pixel', plural: 'pixels', spaced: true },
];

function expandUnits(text: string): string {
  let out = text.replace(/(?<![\w.])(\d{2,5})x(\d{2,5})(?![A-Za-z0-9])/g, '$1 by $2');
  out = out.replace(/(?<![\w.])(\d+(?:\.\d+)?)x(?![A-Za-z0-9])/g, '$1 times');
  for (const rule of UNIT_RULES) {
    const digits = rule.maxDigits ? `\\d{1,${rule.maxDigits}}` : '\\d[\\d,]*';
    const number = `(${digits}(?:\\.\\d+)?)`;
    const space = rule.spaced ? '\\s?' : '';
    const pattern = new RegExp(
      `(?<![\\w.,])${number}${space}(?:${rule.unit})(?![A-Za-z0-9])`,
      rule.ignoreCase ? 'gi' : 'g',
    );
    out = out.replace(
      pattern,
      (_match, value: string) => `${value} ${value === '1' ? rule.singular : rule.plural}`,
    );
  }
  return out;
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/[{}[\]|\\^<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/** Text as it should be spoken: markup removed, symbols, units, paths and identifiers in plain words. */
export function toSpokenText(text: string): string {
  let out = normalizeCharacters(text);
  out = expandStarOperators(out);
  out = markupToSentences(out);
  out = out.replace(/\S•{3,}@[\w.-]*\w/g, 'an email address');
  out = out.replace(/•{3,}/g, 'a hidden value');
  out = replaceUrls(out);
  out = expandAbbreviations(out);
  out = replaceTerms(out);
  out = replacePaths(out);
  out = expandSymbols(out);
  out = expandUnits(out);
  out = splitIdentifiers(out);
  out = speakCapitals(out);
  return tidy(out);
}

/**
 * Spoken text for the configured narration language. The wording rules above are English, so
 * other languages only get markup removal and whitespace clean-up.
 */
export function toSpokenTextFor(text: string, language: string): string {
  if (/^en(?:[-_]|$)/i.test(language)) return toSpokenText(text);
  return tidy(markupToSentences(normalizeCharacters(text)).replace(/•{3,}/g, ''));
}
