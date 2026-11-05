import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openInBrowser, readHidden, type TerminalInput } from './prompt.ts';

class FakeInput extends EventEmitter implements TerminalInput {
  isRaw = false;
  rawModes: boolean[] = [];
  paused = false;
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModes.push(mode);
  }
  setEncoding(): void {}
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  type(text: string): void {
    this.emit('data', text);
  }
}

function terminal() {
  const input = new FakeInput();
  let shown = '';
  const output = {
    write: (text: string): void => {
      shown += text;
    },
  };
  return { input, output, shown: () => shown };
}

describe('readHidden', () => {
  it('returns what was typed and never shows it', async () => {
    const t = terminal();
    const answer = readHidden('Secret: ', t.input, t.output);
    t.input.type('abc');
    t.input.type('def\r');
    expect(await answer).toBe('abcdef');
    expect(t.shown()).toBe('Secret: \n');
  });

  it('puts the terminal back as it was', async () => {
    const t = terminal();
    const answer = readHidden('Secret: ', t.input, t.output);
    expect(t.input.isRaw).toBe(true);
    t.input.type('x\n');
    await answer;
    expect(t.input.isRaw).toBe(false);
    expect(t.input.paused).toBe(true);
    expect(t.input.listenerCount('data')).toBe(0);
  });

  it('handles a paste that arrives in one piece, and trims it', async () => {
    const t = terminal();
    const answer = readHidden('Secret: ', t.input, t.output);
    t.input.type('  pasted-value-123  \r');
    expect(await answer).toBe('pasted-value-123');
  });

  it('lets backspace remove characters', async () => {
    const t = terminal();
    const answer = readHidden('Secret: ', t.input, t.output);
    t.input.type('abcd\u007f\u007f\bX\r');
    expect(await answer).toBe('aX');
  });

  it('ignores arrow keys and other escape sequences', async () => {
    const t = terminal();
    const answer = readHidden('Secret: ', t.input, t.output);
    t.input.type('ab');
    t.input.type('\u001b[A');
    t.input.type('c\r');
    expect(await answer).toBe('abc');
  });

  it('cancels on Ctrl+C', async () => {
    const t = terminal();
    const answer = readHidden('Secret: ', t.input, t.output);
    t.input.type('abc\u0003');
    await expect(answer).rejects.toMatchObject({ code: 'ABORTED' });
    expect(t.input.isRaw).toBe(false);
  });

  it('accepts Ctrl+D after some input and cancels on an empty line', async () => {
    const a = terminal();
    const first = readHidden('Secret: ', a.input, a.output);
    a.input.type('abc\u0004');
    expect(await first).toBe('abc');
    const b = terminal();
    const second = readHidden('Secret: ', b.input, b.output);
    b.input.type('\u0004');
    await expect(second).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('cancels when the run is cancelled', async () => {
    const t = terminal();
    const controller = new AbortController();
    const answer = readHidden('Secret: ', t.input, t.output, controller.signal);
    controller.abort();
    await expect(answer).rejects.toMatchObject({ code: 'ABORTED' });
    expect(t.input.isRaw).toBe(false);
  });

  it('does not ask when the run is already cancelled', async () => {
    const t = terminal();
    const controller = new AbortController();
    controller.abort();
    await expect(readHidden('Secret: ', t.input, t.output, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(t.shown()).toBe('');
  });

  it('works on an input without raw mode', async () => {
    const t = terminal();
    const input = t.input as Partial<FakeInput> & TerminalInput;
    input.setRawMode = undefined;
    const answer = readHidden('Secret: ', input, t.output);
    t.input.type('ok\r');
    expect(await answer).toBe('ok');
  });
});

describe('openInBrowser', () => {
  const calls: [string, string[]][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, args]);
  };

  it('uses the launcher of each platform, with the address as one argument', async () => {
    calls.length = 0;
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=a%20b';
    expect(await openInBrowser(url, run, 'darwin')).toBe(true);
    expect(await openInBrowser(url, run, 'linux')).toBe(true);
    expect(await openInBrowser(url, run, 'win32')).toBe(true);
    expect(calls).toEqual([
      ['open', [url]],
      ['xdg-open', [url]],
      ['rundll32', ['url.dll,FileProtocolHandler', url]],
    ]);
  });

  it('returns false when the launcher fails', async () => {
    const failing = async () => {
      throw new Error('Command not found: xdg-open');
    };
    expect(await openInBrowser('https://example.com/', failing, 'linux')).toBe(false);
  });

  it('only opens http and https addresses', async () => {
    calls.length = 0;
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com',
      'not a url',
      '-flag',
    ]) {
      expect(await openInBrowser(url, run, 'darwin')).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});
