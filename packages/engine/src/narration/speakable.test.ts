import { describe, expect, it } from 'vitest';
import { identifierToWords, toSpokenText, toSpokenTextFor } from './speakable.ts';

function cases(table: [input: string, expected: string][]): void {
  for (const [input, expected] of table) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(toSpokenText(input)).toBe(expected);
    });
  }
}

describe('toSpokenText: markup', () => {
  cases([
    ['**Bold** and *italic* and `code`', 'Bold and italic and code'],
    ['Uses `fetchWithRetry` now', 'Uses fetch With Retry now'],
    ['See [the docs](https://example.com/docs) now', 'See the docs now'],
    ['![diagram](a.png) shows it', 'diagram shows it'],
    ['# Heading\nBody text', 'Heading. Body text'],
    ['- first point\n- second point', 'first point. second point'],
    ['1. Parse it\n2. Run it', 'Parse it. Run it'],
    ['> quoted words', 'quoted words'],
    ['Some <b>bold</b> HTML', 'Some bold HTML'],
    ['Fish &amp; chips', 'Fish and chips'],
    ['```ts\nconst a = 1;\n```', 'const a = 1;'],
    ['~~old~~ new', 'old new'],
  ]);
});

describe('toSpokenText: abbreviations and symbols', () => {
  cases([
    ['Use retries, e.g. on timeouts', 'Use retries, for example on timeouts'],
    ['E.g. this one', 'For example this one'],
    ['It is cached, i.e. stored locally', 'It is cached, that is stored locally'],
    ['Logs, metrics, etc. are kept', 'Logs, metrics, and so on are kept'],
    ['Logs, metrics, etc., are kept', 'Logs, metrics, and so on, are kept'],
    ['It covers logs, metrics, etc. Then it stops', 'It covers logs, metrics, and so on. Then it stops'],
    ['It covers logs, metrics, etc.', 'It covers logs, metrics, and so on.'],
    ['Local vs. remote', 'Local versus remote'],
    ['a -> b', 'a to b'],
    ['a->b', 'a to b'],
    ['x => y', 'x to y'],
    ['lint && test', 'lint and test'],
    ['read || write', 'read or write'],
    ['Q&A time', 'Q and A time'],
    ['50% faster', '50 percent faster'],
    ['It takes ~5 seconds', 'It takes about 5 seconds'],
    ['count == 3', 'count equals 3'],
    ['count != 3', 'count is not equal to 3'],
    ['C# and F# code', 'C sharp and F sharp code'],
  ]);
});

describe('toSpokenText: comparisons and powers', () => {
  cases([
    [
      'Status >= 500 or === 429 is retried; < 400 is not.',
      'Status is at least 500 or equals 429 is retried; less than 400 is not.',
    ],
    ['status>=500', 'status is at least 500'],
    ['It is >=500', 'It is at least 500'],
    ['count>3 and total<=10', 'count is greater than 3 and total is at most 10'],
    ['If 3 > 2 then 5 >= 5.', 'If 3 is greater than 2 then 5 is at least 5.'],
    ['attempt > limit', 'attempt is greater than limit'],
    ['a < b', 'a is less than b'],
    ['x==y and x!==z', 'x equals y and x is not equal to z'],
    ['a === b', 'a equals b'],
    ['x * 2 ** attempt', 'x times 2 to the power of attempt'],
    [
      'It returns x * 2 ** attempt, capped at 1e3.',
      'It returns x times 2 to the power of attempt, capped at 1e3.',
    ],
    ['2^attempt', '2 to the power of attempt'],
    ['Retries use 2^attempt times 250 ms.', 'Retries use 2 to the power of attempt times 250 milliseconds.'],
    ['The delay is 2**attempt seconds.', 'The delay is 2 to the power of attempt seconds.'],
    ['3 * 4', '3 times 4'],
  ]);

  it('keeps the words of a sentence that has no operator, and the emphasis of markdown', () => {
    expect(toSpokenText('**Bold** and *italic*')).toBe('Bold and italic');
    expect(toSpokenText('- first\n- second')).toBe('first. second');
    expect(toSpokenText('* star bullet\n* other')).toBe('star bullet. other');
  });

  it('does not read the brackets of a type or a menu path as a comparison', () => {
    expect(toSpokenText('Promise<Response> is returned')).toBe('Promise Response is returned');
    expect(toSpokenText('Returns Array<string>')).toBe('Returns Array string');
    expect(toSpokenText('Settings > Cities > Forecasts')).toBe('Settings Cities Forecasts');
  });

  it('does not turn a caret that starts a pattern into a power', () => {
    expect(toSpokenText('match ^foo in the text')).toBe('match foo in the text');
  });

  it('says the same thing as the caption, so the voice never states another rule', () => {
    const spoken = toSpokenText('Status >= 500 or === 429 is retried; < 400 is not.');
    for (const word of ['at least 500', 'equals 429', 'less than 400']) expect(spoken).toContain(word);
  });
});

describe('toSpokenText: issue numbers', () => {
  cases([
    ['Fixes #123', 'Fixes number 123'],
    ['See PR #42 and #7.', 'See PR number 42 and number 7.'],
    ['The #1234 issue', 'The number 1234 issue'],
  ]);
});

describe('toSpokenText: units glued to numbers', () => {
  cases([
    ['It took 1.2s', 'It took 1.2 seconds'],
    ['A 340ms delay', 'A 340 milliseconds delay'],
    ['A 340 ms delay', 'A 340 milliseconds delay'],
    ['Up to 10MB', 'Up to 10 megabytes'],
    ['Up to 10mb', 'Up to 10 megabytes'],
    ['1ms and 1s and 1MB', '1 millisecond and 1 second and 1 megabyte'],
    ['About 250µs', 'About 250 microseconds'],
    ['A 30s timeout', 'A 30 seconds timeout'],
    ['Wait 5min', 'Wait 5 minutes'],
    ['Waits 2h', 'Waits 2 hours'],
    ['Audio at 48kHz', 'Audio at 48 kilohertz'],
    ['Renders at 60fps', 'Renders at 60 frames per second'],
    ['A 16px gap', 'A 16 pixels gap'],
    ['It is 2x faster', 'It is 2 times faster'],
    ['At 1920x1080', 'At 1920 by 1080'],
    ['Cache of 512KiB', 'Cache of 512 kibibytes'],
  ]);

  it('leaves decades and plain numbers alone', () => {
    expect(toSpokenText('Music from the 1990s')).toBe('Music from the 1990s');
    expect(toSpokenText('Error 429')).toBe('Error 429');
    expect(toSpokenText('30000 items')).toBe('30000 items');
    expect(toSpokenText('Version v2.1.0')).toBe('Version v2.1.0');
    expect(toSpokenText('2.5 second wait')).toBe('2.5 second wait');
    expect(toSpokenText('Percentile p99')).toBe('Percentile p99');
  });
});

describe('toSpokenText: file paths', () => {
  cases([
    ['src/weather/client.ts', 'the client file'],
    ['Edit src/weather/client.ts now', 'Edit the client file now'],
    ['Edit src/weather/client.ts.', 'Edit the client file.'],
    ['The client.ts file changed', 'The client file changed'],
    ['It lives in retry.ts', 'It lives in the retry file'],
    ['See client.test.ts', 'See the client test file'],
    ['Look at package.json', 'Look at the package file'],
    ['See package-lock.json', 'See the package lock file'],
    ['Open the README.md', 'Open the README file'],
    ['packages/engine/src/narration/index.ts:12-40', 'the index file, lines 12 to 40'],
    ['src/retry.ts:12', 'the retry file, line 12'],
    ['src/weather/fetchWithRetry.ts', 'the fetch With Retry file'],
    ['./scripts/build.mjs', 'the build file'],
    ['Edit src/core/', 'Edit the core folder'],
    ['Everything under packages/engine/src', 'Everything under the src folder'],
    ['Look in the src/utils folder', 'Look in the utils folder'],
  ]);

  it('leaves slash-separated everyday words alone, even when they look like folders', () => {
    expect(toSpokenText('Works in dev/test/prod')).toBe('Works in dev/test/prod');
    expect(toSpokenText('Handles public/private keys')).toBe('Handles public/private keys');
    expect(toSpokenText('Runs build/test steps')).toBe('Runs build/test steps');
  });

  it('leaves words joined by a slash alone', () => {
    expect(toSpokenText('A client/server design')).toBe('A client/server design');
    expect(toSpokenText('read/write access, and/or more')).toBe('read/write access, and/or more');
    expect(toSpokenText('Open 24/7')).toBe('Open 24/7');
    expect(toSpokenText('I/O heavy')).toBe('I/O heavy');
  });

  it('leaves product names, domains and routes alone', () => {
    expect(toSpokenText('Runs on Node.js')).toBe('Runs on Node.js');
    expect(toSpokenText('Built with Next.js and Vue.js')).toBe('Built with Next.js and Vue.js');
    expect(toSpokenText('Visit github.com/acme/repo')).toBe('Visit github.com/acme/repo');
    expect(toSpokenText('The page /settings/cities')).toBe('The page /settings/cities');
  });
});

describe('toSpokenText: identifiers', () => {
  cases([
    ['fetchWithRetry', 'fetch With Retry'],
    ['timeout_ms', 'timeout ms'],
    ['retry-policy', 'retry policy'],
    ['getHTTPResponse', 'get HTTP Response'],
    ['parseJSON', 'parse JSON'],
    ['MAX_RETRIES', 'MAX RETRIES'],
    ['__init__', 'init'],
    ['retry() is called', 'retry is called'],
    ['Pass --dry-run to skip it', 'Pass dry run to skip it'],
    ['The base64Encode helper', 'The base64 Encode helper'],
    ['XMLHttpRequest', 'XML Http Request'],
    ['OAuth', 'O Auth'],
    ['S3Client', 'S3 Client'],
    ['getUserById', 'get User By Id'],
    ['isOk', 'is Ok'],
    ['The `getUserById()` function', 'The get User By Id function'],
  ]);

  it('keeps names that are already read well', () => {
    for (const word of [
      'iPhone',
      'iOS',
      'IPv4',
      'IPv6',
      'eBay',
      'NaN',
      'APIs',
      'HTTP',
      'CLI',
      'npm',
      'p99',
      'sha256',
      'PhD',
    ]) {
      expect(toSpokenText(word)).toBe(word);
    }
  });

  it('splits well-known product names into their parts (the engine reads them the same way)', () => {
    expect(toSpokenText('GitHub API')).toBe('Git Hub API');
    expect(toSpokenText('TypeScript')).toBe('Type Script');
    expect(toSpokenText('PostgreSQL')).toBe('Postgre SQL');
  });

  it('identifierToWords handles file stems', () => {
    expect(identifierToWords('client.test')).toBe('client test');
    expect(identifierToWords('my_file-name')).toBe('my file name');
  });
});

describe('toSpokenText: other', () => {
  cases([
    ['  lots   of \n\t space  ', 'lots of space'],
    ['The key is ••••••••.', 'The key is a hidden value.'],
    ['Ask a•••@example.com.', 'Ask an email address.'],
    ['Open https://github.com/acme/repo/pull/12.', 'Open a link.'],
    ['See www.example.com, then stop', 'See a link, then stop'],
    ['Costs $1,299.50 in 2026', 'Costs $1,299.50 in 2026'],
    ['At 3:45 PM, Dr. Smith', 'At 3:45 PM, Dr. Smith'],
    ['', ''],
  ]);

  it('is stable when applied twice', () => {
    const samples = [
      'Edit src/weather/client.ts and call fetchWithRetry() with a 340ms delay, e.g. on 429.',
      'See PR #42 -> merged && deployed',
      '**Bold** `code` and [a link](https://example.com)',
      'Uses timeout_ms and retry-policy values',
      'Status >= 500 or === 429 is retried; < 400 is not, and x * 2 ** n or 2^n grows.',
    ];
    for (const sample of samples) {
      const once = toSpokenText(sample);
      expect(toSpokenText(once)).toBe(once);
    }
  });

  it('turns the whole tech-term table into plain words', () => {
    const line =
      'The GitHub API returns 429 after 1.2s, so fetchWithRetry in src/weather/client.ts waits 340ms, e.g. on timeout_ms and #1234.';
    expect(toSpokenText(line)).toBe(
      'The Git Hub API returns 429 after 1.2 seconds, so fetch With Retry in the client file waits 340 milliseconds, for example on timeout ms and number 1234.',
    );
  });
});

describe('toSpokenTextFor', () => {
  it('uses the English rules for English', () => {
    expect(toSpokenTextFor('e.g. 340ms', 'en')).toBe('for example 340 milliseconds');
    expect(toSpokenTextFor('e.g. 340ms', 'en-GB')).toBe('for example 340 milliseconds');
  });

  it('only removes markup for other languages', () => {
    expect(toSpokenTextFor('**Hallo** `Welt`  e.g. 340ms', 'de')).toBe('Hallo Welt e.g. 340ms');
  });
});
