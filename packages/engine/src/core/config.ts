/**
 * Configuration.
 *
 * Precedence (highest first): explicit options (CLI flags / API input) > environment variables
 * > config file (--config, MERGESTORY_CONFIG, or $MERGESTORY_HOME/config.json) > defaults.
 *
 * Secrets never live in the config file. They come from the environment only and are
 * registered with the redactor the moment they are read.
 *
 * Defaults are chosen to be free and private: no remote LLM, local speech, local publishing.
 * Anything that costs money or sends code off the machine has to be switched on explicitly.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MergeStoryError } from './errors.ts';
import { isRecord } from './json.ts';
import { mergestoryHome } from './paths.ts';
import { globalRedactor, type Redactor } from './redact.ts';

const PriceSchema = z.union([
  z.strictObject({
    kind: z.literal('llm'),
    inputPerMTok: z.number().min(0),
    outputPerMTok: z.number().min(0),
  }),
  z.strictObject({ kind: z.literal('tts'), perMChars: z.number().min(0) }),
]);

/** Allowed range of the length settings, in seconds. The command line flags use the same numbers. */
export const DURATION_LIMITS = {
  maxDurationSec: { min: 20, max: 600, default: 150 },
  targetDurationSec: { min: 20, max: 600 },
} as const;

/** The closed value sets of the settings. The command line flags and the HTTP API use the same lists. */
export const STYLES = ['technical', 'product', 'hybrid'] as const;
export const QUALITIES = ['draft', 'standard', 'high'] as const;
export const THEMES = ['dark', 'light'] as const;
export const LLM_PROVIDERS = ['none', 'anthropic', 'openai', 'openai-compatible'] as const;
export const TTS_PROVIDERS = ['auto', 'kokoro', 'say', 'openai', 'elevenlabs', 'none'] as const;
export const PUBLISH_PROVIDERS = ['local', 's3', 'youtube', 'none'] as const;
export const VISIBILITIES = ['private', 'protected', 'public'] as const;

/**
 * Every section is strict: a key that is not listed here is an error, never silently ignored. A
 * misspelt privacy setting would otherwise leave the permissive default in place without a word.
 */
export const ConfigSchema = z.strictObject({
  style: z.enum(STYLES).default('hybrid'),
  language: z.string().min(2).max(16).default('en'),
  theme: z.enum(THEMES).default('dark'),
  quality: z.enum(QUALITIES).default('standard'),
  /**
   * Longest video, in seconds. Before narration the storyboard is trimmed until its estimated length
   * fits (the mission and review scenes are never dropped); the real voice may run a little over.
   * The engine picks a shorter length for small changes.
   */
  maxDurationSec: z
    .number()
    .int()
    .min(DURATION_LIMITS.maxDurationSec.min)
    .max(DURATION_LIMITS.maxDurationSec.max)
    .default(DURATION_LIMITS.maxDurationSec.default),
  /** Fixed target length; null lets the engine adapt to the size of the change. */
  targetDurationSec: z
    .number()
    .int()
    .min(DURATION_LIMITS.targetDurationSec.min)
    .max(DURATION_LIMITS.targetDurationSec.max)
    .nullable()
    .default(null),
  captions: z.boolean().default(true),
  /** USD cap per run. The run stops before any call that would exceed it. */
  budgetUsd: z.number().min(0).max(100).default(0.25),
  llm: z
    .strictObject({
      /** "none" = no remote model (heuristic storyboard, or one supplied with --storyboard). */
      provider: z.enum(LLM_PROVIDERS).default('none'),
      /** null = the provider's cheap default model. */
      model: z.string().nullable().default(null),
      /** Base URL for openai-compatible servers (Ollama, OpenRouter, vLLM, ...). */
      baseUrl: z.string().url().nullable().default(null),
      effort: z.enum(['low', 'medium', 'high']).default('medium'),
      /** Upper bound for the evidence pack sent to the model. Smaller is cheaper. */
      maxInputTokens: z.number().int().min(2000).max(200_000).default(24_000),
      maxOutputTokens: z.number().int().min(1000).max(64_000).default(12_000),
      /** Extra attempts that send validation errors back to the model. */
      repairAttempts: z.number().int().min(0).max(3).default(1),
      timeoutMs: z.number().int().min(5_000).max(900_000).default(240_000),
    })
    .prefault({}),
  tts: z
    .strictObject({
      /** "auto" only ever picks a free local provider: kokoro, then macOS say, then none. */
      provider: z.enum(TTS_PROVIDERS).default('auto'),
      voice: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
      speed: z.number().min(0.5).max(2).default(1),
    })
    .prefault({}),
  publish: z
    .strictObject({
      provider: z.enum(PUBLISH_PROVIDERS).default('local'),
      /**
       * S3 links. private = presigned links that expire (at most 7 days).
       * protected = permanent links through publicBaseUrl, which must sit behind an access proxy
       * (for example Cloudflare Access); checked before upload when s3.verifyProtection is on.
       * public = permanent links through publicBaseUrl that anyone with the link can open.
       */
      visibility: z.enum(VISIBILITIES).default('private'),
      linkExpirySec: z.number().int().min(60).max(604_800).default(604_800),
      /** Public links for videos of private repositories need this explicit opt-in. */
      allowPublicForPrivateRepos: z.boolean().default(false),
      localDir: z.string().nullable().default(null),
      s3: z
        .strictObject({
          bucket: z.string().nullable().default(null),
          region: z.string().default('auto'),
          endpoint: z.string().url().nullable().default(null),
          prefix: z.string().default('mergestory'),
          publicBaseUrl: z.string().url().nullable().default(null),
          forcePathStyle: z.boolean().default(false),
          /** For visibility "protected": probe publicBaseUrl anonymously and refuse to upload if it answers. */
          verifyProtection: z.boolean().default(true),
        })
        .prefault({}),
      youtube: z
        .strictObject({
          /** Always sent explicitly: YouTube makes uploads public when it is left out. */
          privacyStatus: z.enum(['private', 'unlisted', 'public']).default('unlisted'),
          /** YouTube category id; 28 is Science & Technology. */
          categoryId: z
            .string()
            .regex(/^\d{1,3}$/)
            .default('28'),
          playlistId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{10,64}$/)
            .nullable()
            .default(null),
          /** Burned-in captions are always in the video; this also uploads a caption track. */
          uploadCaptions: z.boolean().default(false),
          /** Custom thumbnails need a verified channel; failures are reported as warnings. */
          setThumbnail: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  github: z
    .strictObject({
      comment: z.boolean().default(false),
      updateDescription: z.boolean().default(false),
      apiUrl: z.string().url().default('https://api.github.com'),
      /** Allow reading a token from the gh CLI when GITHUB_TOKEN/GH_TOKEN are not set. */
      useGhCli: z.boolean().default(true),
    })
    .prefault({}),
  privacy: z
    .strictObject({
      maskEmails: z.boolean().default(true),
      /** Glob-like path patterns that are never shown or sent anywhere (in addition to built-in sensitive files). */
      excludePaths: z.array(z.string()).default([]),
      /** "full" sends key hunks to the LLM; "minimal" sends only metadata, paths and symbol names. */
      llmContext: z.enum(['full', 'minimal']).default('full'),
    })
    .prefault({}),
  render: z
    .strictObject({
      /** Parallel browser pages; null = based on CPU count. */
      concurrency: z.number().int().min(1).max(16).nullable().default(null),
      browserPath: z.string().nullable().default(null),
      ffmpegPath: z.string().nullable().default(null),
      ffprobePath: z.string().nullable().default(null),
      /** Skip capturing frames that are identical to the previous one. */
      reuseStaticFrames: z.boolean().default(true),
      /** Optional background music file (mixed quietly under the narration). */
      musicPath: z.string().nullable().default(null),
      /** Bring the narration to a standard loudness (-16 LUFS, true peak -1.5 dBTP). */
      normalizeLoudness: z.boolean().default(true),
    })
    .prefault({}),
  cache: z
    .strictObject({
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  /** Price overrides keyed "<provider>:<model>" or "<provider>:*". */
  pricing: z.record(z.string(), PriceSchema).default({}),
  home: z.string().nullable().default(null),
  outDir: z.string().nullable().default(null),
});

export type Config = z.infer<typeof ConfigSchema>;
/** Deeply partial input accepted from flags, files and API callers. */
export type ConfigInput = DeepPartial<z.input<typeof ConfigSchema>>;

type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | undefined }
    : T;

/**
 * Name of the per-user config file inside $MERGESTORY_HOME. MergeStory never reads a config file
 * from the working directory on its own: that folder is often the repository being explained, and a
 * config there could point MergeStory at other programs, endpoints or API hosts.
 */
export const USER_CONFIG_FILE = 'config.json';

/** Environment variables that hold secrets. Read only by loadSecrets(). */
export const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MERGESTORY_LLM_API_KEY',
  'ELEVENLABS_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'MERGESTORY_S3_ACCESS_KEY_ID',
  'MERGESTORY_S3_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'MERGESTORY_API_TOKEN',
  'MERGESTORY_YOUTUBE_CLIENT_ID',
  'MERGESTORY_YOUTUBE_CLIENT_SECRET',
  'MERGESTORY_YOUTUBE_REFRESH_TOKEN',
] as const;

export type SecretName = (typeof SECRET_ENV_VARS)[number];

export class Secrets {
  private readonly values = new Map<SecretName, string>();

  constructor(entries: Partial<Record<SecretName, string>> = {}, redactor: Redactor = globalRedactor) {
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value === 'string' && value.trim()) {
        this.values.set(name as SecretName, value.trim());
        redactor.add(value);
      }
    }
  }

  get(name: SecretName): string | null {
    return this.values.get(name) ?? null;
  }

  has(name: SecretName): boolean {
    return this.values.has(name);
  }

  /** Names only, for diagnostics (`mergestory doctor`). Never the values. */
  present(): SecretName[] {
    return [...this.values.keys()];
  }
}

export function loadSecrets(
  env: NodeJS.ProcessEnv = process.env,
  redactor: Redactor = globalRedactor,
): Secrets {
  const entries: Partial<Record<SecretName, string>> = {};
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    if (value) entries[name] = value;
  }
  return new Secrets(entries, redactor);
}

function parseBool(name: string, value: string): boolean {
  const word = value.trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(word)) return true;
  if (/^(0|false|no|off)$/.test(word)) return false;
  throw new MergeStoryError('CONFIG_INVALID', `${name} must be true or false, not "${value.trim()}".`, {
    hint: 'Use one of: 1, true, yes, on, 0, false, no, off.',
  });
}

/** Map MERGESTORY_* environment variables onto config input. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigInput {
  const out: ConfigInput = {};
  const set = (value: string | undefined, apply: (v: string) => void) => {
    if (value !== undefined && value.trim() !== '') apply(value.trim());
  };
  set(env.MERGESTORY_STYLE, (v) => (out.style = v as Config['style']));
  set(env.MERGESTORY_LANGUAGE, (v) => (out.language = v));
  set(env.MERGESTORY_THEME, (v) => (out.theme = v as Config['theme']));
  set(env.MERGESTORY_QUALITY, (v) => (out.quality = v as Config['quality']));
  set(env.MERGESTORY_MAX_DURATION, (v) => (out.maxDurationSec = Number(v)));
  set(env.MERGESTORY_BUDGET_USD, (v) => (out.budgetUsd = Number(v)));
  set(env.MERGESTORY_HOME, (v) => (out.home = v));
  const llm: NonNullable<ConfigInput['llm']> = {};
  set(env.MERGESTORY_LLM_PROVIDER, (v) => (llm.provider = v as Config['llm']['provider']));
  set(env.MERGESTORY_LLM_MODEL, (v) => (llm.model = v));
  set(env.MERGESTORY_LLM_BASE_URL, (v) => (llm.baseUrl = v));
  set(env.MERGESTORY_LLM_EFFORT, (v) => (llm.effort = v as Config['llm']['effort']));
  if (Object.keys(llm).length) out.llm = llm;
  const tts: NonNullable<ConfigInput['tts']> = {};
  set(env.MERGESTORY_TTS_PROVIDER, (v) => (tts.provider = v as Config['tts']['provider']));
  set(env.MERGESTORY_TTS_VOICE, (v) => (tts.voice = v));
  set(env.MERGESTORY_TTS_MODEL, (v) => (tts.model = v));
  if (Object.keys(tts).length) out.tts = tts;
  const s3: NonNullable<NonNullable<ConfigInput['publish']>['s3']> = {};
  set(env.MERGESTORY_S3_BUCKET, (v) => (s3.bucket = v));
  set(env.MERGESTORY_S3_REGION, (v) => (s3.region = v));
  set(env.MERGESTORY_S3_ENDPOINT, (v) => (s3.endpoint = v));
  set(env.MERGESTORY_S3_PREFIX, (v) => (s3.prefix = v));
  set(env.MERGESTORY_S3_PUBLIC_BASE_URL, (v) => (s3.publicBaseUrl = v));
  set(
    env.MERGESTORY_S3_FORCE_PATH_STYLE,
    (v) => (s3.forcePathStyle = parseBool('MERGESTORY_S3_FORCE_PATH_STYLE', v)),
  );
  const publish: NonNullable<ConfigInput['publish']> = {};
  set(env.MERGESTORY_PUBLISH_PROVIDER, (v) => (publish.provider = v as Config['publish']['provider']));
  set(env.MERGESTORY_VISIBILITY, (v) => (publish.visibility = v as Config['publish']['visibility']));
  set(env.MERGESTORY_LINK_EXPIRY_SEC, (v) => (publish.linkExpirySec = Number(v)));
  set(
    env.MERGESTORY_S3_VERIFY_PROTECTION,
    (v) => (s3.verifyProtection = parseBool('MERGESTORY_S3_VERIFY_PROTECTION', v)),
  );
  if (Object.keys(s3).length) publish.s3 = s3;
  const youtube: NonNullable<NonNullable<ConfigInput['publish']>['youtube']> = {};
  set(
    env.MERGESTORY_YOUTUBE_PRIVACY,
    (v) => (youtube.privacyStatus = v as Config['publish']['youtube']['privacyStatus']),
  );
  set(env.MERGESTORY_YOUTUBE_PLAYLIST_ID, (v) => (youtube.playlistId = v));
  if (Object.keys(youtube).length) publish.youtube = youtube;
  if (Object.keys(publish).length) out.publish = publish;
  const github: NonNullable<ConfigInput['github']> = {};
  set(env.GITHUB_API_URL, (v) => (github.apiUrl = v));
  if (Object.keys(github).length) out.github = github;
  const render: NonNullable<ConfigInput['render']> = {};
  set(env.MERGESTORY_BROWSER_PATH, (v) => (render.browserPath = v));
  set(env.MERGESTORY_FFMPEG_PATH, (v) => (render.ffmpegPath = v));
  set(env.MERGESTORY_FFPROBE_PATH, (v) => (render.ffprobePath = v));
  if (Object.keys(render).length) out.render = render;
  return out;
}

/** Deep merge where later sources win; undefined values are ignored. */
export function mergeConfigInputs(...inputs: (ConfigInput | undefined)[]): ConfigInput {
  const out: Record<string, unknown> = {};
  for (const input of inputs) {
    if (!input) continue;
    mergeInto(out, input as Record<string, unknown>);
  }
  return out as ConfigInput;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    // A "__proto__" key from a JSON file would reach Object.prototype through target[key], and
    // nothing inherited counts as a value that was merged before.
    if (value === undefined || key === '__proto__') continue;
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isRecord(value) && isRecord(existing)) {
      mergeInto(existing, value);
    } else if (isRecord(value)) {
      const copy: Record<string, unknown> = {};
      mergeInto(copy, value);
      target[key] = copy;
    } else {
      target[key] = value;
    }
  }
}

const SECRET_LIKE_KEY = /(api[_-]?key|token|secret|password|credential)/i;

function assertNoSecrets(value: unknown, path: string[] = []): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_LIKE_KEY.test(key) && key !== 'maxInputTokens' && key !== 'maxOutputTokens') {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        `Config key "${[...path, key].join('.')}" looks like a secret.`,
        {
          hint: 'Secrets belong in environment variables (for example ANTHROPIC_API_KEY), never in config files.',
        },
      );
    }
    assertNoSecrets(child, [...path, key]);
  }
}

/**
 * Read the config file: the explicit path (--config or MERGESTORY_CONFIG), else
 * $MERGESTORY_HOME/config.json when it exists. The working directory is never searched.
 */
export function readConfigFile(
  explicitPath?: string | null,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ConfigInput {
  const chosen = explicitPath || env.MERGESTORY_CONFIG?.trim() || null;
  const candidates = chosen
    ? [resolve(cwd, chosen)]
    : [join(mergestoryHome(env.MERGESTORY_HOME), USER_CONFIG_FILE)];
  for (const file of candidates) {
    if (!existsSync(file)) {
      if (chosen) throw new MergeStoryError('CONFIG_INVALID', `Config file not found: ${chosen}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new MergeStoryError('CONFIG_INVALID', `Config file is not valid JSON: ${file}`, { cause: err });
    }
    if (!isRecord(parsed))
      throw new MergeStoryError('CONFIG_INVALID', `Config file must hold a JSON object.`);
    const { $schema: _ignored, ...rest } = parsed;
    assertNoSecrets(rest);
    return rest as ConfigInput;
  }
  return {};
}

export interface ResolveConfigOptions {
  /** Highest precedence (CLI flags, API input). */
  overrides?: ConfigInput;
  configPath?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Skip reading files (library callers that pass everything explicitly). */
  skipFile?: boolean;
}

/** The keys that exist in the section at `path`, taken from the defaults (every section has all its keys there). */
function knownKeysAt(path: readonly PropertyKey[]): string[] {
  let node: unknown = ConfigSchema.parse({});
  for (const part of path) {
    if (!isRecord(node)) return [];
    node = node[String(part)];
  }
  return isRecord(node) ? Object.keys(node) : [];
}

/** Number of edits (insert, delete, change, or swap two neighbours) that turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      (d[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
}

/** The known key that looks most like a misspelt one, or null when nothing is close. */
function closestKey(key: string, known: readonly string[]): string | null {
  const wanted = key.toLowerCase();
  let best: { key: string; distance: number } | null = null;
  for (const candidate of known) {
    const distance = editDistance(wanted, candidate.toLowerCase());
    if (!best || distance < best.distance) best = { key: candidate, distance };
  }
  return best && best.distance <= Math.max(1, Math.floor(key.length / 3)) ? best.key : null;
}

/** One line per problem. An unknown key is named with its full path and, when there is one, the likely intended key. */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    const where = issue.path.join('.');
    if (issue.code !== 'unrecognized_keys') return [`${where || '(root)'}: ${issue.message}`];
    const known = knownKeysAt(issue.path);
    return issue.keys.map((key) => {
      const guess = closestKey(key, known);
      return `${[where, key].filter(Boolean).join('.')}: Unrecognized key "${key}"${guess ? ` (did you mean "${guess}"?)` : ''}`;
    });
  });
}

export function resolveConfig(options: ResolveConfigOptions = {}): Config {
  const fileInput = options.skipFile ? {} : readConfigFile(options.configPath, options.cwd, options.env);
  const merged = mergeConfigInputs(fileInput, configFromEnv(options.env), options.overrides);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = describeIssues(result.error.issues).slice(0, 6).join('; ');
    throw new MergeStoryError('CONFIG_INVALID', `Invalid configuration: ${issues}`, {
      hint: 'Check flags, MERGESTORY_* environment variables and the config file (--config or ~/.mergestory/config.json).',
    });
  }
  return result.data;
}

/** Quality presets: output size, frame rate and encoder settings. */
export const QUALITY_PRESETS = {
  draft: { width: 1280, height: 720, fps: 24, jpegQuality: 80, crf: 28, x264Preset: 'veryfast' },
  standard: { width: 1920, height: 1080, fps: 30, jpegQuality: 90, crf: 23, x264Preset: 'medium' },
  high: { width: 1920, height: 1080, fps: 60, jpegQuality: 94, crf: 20, x264Preset: 'slow' },
} as const;

export type QualitySettings = (typeof QUALITY_PRESETS)[keyof typeof QUALITY_PRESETS];
