import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyAnswer, probeAccessProtection } from './access-probe.ts';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let origin: string;
let seen: Seen[];
let handler: Handler;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  handler = (_req, res) => {
    res.writeHead(404).end();
  };
});

/** Answer every request in the same way. */
function reply(status: number, headers: Record<string, string> = {}, body = ''): Handler {
  return (_req, res) => {
    res.writeHead(status, headers).end(body);
  };
}

const ACCESS_LOGIN =
  'https://acme.cloudflareaccess.com/cdn-cgi/access/login/videos.example.com?kid=4f2a&redirect_url=%2Fmergestory%2Fx';

describe('probeAccessProtection: what each kind of address answers', () => {
  // Each row is what a real setup answers to an anonymous request for a file that does not exist.
  const cases: {
    name: string;
    handler: Handler;
    verdict: 'protected' | 'not-protected' | 'unknown';
    reason: string;
    status: number | null;
    detail?: RegExp;
  }[] = [
    {
      name: 'Cloudflare Access sends a redirect to the team sign-in page',
      handler: reply(302, { location: ACCESS_LOGIN, server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-AMS' }),
      verdict: 'protected',
      reason: 'cloudflare-access',
      status: 302,
      detail: /Cloudflare Access sign-in page/,
    },
    {
      name: 'Cloudflare Access with managed OAuth answers 401 and points at its metadata',
      handler: reply(
        401,
        {
          'www-authenticate':
            'Bearer realm="OAuth", error="invalid_token", error_description="Missing or invalid access token", resource_metadata="https://videos.example.com/.well-known/cloudflare-access-protected-resource/"',
          'content-type': 'application/json',
        },
        '{"error":"invalid_token"}',
      ),
      verdict: 'protected',
      reason: 'cloudflare-access-oauth',
      status: 401,
    },
    {
      name: 'Google IAP redirects to Google sign-in when the client accepts a page',
      handler: (req, res) => {
        // IAP redirects clients that accept HTML and answers 401 to all others.
        if (String(req.headers.accept).includes('text/html')) {
          res
            .writeHead(302, {
              location:
                'https://accounts.google.com/o/oauth2/v2/auth?client_id=1234.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fvideos.example.com%2F_gcp_gatekeeper%2Fauthenticate&response_type=code&scope=openid+email',
            })
            .end();
        } else {
          res.writeHead(401).end('Invalid IAP credentials: empty token');
        }
      },
      verdict: 'protected',
      reason: 'identity-provider',
      status: 302,
      detail: /accounts\.google\.com/,
    },
    {
      name: 'oauth2-proxy shows its sign-in page with a 403',
      handler: reply(
        403,
        { 'content-type': 'text/html; charset=utf-8' },
        '<!DOCTYPE html><html><head><title>Sign In</title></head><body><form method="GET" action="/oauth2/start"><input type="hidden" name="rd" value="/x"><button>Sign in with GitHub</button></form></body></html>',
      ),
      verdict: 'protected',
      reason: 'sign-in-page',
      status: 403,
    },
    {
      name: 'oauth2-proxy without the sign-in button redirects to the identity provider',
      handler: reply(302, {
        location:
          'https://github.com/login/oauth/authorize?client_id=Iv1.abc&redirect_uri=https%3A%2F%2Fvideos.example.com%2Foauth2%2Fcallback&state=s',
      }),
      verdict: 'protected',
      reason: 'identity-provider',
      status: 302,
    },
    {
      name: 'Microsoft Entra, Okta, Auth0 and Cognito redirects',
      handler: reply(302, { location: 'https://login.microsoftonline.com/common/oauth2/authorize?x=1' }),
      verdict: 'protected',
      reason: 'identity-provider',
      status: 302,
    },
    {
      name: 'an OAuth request at an unknown identity provider',
      handler: reply(302, {
        location:
          'https://id.corp.example/authorize?client_id=app&redirect_uri=https%3A%2F%2Fv.example.com&response_type=code',
      }),
      verdict: 'protected',
      reason: 'oauth-redirect',
      status: 302,
    },
    {
      name: 'a redirect to a sign-in page on the same host',
      handler: reply(302, { location: '/users/sign_in' }),
      verdict: 'protected',
      reason: 'sign-in-page',
      status: 302,
    },
    {
      name: 'a plain 401 with a Basic challenge',
      handler: reply(401, { 'www-authenticate': 'Basic realm="videos"' }),
      verdict: 'protected',
      reason: 'challenge',
      status: 401,
    },
    {
      name: 'a Cloudflare Access block page',
      handler: reply(
        403,
        { server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-AMS', 'content-type': 'text/html' },
        '<html><title>Forbidden</title><body>Cloudflare Access: you do not have access to this application.</body></html>',
      ),
      verdict: 'protected',
      reason: 'cloudflare-access-page',
      status: 403,
    },
    {
      name: 'CloudFront with signed links answers 403 MissingKey',
      handler: reply(
        403,
        { server: 'CloudFront', 'x-cache': 'Error from cloudfront', 'content-type': 'text/xml' },
        '<Error><Code>MissingKey</Code><Message>Missing Key-Pair-Id query parameter or cookie value</Message></Error>',
      ),
      verdict: 'protected',
      reason: 'cloudfront-signed',
      status: 403,
    },
    {
      name: 'an unprotected R2 custom domain answers 404 for a missing file',
      handler: reply(
        404,
        { server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-AMS', 'content-type': 'application/xml' },
        '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
      ),
      verdict: 'not-protected',
      reason: 'not-found',
      status: 404,
      detail: /open to anyone/,
    },
    {
      name: 'an open address answers 200',
      handler: reply(200, { 'content-type': 'text/html' }, '<html>welcome</html>'),
      verdict: 'not-protected',
      reason: 'open',
      status: 200,
    },
    {
      name: 'CloudFront in front of S3 answers 403 for a missing file, so it proves nothing',
      handler: reply(
        403,
        {
          server: 'CloudFront',
          'x-cache': 'Error from cloudfront',
          via: '1.1 abc.cloudfront.net (CloudFront)',
        },
        '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
      ),
      verdict: 'unknown',
      reason: 'denied',
      status: 403,
      detail: /CloudFront also answers 403/,
    },
    {
      name: 'CloudFront is recognised by the request id header alone',
      handler: reply(403, { 'x-amz-cf-id': 'Zx9WQyRz-abc123==' }, 'denied'),
      verdict: 'unknown',
      reason: 'denied',
      status: 403,
      detail: /CloudFront/,
    },
    {
      name: 'S3 answers AccessDenied (a public bucket or a locked one)',
      handler: reply(403, { server: 'AmazonS3' }, '<Error><Code>AccessDenied</Code></Error>'),
      verdict: 'unknown',
      reason: 'denied',
      status: 403,
      detail: /storage service or a public bucket/,
    },
    {
      name: 'a bare 401, as r2.dev answers when public access is off',
      handler: reply(401, {}, 'Error 401. You are not authorized to view this bucket'),
      verdict: 'unknown',
      reason: 'denied',
      status: 401,
    },
    {
      name: 'a bot check blocks the request',
      handler: reply(
        403,
        { server: 'cloudflare', 'cf-mitigated': 'challenge' },
        '<html>Just a moment...</html>',
      ),
      verdict: 'unknown',
      reason: 'denied',
      status: 403,
      detail: /bot check/,
    },
    {
      name: 'a Cloudflare bot check page that mentions Access is not taken as Access',
      handler: reply(
        403,
        { server: 'cloudflare', 'cf-mitigated': 'challenge' },
        '<html>Checking your browser. Protected by Cloudflare Access (not really)</html>',
      ),
      verdict: 'unknown',
      reason: 'denied',
      status: 403,
    },
    {
      name: 'a redirect to a host that is not a known sign-in service',
      handler: reply(301, { location: 'https://www.example.org/welcome' }),
      verdict: 'unknown',
      reason: 'redirect',
      status: 301,
      detail: /www\.example\.org/,
    },
    {
      name: 'a redirect without a usable address',
      handler: reply(302, {}),
      verdict: 'unknown',
      reason: 'bad-redirect',
      status: 302,
    },
    {
      name: 'a server error',
      handler: reply(502, {}, 'Bad gateway'),
      verdict: 'unknown',
      reason: 'server-error',
      status: 502,
    },
    {
      name: 'a rate limit',
      handler: reply(429, { 'retry-after': '30' }),
      verdict: 'unknown',
      reason: 'unexpected-status',
      status: 429,
    },
  ];

  it.each(cases)('$name', async (item) => {
    handler = item.handler;
    const result = await probeAccessProtection(origin, { pathPrefix: 'mergestory/v/abc/' });
    expect(result.verdict).toBe(item.verdict);
    expect(result.reason).toBe(item.reason);
    expect(result.status).toBe(item.status);
    expect(result.host).toBe(new URL(origin).host);
    if (item.detail) expect(result.detail).toMatch(item.detail);
    expect(seen).toHaveLength(1);
  });

  it('reports an address that cannot be reached as unknown, with the error code', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await probeAccessProtection(`http://127.0.0.1:${port}`);
    expect(result).toMatchObject({ verdict: 'unknown', reason: 'unreachable', status: null });
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('gives up on an address that does not answer in time', async () => {
    handler = () => {
      // Never answers.
    };
    const started = Date.now();
    const result = await probeAccessProtection(origin, { timeoutMs: 200 });
    expect(result).toMatchObject({ verdict: 'unknown', reason: 'timeout', status: null });
    expect(result.detail).toContain('did not answer within');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('gives up on a body that never finishes', async () => {
    handler = (_req, res) => {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.write('<html>');
      // The rest of the page never comes.
    };
    const result = await probeAccessProtection(origin, { timeoutMs: 1000 });
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toBe('denied');
  });
});

describe('probeAccessProtection: the request it sends', () => {
  it('asks anonymously for a random file under the folder of the videos', async () => {
    await probeAccessProtection(`${origin}/media/?token=secret#frag`, {
      pathPrefix: 'mergestory/v/0123abcd/',
    });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe('GET');
    expect(request?.url).toMatch(/^\/media\/mergestory\/v\/0123abcd\/mergestory-check-[0-9a-f]{16}$/);
    expect(request?.headers.accept).toBe('text/html,*/*');
    expect(request?.headers['user-agent']).toMatch(/^mergestory\//);
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'referer']) {
      expect(request?.headers[name], name).toBeUndefined();
    }
  });

  it('uses a different file name every time, so a cached answer cannot be reused', async () => {
    await probeAccessProtection(origin);
    await probeAccessProtection(origin);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).not.toBe(seen[1]?.url);
    expect(seen[0]?.url).toMatch(/^\/mergestory-check-[0-9a-f]{16}$/);
  });

  it('keeps a folder prefix inside the address', async () => {
    await probeAccessProtection(`${origin}/media`, { pathPrefix: '../../etc//./a b/ok-1/' });
    expect(seen[0]?.url).toMatch(/^\/media\/etc\/ok-1\/mergestory-check-[0-9a-f]{16}$/);
  });

  it('refuses addresses that are not plain http(s) addresses', async () => {
    for (const bad of ['ftp://videos.example.com', 'not a url', 'https://user:pass@videos.example.com', '']) {
      await expect(probeAccessProtection(bad)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
    expect(seen).toHaveLength(0);
  });

  it('throws ABORTED when the run is cancelled, and sends nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(probeAccessProtection(origin, { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(seen).toHaveLength(0);
  });

  it('throws ABORTED when the run is cancelled while it waits', async () => {
    handler = () => {
      // Never answers.
    };
    const controller = new AbortController();
    const pending = probeAccessProtection(origin, { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('probeAccessProtection: redirects', () => {
  it('follows redirects inside the same host, then decides', async () => {
    handler = (req, res) => {
      if (!req.url?.endsWith('/')) res.writeHead(301, { location: `${req.url}/` }).end();
      else res.writeHead(404).end();
    };
    const result = await probeAccessProtection(origin);
    expect(result).toMatchObject({ verdict: 'not-protected', reason: 'not-found', status: 404 });
    expect(seen.map((s) => s.url.endsWith('/'))).toEqual([false, true]);
  });

  it('finds the sign-in step at the end of a same-host redirect', async () => {
    handler = (req, res) => {
      if (req.url?.startsWith('/gate')) res.writeHead(302, { location: ACCESS_LOGIN }).end();
      else res.writeHead(307, { location: '/gate/start' }).end();
    };
    const result = await probeAccessProtection(origin);
    expect(result).toMatchObject({ verdict: 'protected', reason: 'cloudflare-access' });
    expect(seen).toHaveLength(2);
  });

  it('stops after two redirects inside the same host', async () => {
    let count = 0;
    handler = (_req, res) => {
      count += 1;
      res.writeHead(302, { location: `/hop-${count}` }).end();
    };
    const result = await probeAccessProtection(origin);
    expect(result).toMatchObject({ verdict: 'unknown', reason: 'too-many-redirects' });
    expect(seen).toHaveLength(3);
  });

  it('never follows a redirect to another host', async () => {
    const other = createServer((_req, res) => {
      res.writeHead(200).end('should not be asked');
    });
    const hits: string[] = [];
    other.on('request', (req) => hits.push(req.url ?? ''));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      const port = (other.address() as AddressInfo).port;
      // "localhost" and "127.0.0.1" are different hosts for this check.
      handler = reply(302, { location: `http://localhost:${port}/landing` });
      const result = await probeAccessProtection(origin);
      expect(result).toMatchObject({ verdict: 'unknown', reason: 'redirect', status: 302 });
      expect(hits).toEqual([]);
    } finally {
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

describe('probeAccessProtection with a replaced fetch', () => {
  it('reads redirects without following them', async () => {
    const calls: RequestInit[] = [];
    const result = await probeAccessProtection('https://videos.example.com', {
      fetch: async (_input, init) => {
        calls.push(init ?? {});
        return new Response(null, { status: 302, headers: { location: ACCESS_LOGIN } });
      },
    });
    expect(result).toMatchObject({ verdict: 'protected', host: 'videos.example.com' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe('manual');
    expect(calls[0]?.credentials).toBeUndefined();
  });

  it('reads only the start of a long error page', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(4096)));
        if (pulled > 50) controller.close();
      },
    });
    const result = await probeAccessProtection('https://videos.example.com', {
      fetch: async () => new Response(body, { status: 403 }),
    });
    expect(result).toMatchObject({ verdict: 'unknown', reason: 'denied' });
    expect(pulled).toBeLessThan(10);
  });
});

describe('classifyAnswer', () => {
  const url = new URL('https://videos.example.com/mergestory/check');
  const answer = (status: number, headers: Record<string, string> = {}, body = '') => ({
    status,
    headers: new Headers(headers),
    body,
    url,
  });

  it('treats every 2xx answer as open', () => {
    for (const status of [200, 204, 206]) {
      expect(classifyAnswer(answer(status))).toMatchObject({ kind: 'verdict', verdict: 'not-protected' });
    }
  });

  it('does not treat other 3xx answers as redirects', () => {
    for (const status of [300, 304, 305]) {
      expect(classifyAnswer(answer(status, { location: ACCESS_LOGIN }))).toMatchObject({
        kind: 'verdict',
        verdict: 'unknown',
        reason: 'unexpected-status',
      });
    }
  });

  it('resolves a relative sign-in address against the address that was asked', () => {
    expect(classifyAnswer(answer(302, { location: '../oauth2/start?rd=%2F' }))).toMatchObject({
      verdict: 'protected',
      reason: 'sign-in-page',
    });
  });

  it('only follows redirects to http(s) addresses', () => {
    expect(classifyAnswer(answer(302, { location: 'javascript:alert(1)' }))).toMatchObject({
      verdict: 'unknown',
      reason: 'bad-redirect',
    });
    expect(classifyAnswer(answer(302, { location: 'ftp://videos.example.com/x' }))).toMatchObject({
      verdict: 'unknown',
      reason: 'bad-redirect',
    });
  });

  it('follows a redirect from http to https on the same host', () => {
    const decision = classifyAnswer({
      ...answer(301, { location: 'https://videos.example.com/mergestory/check' }),
      url: new URL('http://videos.example.com/mergestory/check'),
    });
    expect(decision).toMatchObject({ kind: 'follow' });
  });

  it('does not call a page protected because of a word that only contains "login"', () => {
    // Not a sign-in page, and on the same host, so the probe asks again instead of deciding.
    expect(classifyAnswer(answer(302, { location: '/catalog/loginfo/page' }))).toMatchObject({
      kind: 'follow',
    });
  });

  it('never puts the address or any header value into the detail', () => {
    const decision = classifyAnswer(
      answer(302, { location: 'https://evil.example.net/path?token=SECRET123&kid=abc' }),
    );
    expect(JSON.stringify(decision)).not.toContain('SECRET123');
    expect(JSON.stringify(decision)).not.toContain('/path');
  });
});
