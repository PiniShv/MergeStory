/**
 * A small stand-in for the source detection, for the server tests. Kept apart from the other server
 * helpers so a test can load it inside `vi.mock` without loading the server. Not part of the public API.
 */
import { resolve } from 'node:path';
import { vi } from 'vitest';
import type { SourceInput } from '../core/providers.ts';

export function fakeSourcesModule(): Record<string, unknown> {
  return {
    detectSourceInput: (
      arg: string,
      options: { base?: string | null; head?: string | null; cwd?: string } = {},
    ): SourceInput => {
      if (/^https?:\/\/github\.com\//.test(arg) || /^[\w.-]+\/[\w.-]+#\d+$/.test(arg))
        return { kind: 'github', url: arg };
      return {
        kind: 'local',
        repoPath: resolve(options.cwd ?? process.cwd(), arg),
        base: options.base ?? null,
        head: options.head ?? null,
      };
    },
    createSourceProvider: vi.fn(),
  };
}
