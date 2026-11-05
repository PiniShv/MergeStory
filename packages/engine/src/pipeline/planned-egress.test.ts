import { describe, expect, it, vi } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import type { ChangeSet, EgressRecord } from '../core/types.ts';
import { testContext } from '../testing/context.ts';
import { type EgressPlanInput, planEgress } from './planned-egress.ts';

const PR_URL = 'https://github.com/example/weather/pull/42';

/** Speech that stays on this machine. */
const LOCAL_SPEECH = { plannedEgress: async (): Promise<EgressRecord[]> => [] };

function plan(overrides: ConfigInput, patch: Partial<EgressPlanInput> = {}) {
  return planEgress({
    ctx: testContext({ config: overrides, runId: 'plan', runDir: '/unused/plan' }).ctx,
    changeSet: {
      source: 'github',
      pr: { url: PR_URL } as ChangeSet['pr'],
    },
    llm: null,
    tts: LOCAL_SPEECH,
    narrationChars: 1000,
    estimatedVideoBytes: 11_000_000,
    publishBlocked: false,
    ...patch,
  });
}

const S3 = {
  provider: 's3' as const,
  s3: { bucket: 'media', endpoint: 'https://acct.r2.cloudflarestorage.com' },
};

describe('planEgress: the pull request', () => {
  it('lists no pull request update, and says why, when the video stays on this machine', async () => {
    for (const provider of ['local', 'none'] as const) {
      const { egress, warnings } = await plan({ publish: { provider }, github: { comment: true } });
      expect(egress).toEqual([]);
      expect(warnings).toEqual([
        'The pull request would not be updated: the video stays on this machine. Publish it first (for example --publish s3).',
      ]);
    }
  });

  it('says so when the change does not come from a pull request', async () => {
    const { egress, warnings } = await plan(
      { publish: S3, github: { updateDescription: true } },
      { changeSet: { source: 'local', pr: null } },
    );
    expect(egress.map((e) => e.purpose)).toEqual(['video upload']);
    expect(warnings[0]).toContain('does not come from a GitHub pull request');
  });

  it('sends the update to the API of the pull request itself, not to the configured one', async () => {
    const enterprise = await plan(
      { publish: S3, github: { comment: true, updateDescription: true } },
      {
        changeSet: {
          source: 'github',
          pr: { url: 'https://ghe.example.com/example/weather/pull/7' } as ChangeSet['pr'],
        },
      },
    );
    const updates = enterprise.egress.filter((e) => e.purpose.startsWith('pull request'));
    expect(updates.map((e) => [e.destination, e.purpose])).toEqual([
      ['ghe.example.com', 'pull request comment'],
      ['ghe.example.com', 'pull request description'],
    ]);
    // A pull request on github.com goes to api.github.com whatever github.apiUrl says.
    const dotcom = await plan({
      publish: S3,
      github: { comment: true, apiUrl: 'https://ghe.example.com/api/v3' },
    });
    expect(dotcom.egress.find((e) => e.purpose === 'pull request comment')?.destination).toBe(
      'api.github.com',
    );
  });

  it('asks nothing of GitHub when no update was requested', async () => {
    expect((await plan({ publish: S3 })).egress.map((e) => e.destination)).toEqual([
      'acct.r2.cloudflarestorage.com',
    ]);
  });
});

describe('planEgress: uploads', () => {
  it('lists what the publisher would send, in its own words, and nothing for a video that stays here', async () => {
    expect((await plan({ publish: S3 })).egress[0]).toMatchObject({
      destination: 'acct.r2.cloudflarestorage.com',
      purpose: 'video upload',
      bytes: 11_000_000,
    });
    expect((await plan({ publish: { provider: 'local' } })).egress).toEqual([]);
    expect((await plan({ publish: { provider: 'none' } })).egress).toEqual([]);
  });

  it('lists nothing for a publish setting that would make the run stop first', async () => {
    const noBucket = await plan(
      { publish: { provider: 's3' }, github: { comment: true } },
      { publishBlocked: true },
    );
    expect(noBucket.egress).toEqual([]);
    expect(JSON.stringify(noBucket)).not.toContain('<bucket>');
    const blocked = await plan({ publish: S3, github: { comment: true } }, { publishBlocked: true });
    expect(blocked.egress).toEqual([]);
  });

  it('adds the protection check, which carries nothing', async () => {
    const { egress } = await plan({
      publish: {
        ...S3,
        visibility: 'protected',
        s3: {
          bucket: 'media',
          endpoint: 'https://acct.r2.cloudflarestorage.com',
          publicBaseUrl: 'https://videos.example.com',
        },
      },
    });
    expect(egress.map((e) => [e.destination, e.purpose, e.bytes])).toEqual([
      ['acct.r2.cloudflarestorage.com', 'video upload', 11_000_000],
      ['videos.example.com', 'protection check', 0],
    ]);
  });

  it('lists the YouTube upload', async () => {
    expect((await plan({ publish: { provider: 'youtube' } })).egress).toMatchObject([
      { destination: 'www.googleapis.com', purpose: 'video upload' },
    ]);
  });
});

describe('planEgress: models and speech', () => {
  it('does not count a model on this machine, as the real run does not', async () => {
    for (const host of ['127.0.0.1:11434', 'localhost:8080', '[::1]:9000']) {
      expect((await plan({}, { llm: { host, promptBytes: 5000 } })).egress, host).toEqual([]);
    }
    const remote = await plan({}, { llm: { host: 'api.anthropic.com', promptBytes: 5000 } });
    expect(remote.egress).toMatchObject([
      { destination: 'api.anthropic.com', purpose: 'storyboard generation', bytes: 5000 },
    ]);
    expect(remote.egress[0]?.contains).toEqual(['diff', 'code-context', 'pr-metadata']);
    const minimal = await plan(
      { privacy: { llmContext: 'minimal' } },
      { llm: { host: 'api.openai.com', promptBytes: 1 } },
    );
    expect(minimal.egress[0]?.contains).toEqual(['pr-metadata']);
  });

  it('lists what the speech provider says it would send, after the model and before the upload', async () => {
    const records: EgressRecord[] = [
      {
        destination: 'speech.example.test',
        purpose: 'speech synthesis',
        bytes: 1000,
        contains: ['narration-text'],
      },
    ];
    const tts = { plannedEgress: vi.fn(async () => records) };
    const { egress } = await plan(
      { publish: S3 },
      { tts, llm: { host: 'api.anthropic.com', promptBytes: 5000 } },
    );
    expect(tts.plannedEgress).toHaveBeenCalledWith(expect.objectContaining({ runId: 'plan' }), 1000);
    expect(egress.map((e) => e.purpose)).toEqual([
      'storyboard generation',
      'speech synthesis',
      'video upload',
    ]);
    expect(egress[1]).toEqual(records[0]);
    expect((await plan({})).egress).toEqual([]);
  });
});
