/**
 * Helpers for the narration tests: a temporary run context, an in-memory cache, a fake
 * speech provider and small storyboard and timeline builders. Not part of the public API.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cache, CacheNamespace } from '../core/cache.ts';
import type { RunContext } from '../core/context.ts';
import type { MergeStoryError } from '../core/errors.ts';
import type { TtsProvider, TtsRequest, TtsResult } from '../core/providers.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { EgressRecord, ProgressEvent, Timeline } from '../core/types.ts';
import { encodeWavPcm16, int16ToPcmS16le } from '../narration/wav.ts';
import { type TestContextOptions, testContext } from './context.ts';

export class MemoryCache implements Cache {
  readonly store = new Map<string, Buffer>();
  gets = 0;
  puts = 0;

  async get(ns: CacheNamespace, key: string): Promise<Buffer | null> {
    this.gets++;
    return this.store.get(`${ns}/${key}`) ?? null;
  }

  async put(ns: CacheNamespace, key: string, data: Buffer | string): Promise<void> {
    this.puts++;
    this.store.set(`${ns}/${key}`, typeof data === 'string' ? Buffer.from(data) : data);
  }
}

export interface NarrationContextOptions extends Omit<TestContextOptions, 'home' | 'runDir'> {
  /** Defaults to a cache in memory, so tests can count reads and writes. */
  cache?: Cache;
}

export interface NarrationContext {
  ctx: RunContext;
  /** Temporary directory holding the home folder and the run folder. */
  dir: string;
  events: ProgressEvent[];
  cleanup(): Promise<void>;
}

/** A run context over a temporary folder. The home folder is `config.home` when the test sets one. */
export async function makeTestContext(options: NarrationContextOptions = {}): Promise<NarrationContext> {
  const dir = await mkdtemp(join(tmpdir(), 'mergestory-narration-'));
  const { ctx, events } = testContext({
    ...options,
    config: { ...options.config, home: options.config?.home ?? join(dir, 'home') },
    runDir: join(dir, 'run'),
    cache: options.cache ?? new MemoryCache(),
  });
  return { ctx, dir, events, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * What a finished Kokoro install leaves in the plugin folder, without npm: the two package
 * manifests and the completion marker. Nothing is downloaded.
 */
export async function writeFakeKokoroInstall(pluginDir: string, version = '1.2.1'): Promise<void> {
  const modules = join(pluginDir, 'node_modules');
  await mkdir(join(modules, 'kokoro-js'), { recursive: true });
  await mkdir(join(modules, '@huggingface', 'transformers'), { recursive: true });
  await writeFile(join(modules, 'kokoro-js', 'package.json'), JSON.stringify({ name: 'kokoro-js', version }));
  await writeFile(
    join(modules, '@huggingface', 'transformers', 'package.json'),
    JSON.stringify({ name: '@huggingface/transformers', version: '3.8.1' }),
  );
  await writeFile(join(pluginDir, 'mergestory-kokoro-installed.json'), JSON.stringify({ version }));
}

/** A storyboard whose scenes only matter for their ids and narration text. */
export function makeStoryboard(scenes: Record<string, string[]>): Storyboard {
  return {
    version: 1,
    title: 'Test change',
    summary: 'A test.',
    style: 'hybrid',
    language: 'en',
    scenes: Object.entries(scenes).map(([id, lines]) => ({
      id,
      role: 'mission' as const,
      title: 'Scene',
      narration: lines.map((text) => ({ text, evidence: [] })),
      visual: { type: 'bullets' as const, heading: null, items: [] },
      visualDescription: 'A scene.',
      transition: 'fade' as const,
      targetSeconds: null,
    })),
    reviewChecklist: [],
    uncertainties: [],
  };
}

/** A timeline with absolute beat times: each line gets `beatSec` seconds after a short lead-in. */
export function makeTimeline(storyboard: Storyboard, beatSec = 2, leadSec = 0.5): Timeline {
  let at = 0;
  const scenes = storyboard.scenes.map((scene) => {
    const startSec = at;
    const beats = scene.narration.map((_, index) => ({
      index,
      startSec: startSec + leadSec + index * beatSec,
      durationSec: beatSec,
    }));
    const durationSec = leadSec + scene.narration.length * beatSec + 0.5;
    at += durationSec;
    return { sceneId: scene.id, startSec, durationSec, transitionSec: 0, beats };
  });
  return { durationSec: at + 3, scenes, outro: { startSec: at, durationSec: 3 } };
}

export interface FakeTtsOptions {
  id?: string;
  local?: boolean;
  /** Seconds of tone per word. */
  secondsPerWord?: number;
  /** Amplitude of the tone (0..1). */
  amplitude?: number;
  /** USD per character. */
  pricePerChar?: number;
  /** Throw this error from synthesize. */
  failWith?: Error;
}

/** A speech provider that returns a tone with silence around it and records every request. */
export class FakeTts implements TtsProvider {
  readonly id: string;
  readonly local: boolean;
  readonly speaks = true;
  readonly calls: TtsRequest[] = [];
  private readonly options: FakeTtsOptions;

  constructor(options: FakeTtsOptions = {}) {
    this.options = options;
    this.id = options.id ?? 'fake';
    this.local = options.local ?? true;
  }

  model(ctx: RunContext): string {
    return ctx.config.tts.model ?? 'fake-model';
  }

  async voice(ctx: RunContext): Promise<string | null> {
    return ctx.config.tts.voice || 'fake-voice';
  }

  async unavailable(): Promise<MergeStoryError | null> {
    return null;
  }

  async synthesize(request: TtsRequest, _ctx: RunContext): Promise<TtsResult> {
    this.calls.push(request);
    if (this.options.failWith) throw this.options.failWith;
    const rate = 24_000;
    const words = request.text.split(/\s+/).filter(Boolean).length;
    const tone = Math.round(rate * Math.max(0.3, words * (this.options.secondsPerWord ?? 0.3)));
    const lead = Math.round(rate * 0.2);
    const tail = Math.round(rate * 0.3);
    const samples = new Int16Array(lead + tone + tail);
    const amplitude = (this.options.amplitude ?? 0.1) * 32767;
    for (let i = 0; i < tone; i++)
      samples[lead + i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / rate));
    return {
      audio: encodeWavPcm16(samples, rate),
      format: 'wav',
      sampleRate: rate,
      channels: 1,
      characters: request.text.length,
    };
  }

  estimateCostUsd(characters: number): number {
    return characters * (this.options.pricePerChar ?? 0);
  }

  async plannedEgress(_ctx: RunContext, characters: number): Promise<EgressRecord[]> {
    if (this.local) return [];
    return [
      {
        destination: 'speech.example.test',
        purpose: 'speech synthesis',
        bytes: characters,
        contains: ['narration-text'],
      },
    ];
  }
}

/** A tone as raw 16-bit little-endian PCM, the format the paid providers return. */
export function pcmTone(seconds = 1, rate = 24_000, amplitude = 0.2, frequency = 220): Buffer {
  const samples = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / rate));
  }
  return int16ToPcmS16le(samples);
}

export interface RecordedRequest {
  url: string;
  method: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: unknown;
}

export interface FetchMock {
  requests: RecordedRequest[];
  restore(): void;
}

/** Replace the global fetch. The responder gets each request and the attempt number (1-based). */
export function mockFetch(
  responder: (request: RecordedRequest, attempt: number) => Response | Promise<Response>,
): FetchMock {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
    };
    requests.push(request);
    return responder(request, requests.length);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
