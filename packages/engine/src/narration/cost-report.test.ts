import { afterEach, describe, expect, it } from 'vitest';
import { type FetchMock, makeStoryboard, makeTestContext, mockFetch, pcmTone } from '../testing/narration.ts';
import { createOpenAiProvider } from './openai.ts';
import { synthesizeNarration } from './synthesize.ts';

const KEY = 'sk-test-0123456789abcdefghijklmnop';

let mock: FetchMock | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
});

describe('speech cost report', () => {
  it('records a paid run and then the same run from the cache', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => new Response(pcmTone(1), { status: 200 }));
    const provider = createOpenAiProvider();
    const storyboard = makeStoryboard({
      s1: ['Retries now back off exponentially.', 'Failed requests wait longer each time.'],
    });
    await synthesizeNarration(storyboard, provider, ctx);
    expect(JSON.stringify(ctx.cost.report().records)).toBe(
      '[{"provider":"openai","kind":"tts","model":"gpt-4o-mini-tts","characters":35,"costUsd":0.00063,"estimated":true},' +
        '{"provider":"openai","kind":"tts","model":"gpt-4o-mini-tts","characters":38,"costUsd":0.000684,"estimated":true}]',
    );
    expect(JSON.stringify(ctx.egress.list())).toBe(
      '[{"destination":"api.openai.com","purpose":"speech synthesis","bytes":73,"contains":["narration-text"]}]',
    );

    const again = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY }, cache: ctx.cache });
    await synthesizeNarration(storyboard, provider, again.ctx);
    expect(JSON.stringify(again.ctx.cost.report().records)).toBe(
      '[{"provider":"openai","kind":"tts","model":"gpt-4o-mini-tts","characters":73,"costUsd":0,"estimated":false,"cached":true}]',
    );
    await again.cleanup();
    await cleanup();
  });
});
