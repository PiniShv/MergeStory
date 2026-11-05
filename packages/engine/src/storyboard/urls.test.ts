import { describe, expect, it } from 'vitest';
import { foreignUrls } from './urls.ts';

describe('foreignUrls', () => {
  it.each([
    ['Open evil.com now.', ['evil.com']],
    ['See attacker.io/login for details.', ['attacker.io/login']],
    ['Get ftp://evil.com/x today.', ['ftp://evil.com/x']],
    ['Open https://evil.com now.', ['https://evil.com']],
  ])('finds the address in "%s"', (text, found) => {
    expect(foreignUrls(text)).toEqual(found);
  });

  it('does not take a file name or a code name for an address', () => {
    expect(foreignUrls('Edit README.md, index.ts, node.js, main.py, setup.sh and config.json.')).toEqual([]);
    expect(
      foreignUrls('It calls req.app.get() and then socket.io.connect.', new Set(), 'socket.io.connect()'),
    ).toEqual([]);
  });

  it.each([
    'Log in at acme-support.top/login to confirm.',
    'Open evil.ru now.',
    'Visit paypal-verify.shop today.',
    'Open docs-portal.dev for details.',
  ])('finds a bare host with any top-level domain in "%s"', (text) => {
    expect(foreignUrls(text, new Set(), 'const x = 1;').length).toBe(1);
  });

  it('takes a name that ends like a file for an address when a path follows it', () => {
    expect(foreignUrls('Log in at paypal-verify.pl/approve to confirm.')).toEqual([
      'paypal-verify.pl/approve',
    ]);
    expect(foreignUrls('Get the fix from github-releases.zip/download now.').length).toBe(1);
    expect(foreignUrls('Run deploy.sh, then check main.tf and main.py:42.')).toEqual([]);
  });

  it('reads a file name with a line number as a file, not as an address with a port', () => {
    expect(foreignUrls('The retry starts at retry.ts:42 and ends at handler.go:10.')).toEqual([]);
    expect(foreignUrls('Open evil.com:8080/login now.')).toEqual(['evil.com:8080/login']);
  });

  it('allows a bare name that the code contains, whatever follows it', () => {
    const code = "logger.info('retrying', { attempt }); req.app.get('x'); console.info(1)";
    expect(foreignUrls('Each retry is logged with logger.info.', new Set(), code)).toEqual([]);
    expect(foreignUrls('It reads its settings from req.app.', new Set(), code)).toEqual([]);
    expect(foreignUrls('It uses Logger.Info too.', new Set(), code)).toEqual([]);
    expect(foreignUrls('Open evil.ru now.', new Set(), code)).toEqual(['evil.ru']);
  });

  it('does not take file names, product names or abbreviations for addresses', () => {
    expect(foreignUrls('Ask jane.doe@acme.test.')).toEqual([]);
    expect(foreignUrls('Edit go.mod, Cargo.lock, README.md and index.ts.')).toEqual([]);
    expect(foreignUrls('It runs on ASP.NET Core, Next.js and node.js, e.g. i.e. here.')).toEqual([]);
    expect(foreignUrls('It uses VB.NET, ADO.NET and Socket.IO.')).toEqual([]);
  });

  it('lets through a local, reserved or allowed host', () => {
    expect(foreignUrls('Call localhost:3000/health or example.com.')).toEqual([]);
    expect(foreignUrls('It calls api.weather-provider.net.', new Set(['api.weather-provider.net']))).toEqual(
      [],
    );
  });
});
