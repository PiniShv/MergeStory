/**
 * Request body of POST /v1/jobs. Every object is strict: unknown keys are errors, so a typo (or an
 * attempt to pass something the API does not accept, such as screenshot paths) is never ignored.
 * Value ranges are checked against the engine's own config schema in `parseCreateJob`.
 */
import { z } from 'zod';
import {
  type ConfigInput,
  ConfigSchema,
  LLM_PROVIDERS,
  PUBLISH_PROVIDERS,
  QUALITIES,
  STYLES,
  THEMES,
  TTS_PROVIDERS,
  VISIBILITIES,
} from '../core/config.ts';
import { refProblem, sourceProblem } from '../jobs/input-rules.ts';
import type { JobOptions } from '../jobs/model.ts';
import { MAX_TEXT, TestResultSchema } from '../pipeline/inputs.ts';
import type { ApiIssue } from './http.ts';

/** Largest request body the API reads. */
export const MAX_BODY_BYTES = 256 * 1024;

/** A git ref: no spaces or control characters, and never an option for git. */
const Ref = z.string().superRefine((value, ctx) => {
  const problem = refProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const Source = z.string().superRefine((value, ctx) => {
  const problem = sourceProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** The pipeline's test result, with the API's own length limits. */
const TestResult = TestResultSchema.extend({
  command: z.string().min(1).max(1000),
  summary: z.string().max(4000),
});

const Context = z
  .object({
    task: z.string().max(MAX_TEXT).optional(),
    notes: z.string().max(MAX_TEXT).optional(),
    tests: z.array(TestResult).max(100).optional(),
  })
  .strict();

/** The subset of the configuration an API caller may set. Everything else comes from the server's own config. */
const Options = z
  .object({
    style: z.enum(STYLES).optional(),
    quality: z.enum(QUALITIES).optional(),
    maxDurationSec: z.number().optional(),
    targetDurationSec: z.number().nullable().optional(),
    language: z.string().optional(),
    theme: z.enum(THEMES).optional(),
    budgetUsd: z.number().optional(),
    llm: z
      .object({
        provider: z.enum(LLM_PROVIDERS).optional(),
        model: z.string().min(1).max(200).nullable().optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        provider: z.enum(TTS_PROVIDERS).optional(),
        voice: z.string().min(1).max(100).nullable().optional(),
      })
      .strict()
      .optional(),
    publish: z
      .object({
        // Narrower than the engine on purpose: an API caller cannot ask for YouTube, whose
        // credentials are the operator's, or for "protected" links, which need the operator's proxy.
        provider: z.enum(PUBLISH_PROVIDERS).exclude(['youtube']).optional(),
        visibility: z.enum(VISIBILITIES).exclude(['protected']).optional(),
      })
      .strict()
      .optional(),
    github: z
      .object({
        comment: z.boolean().optional(),
        updateDescription: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Body of POST /v1/jobs. */
export const CreateJobSchema = z
  .object({
    source: Source,
    base: Ref.nullish(),
    head: Ref.nullish(),
    context: Context.optional(),
    storyboard: z.record(z.string(), z.unknown()).optional(),
    options: Options.optional(),
  })
  .strict();

/** Result of checking a request: the value, or the problems. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: ApiIssue[] };

function issuesOf(error: z.ZodError, prefix = ''): ApiIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.') || '(body)',
    message: issue.message,
    code: issue.code,
  }));
}

/** The job a request asks for. Its `source` is still the text of the request: `resolveApiSource` decides what it refers to. */
export type CreateJobRequest = JobOptions & { source: string };

/**
 * Check a request body and turn it into job options. The ranges (for example the shortest allowed
 * video) come from the engine's config schema, so they are defined in one place only.
 */
export function parseCreateJob(body: unknown): Parsed<CreateJobRequest> {
  const result = CreateJobSchema.safeParse(body);
  if (!result.success) return { ok: false, issues: issuesOf(result.error) };
  const request = result.data;
  const config: ConfigInput = structuredClone(request.options ?? {});
  const check = ConfigSchema.safeParse(config);
  if (!check.success) return { ok: false, issues: issuesOf(check.error, 'options') };

  const job: CreateJobRequest = { source: request.source };
  if (request.base) job.base = request.base;
  if (request.head) job.head = request.head;
  if (request.context) job.context = request.context;
  if (request.storyboard) job.storyboard = request.storyboard;
  if (Object.keys(config).length > 0) job.config = config;
  return { ok: true, value: job };
}
