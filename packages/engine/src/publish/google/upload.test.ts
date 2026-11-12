import { randomBytes } from 'node:crypto';
import { truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor } from '../../core/redact.ts';
import {
  FAKE_VIDEO_ID,
  FAST_TIMING,
  type FakeGoogle,
  googleError,
  makeTempDir,
  type RecordedRequest,
  removeDir,
  startFakeGoogle,
} from '../../testing/youtube.ts';
import { GoogleApiError, type TokenProvider } from './google-api.ts';
import {
  CHUNK_UNIT,
  checkedSessionUrl,
  confirmedBytes,
  type ResumableUpload,
  uploadResumable,
} from './upload.ts';

const KIB = 1024;
const SIZE = 700 * KIB; // 716,800 bytes: two chunks of 256 KiB and one of 188 KiB
const isPut = (r: RecordedRequest) => r.method === 'PUT';
const putsFrom = (offset: number) => (r: RecordedRequest) =>
  isPut(r) && String(r.headers['content-range']).startsWith(`bytes ${offset}-`);
const isQuery = (r: RecordedRequest) => isPut(r) && /^bytes \*\//.test(String(r.headers['content-range']));

let dir: string;
let fake: FakeGoogle;
let data: Buffer;
let path: string;

beforeEach(async () => {
  dir = await makeTempDir('mergestory-upload-');
  fake = await startFakeGoogle();
  data = randomBytes(SIZE);
  path = join(dir, 'video.mp4');
  await writeFile(path, data);
});

afterEach(async () => {
  await fake.stop();
  await removeDir(dir);
});

class Tokens implements TokenProvider {
  invalidated = 0;
  async get(): Promise<string> {
    return fake.accessToken(this.invalidated + 1);
  }
  invalidate(): void {
    this.invalidated += 1;
  }
}

function job(overrides: Partial<ResumableUpload> = {}): ResumableUpload {
  return {
    label: 'YouTube',
    startUrl: `${fake.url}/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus`,
    metadata: { snippet: { title: 'A title' }, status: { privacyStatus: 'private' } },
    filePath: path,
    sizeBytes: SIZE,
    contentType: 'video/mp4',
    chunkBytes: CHUNK_UNIT,
    tokens: new Tokens(),
    signal: new AbortController().signal,
    timing: FAST_TIMING,
    redactor: new Redactor(),
    ...overrides,
  };
}

const puts = () => fake.requests.filter(isPut);
const ranges = () => puts().map((r) => String(r.headers['content-range']));

describe('uploadResumable', () => {
  it('starts a session with the metadata and the size and type of the file', async () => {
    await uploadResumable(job());
    const [start] = fake.requests;
    expect(start?.method).toBe('POST');
    expect(start?.path).toBe('/upload/youtube/v3/videos');
    expect(start?.query.get('uploadType')).toBe('resumable');
    expect(start?.query.get('part')).toBe('snippet,status');
    expect(start?.headers['content-type']).toBe('application/json; charset=UTF-8');
    expect(start?.headers['x-upload-content-length']).toBe(String(SIZE));
    expect(start?.headers['x-upload-content-type']).toBe('video/mp4');
    expect(start?.headers.authorization).toBe(`Bearer ${fake.accessToken(1)}`);
    expect(JSON.parse(start?.body.toString('utf8') ?? '')).toEqual({
      snippet: { title: 'A title' },
      status: { privacyStatus: 'private' },
    });
  });

  it('sends the file in chunks of 256 KiB and returns the new resource', async () => {
    const progress: number[] = [];
    let sent = 0;
    const outcome = await uploadResumable(
      job({ onProgress: (confirmed) => progress.push(confirmed), onBytesSent: (bytes) => (sent += bytes) }),
    );
    expect(outcome.status).toBe(201);
    expect((outcome.json as { id: string }).id).toBe(FAKE_VIDEO_ID);
    expect(ranges()).toEqual([
      `bytes 0-${256 * KIB - 1}/${SIZE}`,
      `bytes ${256 * KIB}-${512 * KIB - 1}/${SIZE}`,
      `bytes ${512 * KIB}-${SIZE - 1}/${SIZE}`,
    ]);
    expect(fake.uploaded('video').equals(data)).toBe(true);
    expect(progress).toEqual([256 * KIB, 512 * KIB]);
    expect(sent).toBe(SIZE);
    for (const request of puts()) {
      expect(request.headers['content-type']).toBe('video/mp4');
      expect(request.headers.authorization).toBe(`Bearer ${fake.accessToken(1)}`);
    }
  });

  it('uses one request for a file that fits in a chunk', async () => {
    const outcome = await uploadResumable(job({ chunkBytes: 4 * CHUNK_UNIT }));
    expect(outcome.status).toBe(201);
    expect(ranges()).toEqual([`bytes 0-${SIZE - 1}/${SIZE}`]);
  });

  it('keeps the token and the session address out of every address it calls', async () => {
    await uploadResumable(job());
    for (const request of fake.requests) {
      expect([...request.query.values()].join(' ')).not.toContain('ya29');
    }
  });

  it('registers the session id with the redactor', async () => {
    const redactor = new Redactor();
    await uploadResumable(job({ redactor }));
    const id = [...fake.sessions.keys()][0] ?? '';
    expect(redactor.redact(`x ${id} y`)).toBe('x [redacted] y');
  });

  describe('after an interruption', () => {
    it('asks where the upload stands and resumes with the next byte', async () => {
      // The second chunk is cut off after 100,000 bytes, so the server keeps only part of it.
      fake.intercept(putsFrom(256 * KIB), { kind: 'store-then-drop', storeBytes: 100_000 });
      const retries: string[] = [];
      let sent = 0;
      const outcome = await uploadResumable(
        job({ onRetry: ({ reason }) => retries.push(reason), onBytesSent: (bytes) => (sent += bytes) }),
      );
      expect(outcome.status).toBe(201);
      const resumeAt = 256 * KIB + 100_000;
      expect(ranges()).toEqual([
        `bytes 0-${256 * KIB - 1}/${SIZE}`,
        `bytes ${256 * KIB}-${512 * KIB - 1}/${SIZE}`,
        `bytes */${SIZE}`,
        `bytes ${resumeAt}-${resumeAt + 256 * KIB - 1}/${SIZE}`,
        `bytes ${resumeAt + 256 * KIB}-${SIZE - 1}/${SIZE}`,
      ]);
      expect(fake.uploaded('video').equals(data)).toBe(true);
      expect(retries).toHaveLength(1);
      expect(sent).toBeGreaterThan(SIZE);
      const query = puts()[2];
      expect(query?.body.length).toBe(0);
      expect(query?.headers['content-length']).toBe('0');
    });

    it('carries on after a temporary server error', async () => {
      fake.intercept(putsFrom(256 * KIB), googleError(503, 'backendError'));
      const outcome = await uploadResumable(job());
      expect(outcome.status).toBe(201);
      expect(ranges()).toEqual([
        `bytes 0-${256 * KIB - 1}/${SIZE}`,
        `bytes ${256 * KIB}-${512 * KIB - 1}/${SIZE}`,
        `bytes */${SIZE}`,
        `bytes ${256 * KIB}-${512 * KIB - 1}/${SIZE}`,
        `bytes ${512 * KIB}-${SIZE - 1}/${SIZE}`,
      ]);
      expect(fake.uploaded('video').equals(data)).toBe(true);
    });

    it('starts from the beginning when nothing arrived yet', async () => {
      fake.intercept(putsFrom(0), { kind: 'drop' });
      await uploadResumable(job());
      expect(ranges().slice(0, 3)).toEqual([
        `bytes 0-${256 * KIB - 1}/${SIZE}`,
        `bytes */${SIZE}`,
        `bytes 0-${256 * KIB - 1}/${SIZE}`,
      ]);
      expect(fake.uploaded('video').equals(data)).toBe(true);
    });

    it('takes the finished resource from the status query when the final answer was lost', async () => {
      fake.intercept(putsFrom(512 * KIB), { kind: 'store-all-then-drop' });
      const outcome = await uploadResumable(job());
      expect(outcome.status).toBe(200);
      expect((outcome.json as { id: string }).id).toBe(FAKE_VIDEO_ID);
      expect(ranges().slice(-2)).toEqual([`bytes ${512 * KIB}-${SIZE - 1}/${SIZE}`, `bytes */${SIZE}`]);
      expect(fake.uploaded('video').equals(data)).toBe(true);
    });

    it('retries a status query that fails too', async () => {
      fake.intercept(putsFrom(256 * KIB), { kind: 'drop' });
      fake.intercept(isQuery, googleError(502, 'backendError'));
      const outcome = await uploadResumable(job());
      expect(outcome.status).toBe(201);
      expect(ranges().filter((r) => r.startsWith('bytes */'))).toHaveLength(2);
      expect(fake.uploaded('video').equals(data)).toBe(true);
    });

    it('gives up after the maximum number of retries', async () => {
      fake.intercept(isPut, googleError(503, 'backendError'), 100);
      const error = await uploadResumable(job()).catch((err) => err);
      expect(error).toBeInstanceOf(GoogleApiError);
      expect(error.status).toBe(503);
      expect(puts()).toHaveLength(FAST_TIMING.maxRetries + 1);
    });

    it('honours Retry-After', async () => {
      fake.intercept(putsFrom(0), {
        kind: 'json',
        status: 503,
        body: { error: { code: 503, message: 'busy', errors: [{ reason: 'backendError' }] } },
        headers: { 'Retry-After': '0' },
      });
      expect((await uploadResumable(job())).status).toBe(201);
    });
  });

  describe('failures that do not pass', () => {
    it('stops at a refusal when starting, without retrying', async () => {
      fake.intercept((r) => r.method === 'POST', googleError(403, 'quotaExceeded'), 5);
      const error = await uploadResumable(job()).catch((err) => err);
      expect(error).toBeInstanceOf(GoogleApiError);
      expect(error.reasons).toEqual(['quotaExceeded']);
      expect(fake.requests).toHaveLength(1);
    });

    it('stops at a rejected chunk', async () => {
      fake.intercept(putsFrom(256 * KIB), googleError(400, 'invalidVideoMetadata'), 5);
      const error = await uploadResumable(job()).catch((err) => err);
      expect(error).toBeInstanceOf(GoogleApiError);
      expect(error.status).toBe(400);
      expect(puts()).toHaveLength(2);
    });

    it('stops when the session is gone (404)', async () => {
      fake.intercept(
        isPut,
        { kind: 'json', status: 404, body: { error: { code: 404, message: 'Not Found' } } },
        5,
      );
      const error = await uploadResumable(job()).catch((err) => err);
      expect(error).toMatchObject({ status: 404 });
      expect(puts()).toHaveLength(1);
    });

    it('gets a new token once when a chunk is answered with 401', async () => {
      const tokens = new Tokens();
      fake.intercept(putsFrom(256 * KIB), googleError(401, 'authError'));
      const outcome = await uploadResumable(job({ tokens }));
      expect(outcome.status).toBe(201);
      expect(tokens.invalidated).toBe(1);
      const used = puts().map((r) => r.headers.authorization);
      expect(used).toEqual([
        `Bearer ${fake.accessToken(1)}`,
        `Bearer ${fake.accessToken(1)}`,
        `Bearer ${fake.accessToken(2)}`,
        `Bearer ${fake.accessToken(2)}`,
      ]);
      expect(fake.uploaded('video').equals(data)).toBe(true);
    });

    it('stops at a second 401 in a row', async () => {
      const tokens = new Tokens();
      fake.intercept(isPut, googleError(401, 'authError'), 10);
      await expect(uploadResumable(job({ tokens }))).rejects.toMatchObject({ status: 401 });
      expect(tokens.invalidated).toBe(1);
    });

    it('stops when YouTube keeps answering 308 without taking any data', async () => {
      fake.intercept(isPut, { kind: 'json', status: 308 }, 100);
      const error = await uploadResumable(job()).catch((err) => err);
      expect(error).toMatchObject({ code: 'PUBLISH_FAILED' });
      expect(error.message).toContain('not accepting');
      expect(puts()).toHaveLength(FAST_TIMING.maxRetries + 1);
    });

    it('stops when YouTube reports more bytes than were sent', async () => {
      fake.intercept(isPut, { kind: 'json', status: 308, headers: { Range: 'bytes=0-99999999' } });
      await expect(uploadResumable(job())).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    });

    it('stops at a progress report it cannot read', async () => {
      fake.intercept(isPut, { kind: 'json', status: 308, headers: { Range: 'items=5-7' } });
      await expect(uploadResumable(job())).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    });
  });

  describe('cancellation', () => {
    it('stops after the chunk in flight when the run is cancelled', async () => {
      const controller = new AbortController();
      const error = await uploadResumable(
        job({ signal: controller.signal, onProgress: () => controller.abort() }),
      ).catch((err) => err);
      expect(error).toMatchObject({ code: 'ABORTED' });
      expect(puts()).toHaveLength(1);
    });

    it('does not start when the run was cancelled before', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(uploadResumable(job({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'ABORTED',
      });
      expect(fake.requests).toHaveLength(0);
    });

    it('stops while waiting between retries', async () => {
      const controller = new AbortController();
      fake.intercept(isPut, googleError(503, 'backendError'), 100);
      const error = await uploadResumable(
        job({
          signal: controller.signal,
          timing: { ...FAST_TIMING, minDelayMs: 10_000, maxDelayMs: 10_000 },
          onRetry: () => setTimeout(() => controller.abort(), 10),
        }),
      ).catch((err) => err);
      expect(error).toMatchObject({ code: 'ABORTED' });
    });
  });

  describe('the session address', () => {
    it('is not followed to another host, and nothing is sent there', async () => {
      fake.intercept((r) => r.method === 'POST', {
        kind: 'json',
        status: 200,
        headers: { Location: 'https://evil.example/upload?upload_id=abc' },
      });
      const error = await uploadResumable(job()).catch((err) => err);
      expect(error).toMatchObject({ code: 'PUBLISH_FAILED' });
      expect(error.message).toContain('unexpected host');
      expect(puts()).toHaveLength(0);
    });

    it('must be present', async () => {
      fake.intercept((r) => r.method === 'POST', { kind: 'json', status: 200 });
      await expect(uploadResumable(job())).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    });

    it('accepts the origin of the start address and googleapis.com over HTTPS', () => {
      const start = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable';
      expect(
        checkedSessionUrl(
          'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=1',
          start,
          'YouTube',
        ),
      ).toContain('upload_id=1');
      expect(
        checkedSessionUrl(
          'https://youtube.googleapis.com/resumable/upload/youtube/v3/videos?upload_id=1',
          start,
          'YouTube',
        ),
      ).toContain('youtube.googleapis.com');
      expect(checkedSessionUrl('/upload/youtube/v3/videos?upload_id=2', start, 'YouTube')).toBe(
        'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=2',
      );
    });

    it('refuses other hosts, other schemes and look-alikes', () => {
      const start = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable';
      for (const location of [
        'https://evil.example/x',
        'http://www.googleapis.com/x',
        'https://googleapis.com.evil.example/x',
        'https://notgoogleapis.com/x',
        'ftp://www.googleapis.com/x',
      ]) {
        expect(() => checkedSessionUrl(location, start, 'YouTube')).toThrow();
      }
    });
  });

  describe('input checks', () => {
    it('refuses a chunk size that is not a multiple of 256 KiB', async () => {
      for (const chunkBytes of [0, 1000, CHUNK_UNIT + 1, -CHUNK_UNIT]) {
        await expect(uploadResumable(job({ chunkBytes }))).rejects.toMatchObject({ code: 'INTERNAL' });
      }
      expect(fake.requests).toHaveLength(0);
    });

    it('refuses an empty file', async () => {
      await writeFile(path, '');
      await expect(uploadResumable(job({ sizeBytes: 0 }))).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
      expect(fake.requests).toHaveLength(0);
    });

    it('stops when the file is not the size it was said to be', async () => {
      await truncate(path, SIZE - 1);
      const error = await uploadResumable(job()).catch((err) => err);
      expect(error).toMatchObject({ code: 'PUBLISH_FAILED' });
      expect(error.message).toContain('not the size');
      expect(fake.requests).toHaveLength(0);
    });
  });
});

describe('confirmedBytes', () => {
  it('reads Range as the number of bytes Google has', () => {
    expect(confirmedBytes('bytes=0-999999', 'YouTube')).toBe(1_000_000);
    expect(confirmedBytes('bytes=0-0', 'YouTube')).toBe(1);
  });

  it('treats a missing header as nothing received yet', () => {
    expect(confirmedBytes(null, 'YouTube')).toBe(0);
  });

  it('rejects anything else', () => {
    for (const value of ['bytes=5-10', 'bytes 0-10', 'garbage', 'bytes=0-']) {
      expect(() => confirmedBytes(value, 'YouTube')).toThrow();
    }
  });
});
