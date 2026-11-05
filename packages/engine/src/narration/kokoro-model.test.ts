import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MergeStoryError } from '../core/errors.ts';
import { type FetchMock, mockFetch } from '../testing/narration.ts';
import {
  type DownloadProgress,
  ensureModelFiles,
  isKokoroModelCached,
  KOKORO_MODEL_REVISION,
  kokoroDownloadMb,
  kokoroDtype,
  kokoroModelDir,
  kokoroModelFiles,
  type ModelFile,
} from './kokoro-model.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

let mock: FetchMock | null = null;
const dirs: string[] = [];
afterEach(async () => {
  mock?.restore();
  mock = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mergestory-model-'));
  dirs.push(dir);
  return dir;
}

function spec(path: string, content: string): ModelFile {
  return { path, bytes: Buffer.byteLength(content), sha256: sha(content) };
}

describe('kokoroDtype', () => {
  it('uses fp32 on Apple Silicon and q8 elsewhere', () => {
    expect(kokoroDtype({}, 'darwin', 'arm64')).toBe('fp32');
    expect(kokoroDtype({}, 'darwin', 'x64')).toBe('q8');
    expect(kokoroDtype({}, 'linux', 'x64')).toBe('q8');
    expect(kokoroDtype({}, 'linux', 'arm64')).toBe('q8');
  });

  it('can be set with MERGESTORY_KOKORO_DTYPE, and rejects other values', () => {
    expect(kokoroDtype({ MERGESTORY_KOKORO_DTYPE: 'q8' }, 'darwin', 'arm64')).toBe('q8');
    expect(kokoroDtype({ MERGESTORY_KOKORO_DTYPE: ' FP32 ' }, 'linux', 'x64')).toBe('fp32');
    try {
      kokoroDtype({ MERGESTORY_KOKORO_DTYPE: 'q4' }, 'linux', 'x64');
      expect.unreachable();
    } catch (error) {
      expect((error as MergeStoryError).code).toBe('CONFIG_INVALID');
      expect((error as MergeStoryError).hint).toContain('q8');
    }
  });
});

describe('model files', () => {
  it('pins the files by size and SHA-256', () => {
    const fp32 = kokoroModelFiles('fp32');
    const q8 = kokoroModelFiles('q8');
    expect(fp32.map((f) => f.path)).toEqual([
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model.onnx',
    ]);
    expect(q8.at(-1)).toEqual({
      path: 'onnx/model_quantized.onnx',
      bytes: 92_361_116,
      sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
    });
    expect(fp32.at(-1)).toEqual({
      path: 'onnx/model.onnx',
      bytes: 325_532_232,
      sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
    });
    for (const file of [...fp32, ...q8]) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(kokoroDownloadMb('fp32')).toBe(326);
    expect(kokoroDownloadMb('q8')).toBe(92);
  });

  it('lives under the models folder in the layout transformers.js reads', () => {
    expect(kokoroModelDir('/home/.mergestory/models')).toBe(
      '/home/.mergestory/models/onnx-community/Kokoro-82M-v1.0-ONNX',
    );
  });

  it('reports whether every file is present with the right size', async () => {
    const root = await tempRoot();
    expect(await isKokoroModelCached(root, 'q8')).toBe(false);
    for (const file of kokoroModelFiles('q8')) {
      const target = join(kokoroModelDir(root), file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.alloc(Math.min(file.bytes, 1000)));
    }
    // The small files have the wrong size here, and the model file is far too short.
    expect(await isKokoroModelCached(root, 'q8')).toBe(false);
  });
});

describe('ensureModelFiles', () => {
  const files = [spec('config.json', '{"a":1}'), spec('onnx/model.onnx', 'x'.repeat(5000))];
  const contents: Record<string, string> = { 'config.json': '{"a":1}', 'onnx/model.onnx': 'x'.repeat(5000) };
  const baseUrl = 'https://models.example.test/repo/resolve/abc';

  const serve = () =>
    mockFetch((request) => {
      const path = request.url.slice(baseUrl.length + 1);
      const body = contents[path];
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
    });

  it('downloads missing files, verifies them and reports progress', async () => {
    const root = await tempRoot();
    mock = serve();
    const progress: DownloadProgress[] = [];
    const started: string[] = [];
    await ensureModelFiles({
      modelsRoot: root,
      files,
      baseUrl,
      retry: { attempts: 1 },
      onProgress: (p) => progress.push(p),
      onDownloadStart: (f) => started.push(f.path),
    });
    expect(mock.requests.map((r) => r.url)).toEqual([`${baseUrl}/config.json`, `${baseUrl}/onnx/model.onnx`]);
    expect(started).toEqual(['config.json', 'onnx/model.onnx']);
    expect(await readFile(join(kokoroModelDir(root), 'onnx/model.onnx'), 'utf8')).toBe(
      contents['onnx/model.onnx'],
    );
    expect(progress.at(-1)).toMatchObject({ file: 'onnx/model.onnx', loaded: 5000, total: 5000 });
    expect(await readdir(join(kokoroModelDir(root), 'onnx'))).toEqual(['model.onnx']);
  });

  it('does not download files that are already there and correct', async () => {
    const root = await tempRoot();
    mock = serve();
    await ensureModelFiles({ modelsRoot: root, files, baseUrl, retry: { attempts: 1 } });
    mock.requests.length = 0;
    await ensureModelFiles({ modelsRoot: root, files, baseUrl, retry: { attempts: 1 } });
    expect(mock.requests).toHaveLength(0);
  });

  it('replaces a damaged file instead of using it', async () => {
    const root = await tempRoot();
    mock = serve();
    await ensureModelFiles({ modelsRoot: root, files, baseUrl, retry: { attempts: 1 } });
    const damaged = join(kokoroModelDir(root), 'onnx/model.onnx');
    await writeFile(damaged, 'y'.repeat(5000)); // same size, wrong content
    mock.requests.length = 0;
    await ensureModelFiles({ modelsRoot: root, files, baseUrl, retry: { attempts: 1 } });
    expect(mock.requests.map((r) => r.url)).toEqual([`${baseUrl}/onnx/model.onnx`]);
    expect(await readFile(damaged, 'utf8')).toBe(contents['onnx/model.onnx']);
  });

  it('never removes the file while it downloads it again, so another process never finds it missing', async () => {
    const root = await tempRoot();
    const target = join(kokoroModelDir(root), 'onnx/model.onnx');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'y'.repeat(5000)); // damaged
    const seen: (string | null)[] = [];
    mock = mockFetch(async (request) => {
      seen.push(await readFile(target, 'utf8').catch(() => null));
      const body = contents[request.url.slice(baseUrl.length + 1)] ?? '';
      return new Response(body, { status: 200 });
    });
    await ensureModelFiles({
      modelsRoot: root,
      files: [files[1] as ModelFile],
      baseUrl,
      retry: { attempts: 1 },
    });
    expect(seen).toEqual(['y'.repeat(5000)]);
    expect(await readFile(target, 'utf8')).toBe(contents['onnx/model.onnx']);
  });

  it('gives a correct file when two downloads of it run at once', async () => {
    const root = await tempRoot();
    mock = serve();
    const options = { modelsRoot: root, files, baseUrl, retry: { attempts: 1 } };
    await Promise.all([ensureModelFiles(options), ensureModelFiles(options)]);
    expect(await readFile(join(kokoroModelDir(root), 'onnx/model.onnx'), 'utf8')).toBe(
      contents['onnx/model.onnx'],
    );
    // No temporary files are left behind.
    expect(await readdir(join(kokoroModelDir(root), 'onnx'))).toEqual(['model.onnx']);
  });

  it('refuses a download that does not match its checksum and leaves nothing behind', async () => {
    const root = await tempRoot();
    mock = mockFetch(() => new Response('z'.repeat(5000), { status: 200 }));
    const error = (await ensureModelFiles({
      modelsRoot: root,
      files: [files[1] as ModelFile],
      baseUrl,
      retry: { attempts: 1 },
    }).catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('checksum');
    expect(error.message).toContain('not used');
    expect(await readdir(join(kokoroModelDir(root), 'onnx'))).toEqual([]);
  });

  it('refuses a download with the wrong size', async () => {
    const root = await tempRoot();
    mock = mockFetch(() => new Response('short', { status: 200 }));
    const error = (await ensureModelFiles({
      modelsRoot: root,
      files: [files[1] as ModelFile],
      baseUrl,
      retry: { attempts: 1 },
    }).catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(await readdir(join(kokoroModelDir(root), 'onnx'))).toEqual([]);
  });

  it('explains a failed download and says what the first run needs', async () => {
    const root = await tempRoot();
    mock = mockFetch(() => new Response('nope', { status: 403 }));
    const error = (await ensureModelFiles({
      modelsRoot: root,
      files: [files[0] as ModelFile],
      baseUrl,
      retry: { attempts: 1 },
    }).catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('could not be downloaded');
    expect(error.hint).toContain('huggingface.co');
  });

  it('downloads from the pinned revision by default, with no credentials', async () => {
    const root = await tempRoot();
    mock = mockFetch(() => new Response('{"a":1}', { status: 200 }));
    await ensureModelFiles({ modelsRoot: root, files: [files[0] as ModelFile], retry: { attempts: 1 } });
    expect(mock.requests[0]?.url).toBe(
      `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_MODEL_REVISION}/config.json`,
    );
    expect(KOKORO_MODEL_REVISION).toBe('1939ad2a8e416c0acfeecc08a694d14ef25f2231');
    expect(mock.requests[0]?.headers.authorization).toBeUndefined();
  });
});
