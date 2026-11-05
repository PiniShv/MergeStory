/**
 * Small content-addressed file cache. Keys are hashes of the inputs (see ids.hashKey),
 * so a re-run with the same narration text, voice and provider costs nothing.
 *
 * The cache lives under $MERGESTORY_HOME/cache, outside any repository. It may contain
 * code excerpts and narration audio; `mergestory cache clear` removes it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomToken } from './ids.ts';

export type CacheNamespace = 'tts' | 'llm' | 'files';

export interface Cache {
  get(ns: CacheNamespace, key: string): Promise<Buffer | null>;
  put(ns: CacheNamespace, key: string, data: Buffer | string): Promise<void>;
}

export class FileCache implements Cache {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathFor(ns: CacheNamespace, key: string): string {
    if (!/^[a-f0-9]{16,128}$/.test(key)) throw new Error(`Invalid cache key: ${key.slice(0, 20)}`);
    return join(this.root, ns, key.slice(0, 2), key);
  }

  async get(ns: CacheNamespace, key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(ns, key));
    } catch {
      return null;
    }
  }

  async put(ns: CacheNamespace, key: string, data: Buffer | string): Promise<void> {
    const target = this.pathFor(ns, key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Write to a temp file and rename, so concurrent readers never see a partial entry.
    const tmp = `${target}.${randomToken(4)}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, target);
  }
}

/** Cache that never stores anything (used with --no-cache). */
export const noCache: Cache = {
  get: async () => null,
  put: async () => {},
};
