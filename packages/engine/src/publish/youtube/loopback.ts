/**
 * The local listener for the sign-in. Google sends the browser back to http://127.0.0.1:<port>
 * with a code; this module waits for exactly one valid answer.
 *
 * The listener binds to 127.0.0.1 on a random port, answers only GET on one path, checks the
 * Host header (against DNS rebinding) and the `state` value (against forged answers), takes the
 * first valid answer only, gives up after a timeout, and always closes.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { abortedError, MergeStoryError } from '../../core/errors.ts';

export const CALLBACK_PATH = '/oauth2callback';

export interface LoopbackOptions {
  /** The random value that was put in the sign-in address. */
  state: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Called once the listener is ready. Print the sign-in address and open the browser here. */
  onReady: (info: { redirectUri: string }) => void | Promise<void>;
}

function page(heading: string, message: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${heading}</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2328}' +
    'h1{font-size:1.4rem}</style></head><body>' +
    `<h1>${heading}</h1><p>${message}</p></body></html>`
  );
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(res: ServerResponse, status: number, html: string, done?: () => void): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  if (done) {
    // Continue once the answer has been written, or when the browser hung up before that.
    let called = false;
    const once = (): void => {
      if (called) return;
      called = true;
      done();
    };
    res.once('finish', once);
    res.once('close', once);
  }
  res.end(html);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), 500);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) =>
      reject(
        new MergeStoryError('PUBLISH_FAILED', 'The local sign-in listener could not start.', {
          hint: 'Check that local connections to 127.0.0.1 are allowed (firewall, VPN software), then try again.',
          cause: err,
        }),
      ),
    );
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** Wait for the browser to come back with the sign-in code. Resolves with the code. */
export async function receiveAuthorizationCode(options: LoopbackOptions): Promise<string> {
  const server = createServer();
  let expectedHost = '';
  let finished = false;
  let succeed: (code: string) => void = () => {};
  let fail: (err: MergeStoryError) => void = () => {};
  const outcome = new Promise<string>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  });
  // The failure may arrive while the sign-in address is still being shown; it is awaited afterwards.
  outcome.catch(() => {});

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers.host !== expectedHost) {
      reply(res, 400, page('Wrong address', 'This page only answers on the address MergeStory opened.'));
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      reply(res, 405, page('Not allowed', 'Only GET requests are accepted here.'));
      return;
    }
    const target = req.url ?? '';
    // Only an ordinary path: "//host/path" would be read as another address.
    const url = /^\/(?!\/)/.test(target) ? new URL(target, `http://${expectedHost}`) : null;
    if (!url || url.pathname !== CALLBACK_PATH) {
      reply(res, 404, page('Not found', 'There is nothing at this address.'));
      return;
    }
    const state = url.searchParams.get('state');
    if (!state || !sameText(state, options.state)) {
      // A forged or stale answer. The real one may still arrive, so keep waiting.
      reply(
        res,
        400,
        page(
          'Sign-in not accepted',
          'This answer does not belong to the sign-in that MergeStory started. Go back to the terminal and try again.',
        ),
      );
      return;
    }
    if (finished) {
      reply(res, 410, page('Already used', 'This sign-in was already completed. You can close this tab.'));
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      finished = true;
      const reason = error && /^[a-z_]{1,40}$/.test(error) ? error : 'no_code';
      reply(
        res,
        400,
        page('Sign-in was not completed', 'You can close this tab and go back to the terminal.'),
        () =>
          fail(
            new MergeStoryError(
              'CONFIG_INVALID',
              reason === 'access_denied'
                ? 'The sign-in was cancelled in the browser.'
                : `Google did not complete the sign-in (${reason}).`,
              {
                hint: 'Run `mergestory setup youtube` again and allow the permissions that Google asks for.',
              },
            ),
          ),
      );
      return;
    }
    finished = true;
    reply(
      res,
      200,
      page('Signed in', 'MergeStory has what it needs. You can close this tab and go back to the terminal.'),
      () => succeed(code),
    );
  };

  server.on('request', handle);
  const port = await listen(server);
  expectedHost = `127.0.0.1:${port}`;

  const timer = setTimeout(
    () =>
      fail(
        new MergeStoryError('CONFIG_INVALID', 'The sign-in timed out.', {
          hint: `Run \`mergestory setup youtube\` again and finish the sign-in in the browser within ${Math.max(1, Math.round(options.timeoutMs / 60_000))} minutes.`,
        }),
      ),
    options.timeoutMs,
  );
  const onAbort = (): void => fail(abortedError());
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal.aborted) onAbort();
    await options.onReady({ redirectUri: `http://${expectedHost}${CALLBACK_PATH}` });
    return await outcome;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
    await closeServer(server);
  }
}
