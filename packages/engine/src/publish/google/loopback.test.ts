import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MergeStoryError } from '../../core/errors.ts';
import { CALLBACK_PATH, receiveAuthorizationCode } from './loopback.ts';

const STATE = 'expected-state-value-0123456789abcdefghi';

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(url: string, options: { method?: string; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers: options.host ? { host: options.host } : {},
        agent: false,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function start(overrides: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  let announce: (uri: string) => void = () => {};
  const ready = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const result = receiveAuthorizationCode({
    setupCommand: 'mergestory setup youtube',
    state: STATE,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    signal: overrides.signal ?? controller.signal,
    onReady: ({ redirectUri }) => announce(redirectUri),
  });
  result.catch(() => {});
  return { controller, ready, result };
}

const callback = (redirect: string, query: string): string => `${redirect}?${query}`;

describe('receiveAuthorizationCode', () => {
  it('listens on 127.0.0.1 and hands back the code of the first valid answer', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    expect(redirect).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${CALLBACK_PATH}$`));
    const answer = await send(callback(redirect, `code=the-code&state=${STATE}`));
    expect(answer.status).toBe(200);
    expect(await result).toBe('the-code');
  });

  it('serves a page that loads nothing and sends no referrer', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    const answer = await send(callback(redirect, `code=c&state=${STATE}`));
    expect(answer.headers['content-type']).toContain('text/html');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    expect(answer.headers['content-security-policy']).toContain("default-src 'none'");
    expect(answer.body).toContain('You can close this tab');
    expect(answer.body).not.toMatch(/<script|src=|href=/i);
    await result;
  });

  it('closes the listener when it is done', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    await send(callback(redirect, `code=c&state=${STATE}`));
    await result;
    await expect(send(redirect)).rejects.toThrow();
  });

  it('rejects an answer with the wrong state and keeps waiting for the real one', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    const forged = await send(callback(redirect, 'code=attacker-code&state=wrong'));
    expect(forged.status).toBe(400);
    expect(forged.body).toContain('does not belong');
    const missing = await send(callback(redirect, 'code=attacker-code'));
    expect(missing.status).toBe(400);
    const real = await send(callback(redirect, `code=real-code&state=${STATE}`));
    expect(real.status).toBe(200);
    expect(await result).toBe('real-code');
  });

  it('does not let a forged error end the sign-in', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    expect((await send(callback(redirect, 'error=access_denied&state=wrong'))).status).toBe(400);
    await send(callback(redirect, `code=real&state=${STATE}`));
    expect(await result).toBe('real');
  });

  it('answers 404 on any other path and 405 on any other method', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    const base = redirect.replace(CALLBACK_PATH, '');
    expect((await send(`${base}/`)).status).toBe(404);
    expect((await send(`${base}/favicon.ico`)).status).toBe(404);
    expect((await send(`${base}/oauth2callback/extra?code=x&state=${STATE}`)).status).toBe(404);
    expect((await send(`${base}//evil.example/oauth2callback?code=x&state=${STATE}`)).status).toBe(404);
    const post = await send(callback(redirect, `code=x&state=${STATE}`), { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET');
    await send(callback(redirect, `code=ok&state=${STATE}`));
    expect(await result).toBe('ok');
  });

  it('refuses a request whose Host header is not the loopback address (DNS rebinding)', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    const rebound = await send(callback(redirect, `code=evil&state=${STATE}`), {
      host: 'attacker.example:80',
    });
    expect(rebound.status).toBe(400);
    await send(callback(redirect, `code=good&state=${STATE}`));
    expect(await result).toBe('good');
  });

  it('fails when the person cancels in the browser', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    const answer = await send(callback(redirect, `error=access_denied&state=${STATE}`));
    expect(answer.status).toBe(400);
    const error = await result.catch((err) => err);
    expect(error).toBeInstanceOf(MergeStoryError);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('cancelled');
  });

  it('fails when Google reports another error, without echoing it blindly', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    await send(callback(redirect, `error=${encodeURIComponent('<script>alert(1)</script>')}&state=${STATE}`));
    const error = await result.catch((err) => err);
    expect(error.message).toContain('no_code');
    expect(error.message).not.toContain('<script>');
  });

  it('fails when the answer has neither a code nor an error', async () => {
    const { ready, result } = start();
    const redirect = await ready;
    await send(callback(redirect, `state=${STATE}`));
    await expect(result).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('times out, and closes the listener', async () => {
    const { ready, result } = start({ timeoutMs: 60 });
    const redirect = await ready;
    const error = await result.catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('timed out');
    expect(error.hint).toContain('mergestory setup youtube');
    await expect(send(redirect)).rejects.toThrow();
  });

  it('stops when the run is cancelled, and closes the listener', async () => {
    const { ready, result, controller } = start();
    const redirect = await ready;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(send(redirect)).rejects.toThrow();
  });

  it('does not start when the run was cancelled before', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = start({ signal: controller.signal });
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('uses a different port every time', async () => {
    const first = start();
    const second = start();
    const [a, b] = await Promise.all([first.ready, second.ready]);
    expect(new URL(a).port).not.toBe(new URL(b).port);
    first.controller.abort();
    second.controller.abort();
    await Promise.allSettled([first.result, second.result]);
  });
});
