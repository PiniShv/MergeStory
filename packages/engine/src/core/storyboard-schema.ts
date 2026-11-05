/**
 * The storyboard contract.
 *
 * A storyboard can come from three places: the engine's LLM generator, an agent that writes
 * it itself (the Agent Skill path), or the offline heuristic generator. All three produce
 * this shape and all three go through the same grounding validator before anything is rendered.
 *
 * Wire-format rules (so one schema works with every structured-output provider):
 * - every field is required; "optional" fields are nullable instead
 * - no numeric, string-length or array-size constraints here (they are enforced by the validator)
 * - no recursion
 * Code is never embedded in a storyboard. Visuals point at code with CodeRefs and the engine
 * reads the real lines from the repository at render time.
 */
import { z } from 'zod';

export const STORYBOARD_VERSION = 1 as const;

const evidenceIds = z
  .array(z.string())
  .describe('Evidence ids from the evidence pack that support this item, for example ["F2.H1", "S3"].');

const beat = z
  .number()
  .int()
  .describe('0-based index of the narration line in this scene at which this element appears.');

export const CodeRefSchema = z
  .object({
    path: z.string().describe('Repo-relative path exactly as listed in the evidence pack.'),
    side: z.enum(['head', 'base']).describe('"head" for the new version, "base" for the old version.'),
    startLine: z.number().int().describe('First line (1-based, inclusive) at that side.'),
    endLine: z.number().int().describe('Last line (inclusive). Keep ranges short: at most 18 lines.'),
  })
  .describe('A line range in one file. The engine reads the real code; never paste code here.');

export const SceneRoleSchema = z.enum([
  'mission',
  'big-picture',
  'under-the-hood',
  'before-after',
  'review',
  'conclusion',
]);

export const NodeKindSchema = z.enum([
  'service',
  'module',
  'ui',
  'api',
  'database',
  'queue',
  'external',
  'file',
  'test',
  'config',
  'user',
  'cli',
]);

export const TransitionSchema = z.enum(['fade', 'slide', 'zoom', 'wipe', 'none']);
export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high']);

const textBeat = z.object({ text: z.string(), beat });

export const TitleVisualSchema = z.object({
  type: z.literal('title'),
  kicker: z.string().nullable().describe('Small label above the heading, e.g. "Pull request #42".'),
  heading: z.string(),
  subheading: z.string().nullable(),
  chips: z.array(z.string()).describe('Up to 4 short tags, e.g. component names.'),
});

export const MissionVisualSchema = z.object({
  type: z.literal('mission'),
  problem: z.string().describe('The problem or task, in one or two short sentences.'),
  goal: z.string().describe('What this change sets out to do.'),
  points: z.array(textBeat).describe('Up to 4 supporting points.'),
});

export const FilesVisualSchema = z.object({
  type: z.literal('files'),
  highlightPaths: z
    .array(z.string())
    .describe('Changed paths to emphasise. The engine draws the real file list.'),
  caption: z.string().nullable(),
});

export const ArchitectureVisualSchema = z.object({
  type: z.literal('architecture'),
  direction: z.enum(['LR', 'TB']),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      detail: z.string().nullable(),
      kind: NodeKindSchema,
      status: z.enum(['added', 'modified', 'removed', 'unchanged']),
      beat,
      evidence: evidenceIds,
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string().nullable(),
      status: z.enum(['added', 'removed', 'unchanged']),
      beat,
    }),
  ),
});

export const FlowVisualSchema = z.object({
  type: z.literal('flow'),
  actors: z.array(z.object({ id: z.string(), label: z.string(), kind: NodeKindSchema })),
  steps: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
      detail: z.string().nullable(),
      kind: z.enum(['request', 'response', 'event', 'call']),
      beat,
      evidence: evidenceIds,
    }),
  ),
});

export const CodeVisualSchema = z.object({
  type: z.literal('code'),
  ref: CodeRefSchema,
  mode: z
    .enum(['snippet', 'diff'])
    .describe('"diff" shows removed and added lines of the hunk; "snippet" shows code at one side.'),
  focus: z.array(
    z.object({
      startLine: z.number().int(),
      endLine: z.number().int(),
      note: z.string().nullable().describe('Short callout shown next to the highlighted lines.'),
      beat,
    }),
  ),
  caption: z.string().nullable(),
});

export const TerminalLineSchema = z.object({
  kind: z.enum(['command', 'output', 'comment']),
  text: z.string(),
  beat,
});

export const PanelSchema = z.object({
  label: z.string().describe('e.g. "Before" or "After".'),
  kind: z.enum(['code', 'bullets', 'terminal', 'screenshot']),
  codeRef: CodeRefSchema.nullable(),
  bullets: z.array(z.string()),
  terminal: z.array(TerminalLineSchema),
  screenshotId: z.string().nullable().describe('An SS<n> id from the evidence pack.'),
});

export const BeforeAfterVisualSchema = z.object({
  type: z.literal('before-after'),
  before: PanelSchema,
  after: PanelSchema,
  caption: z.string().nullable(),
});

export const TerminalVisualSchema = z.object({
  type: z.literal('terminal'),
  title: z.string(),
  lines: z.array(TerminalLineSchema),
});

export const BrowserVisualSchema = z.object({
  type: z.literal('browser'),
  url: z.string().describe('A path-like address such as "/settings/profile". Never a real hostname.'),
  pageTitle: z.string(),
  blocks: z.array(
    z.object({
      kind: z.enum([
        'heading',
        'text',
        'button',
        'input',
        'list',
        'table',
        'card',
        'toast',
        'badge',
        'image',
      ]),
      text: z.string(),
      items: z
        .array(z.string())
        .describe(
          'list: one entry per item. table: one entry per row, cells separated by "|", first row is the header. ' +
            'input: items[0] is the value shown in the field. Other kinds: usually empty.',
        ),
      emphasis: z.boolean(),
      beat,
    }),
  ),
});

export const ChecklistVisualSchema = z.object({
  type: z.literal('checklist'),
  items: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      severity: SeveritySchema,
      ref: CodeRefSchema.nullable(),
      beat,
      evidence: evidenceIds,
    }),
  ),
});

export const BulletsVisualSchema = z.object({
  type: z.literal('bullets'),
  heading: z.string().nullable(),
  items: z.array(textBeat),
});

export const ScreenshotVisualSchema = z.object({
  type: z.literal('screenshot'),
  screenshotId: z.string(),
  caption: z.string().nullable(),
});

export const SummaryVisualSchema = z.object({
  type: z.literal('summary'),
  points: z.array(textBeat),
  closing: z.string().nullable(),
});

export const VisualSchema = z.discriminatedUnion('type', [
  TitleVisualSchema,
  MissionVisualSchema,
  FilesVisualSchema,
  ArchitectureVisualSchema,
  FlowVisualSchema,
  CodeVisualSchema,
  BeforeAfterVisualSchema,
  TerminalVisualSchema,
  BrowserVisualSchema,
  ChecklistVisualSchema,
  BulletsVisualSchema,
  ScreenshotVisualSchema,
  SummaryVisualSchema,
]);

export const NarrationLineSchema = z.object({
  text: z
    .string()
    .describe('One or two short spoken sentences. Plain words, no markdown, no file paths read aloud.'),
  evidence: evidenceIds,
});

export const SceneSchema = z.object({
  id: z.string().describe('Unique scene id such as "s1".'),
  role: SceneRoleSchema,
  title: z.string().describe('Chapter title, 2 to 6 words.'),
  narration: z.array(NarrationLineSchema).describe('1 to 6 lines. Visual elements appear on these beats.'),
  visual: VisualSchema,
  visualDescription: z.string().describe('One sentence describing what the viewer sees.'),
  transition: TransitionSchema,
  targetSeconds: z.number().nullable().describe('Optional hint; real length follows the narration.'),
});

export const ReviewItemSchema = z.object({
  title: z.string(),
  detail: z.string(),
  severity: SeveritySchema,
  ref: CodeRefSchema.nullable(),
  evidence: evidenceIds,
});

export const StoryboardSchema = z.object({
  version: z.literal(STORYBOARD_VERSION),
  title: z.string().describe('Video title, under 60 characters.'),
  summary: z.string().describe('Two sentences for reviewers: what changed and why.'),
  style: z.enum(['technical', 'product', 'hybrid']),
  language: z.string().describe('BCP 47 language tag of the narration, e.g. "en".'),
  scenes: z.array(SceneSchema),
  reviewChecklist: z.array(ReviewItemSchema),
  uncertainties: z
    .array(z.string())
    .describe('Things the evidence does not settle. Say them here instead of guessing.'),
});

export type CodeRefInput = z.infer<typeof CodeRefSchema>;
export type SceneRole = z.infer<typeof SceneRoleSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type TransitionType = z.infer<typeof TransitionSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Visual = z.infer<typeof VisualSchema>;
export type VisualType = Visual['type'];
export type Panel = z.infer<typeof PanelSchema>;
export type TerminalLine = z.infer<typeof TerminalLineSchema>;
export type NarrationLine = z.infer<typeof NarrationLineSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export type Storyboard = z.infer<typeof StoryboardSchema>;

export const VISUAL_TYPES: readonly VisualType[] = [
  'title',
  'mission',
  'files',
  'architecture',
  'flow',
  'code',
  'before-after',
  'terminal',
  'browser',
  'checklist',
  'bullets',
  'screenshot',
  'summary',
];

/** Visuals that depict behaviour instead of showing repository content. Always labelled "simulated". */
export const SIMULATED_VISUALS: readonly VisualType[] = ['terminal', 'browser'];

const DROPPED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
  'examples',
]);

function sanitizeForLlm(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeForLlm);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === 'oneOf') {
      out.anyOf = sanitizeForLlm(value);
      continue;
    }
    if (key === 'const') {
      out.enum = [value];
      continue;
    }
    out[key] = sanitizeForLlm(value);
  }
  if (out.type === 'object' || out.properties !== undefined) {
    const properties = (out.properties ?? {}) as Record<string, unknown>;
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

/**
 * JSON Schema for structured-output APIs (Anthropic output_config.format, OpenAI strict json_schema).
 * Unsupported keywords are removed, oneOf becomes anyOf, every object is closed and fully required.
 */
export function storyboardJsonSchemaForLlm(): Record<string, unknown> {
  return sanitizeForLlm(z.toJSONSchema(StoryboardSchema)) as Record<string, unknown>;
}

/** Full JSON Schema with descriptions, for agents and humans who write storyboards by hand. */
export function storyboardJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(StoryboardSchema) as Record<string, unknown>;
}

/** Limits enforced by the grounding validator (kept out of the wire schema on purpose). */
export const STORYBOARD_LIMITS = {
  minScenes: 2,
  maxScenes: 10,
  maxNarrationLinesPerScene: 6,
  maxWordsPerNarrationLine: 40,
  maxCodeLines: 18,
  maxArchitectureNodes: 9,
  maxFlowActors: 5,
  maxFlowSteps: 8,
  maxChecklistItems: 5,
  maxBullets: 5,
  maxTerminalLines: 12,
  maxBrowserBlocks: 8,
  maxChips: 4,
  maxMissionPoints: 4,
  maxTitleLength: 60,
  /** Average speaking rate used to estimate narration length before speech exists. */
  wordsPerSecond: 2.5,
} as const;
