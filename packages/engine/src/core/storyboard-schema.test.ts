import { describe, expect, it } from 'vitest';
import { sampleStoryboard } from '../testing/sample-change.ts';
import {
  HighlightSchema,
  PanelSchema,
  STORYBOARD_LIMITS,
  StoryboardSchema,
  storyboardJsonSchema,
  storyboardJsonSchemaForLlm,
  VISUAL_TYPES,
  VisualSchema,
} from './storyboard-schema.ts';

describe('the recording visual', () => {
  const clip = {
    type: 'recording',
    recordingId: 'RC1',
    caption: 'Checkout',
    trim: { start: 1, end: 6 },
    speed: 2,
    zoom: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    highlights: [],
    focus: null,
  };

  it('parses with every field, and the nullable ones can be null', () => {
    expect(VisualSchema.parse(clip)).toEqual(clip);
    const plain = { ...clip, caption: null, trim: null, speed: null, zoom: null };
    expect(VisualSchema.parse(plain)).toEqual(plain);
  });

  it('is listed in VISUAL_TYPES, which names every visual', () => {
    expect(VISUAL_TYPES).toContain('recording');
    expect([...VISUAL_TYPES].sort()).toEqual(VisualSchema.options.map((o) => o.shape.type.value).sort());
  });
});

describe('the recording panel', () => {
  const panel = {
    label: 'After',
    kind: 'recording',
    codeRef: null,
    bullets: [],
    terminal: [],
    screenshotId: null,
  };

  it('parses a panel from before recordings existed, with recordingId null', () => {
    expect(PanelSchema.parse({ ...panel, kind: 'bullets' }).recordingId).toBeNull();
    expect(PanelSchema.parse({ ...panel, recordingId: 'RC2' }).recordingId).toBe('RC2');
  });

  it('parses a whole storyboard written for the last release', () => {
    const old = structuredClone(sampleStoryboard());
    for (const { visual } of old.scenes) {
      if (visual.type !== 'before-after') continue;
      for (const side of [visual.before, visual.after]) delete (side as Partial<typeof side>).recordingId;
    }
    expect(StoryboardSchema.parse(old)).toEqual(sampleStoryboard());
  });

  it('is still required and without a default in the copy for models', () => {
    const find = (schema: unknown): Record<string, unknown> | null => {
      if (Array.isArray(schema)) return schema.map(find).find(Boolean) ?? null;
      if (typeof schema !== 'object' || schema === null) return null;
      const node = schema as Record<string, unknown>;
      const props = node.properties as Record<string, unknown> | undefined;
      if (props && 'recordingId' in props && 'codeRef' in props) return node;
      return Object.values(node).map(find).find(Boolean) ?? null;
    };
    const forModel = find(storyboardJsonSchemaForLlm())!;
    expect(forModel.required).toContain('recordingId');
    expect(JSON.stringify(storyboardJsonSchemaForLlm())).not.toContain('"default"');
    expect(find(storyboardJsonSchema())).not.toBeNull();
  });
});

describe('highlights and focus', () => {
  const highlight = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, label: 'The count', beat: 1 };
  const shot = { type: 'screenshot', screenshotId: 'SS1', caption: null };
  const clip = { type: 'recording', recordingId: 'RC1', caption: null, trim: null, speed: null, zoom: null };

  it('parses a highlight with a label or with null', () => {
    expect(HighlightSchema.parse(highlight)).toEqual(highlight);
    expect(HighlightSchema.parse({ ...highlight, label: null }).label).toBeNull();
    expect(HighlightSchema.safeParse({ x: 0, y: 0, w: 1, h: 1, beat: 0 }).success).toBe(false);
  });

  it('parses a screenshot and a recording with the new fields', () => {
    const focus = { x: 0, y: 0.5, w: 0.5, h: 0.5 };
    for (const visual of [shot, clip]) {
      const full = { ...visual, highlights: [highlight], focus };
      expect(VisualSchema.parse(full)).toEqual(full);
    }
  });

  it('parses a storyboard written before highlights existed, with no highlights and no focus', () => {
    // A 1.6 storyboard has no recordings either: its panels have no recordingId.
    const written = (panels: 'no recordings' | 'no highlights'): unknown => {
      const old = structuredClone(sampleStoryboard());
      for (const { visual } of old.scenes) {
        if (visual.type !== 'before-after') continue;
        for (const side of [visual.before, visual.after]) {
          delete (side as Partial<typeof side>).highlights;
          if (panels === 'no recordings') delete (side as Partial<typeof side>).recordingId;
        }
      }
      old.scenes[0]!.visual = shot as never;
      return old;
    };
    for (const kind of ['no recordings', 'no highlights'] as const) {
      const parsed = StoryboardSchema.parse(written(kind));
      expect(parsed.scenes[0]!.visual).toEqual({ ...shot, highlights: [], focus: null });
      for (const { visual } of parsed.scenes) {
        if (visual.type === 'before-after') expect(visual.before.highlights).toEqual([]);
      }
    }
    expect(VisualSchema.parse(clip)).toEqual({ ...clip, highlights: [], focus: null });
  });

  it('lists the new fields as required, with no default, in the copy for models', () => {
    const forModel = storyboardJsonSchemaForLlm();
    expect(JSON.stringify(forModel)).not.toContain('"default"');
    // The objects that hold the fields: a screenshot visual, a recording visual and a panel (a code visual has a "focus" of its own).
    const holders = { highlights: new Set<string>(), focus: new Set<string>() };
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      const props = (record.properties ?? {}) as Record<string, unknown>;
      const owner =
        'trim' in props
          ? 'recording'
          : 'kind' in props
            ? 'panel'
            : 'screenshotId' in props
              ? 'screenshot'
              : null;
      for (const field of ['highlights', 'focus'] as const) {
        if (field in props && owner !== null && !('mode' in props)) {
          expect(record.required, `${owner} ${field}`).toContain(field);
          holders[field].add(owner);
        }
      }
      if ('w' in props && 'label' in props) expect(record.required).toContain('label');
      Object.values(record).forEach(walk);
    };
    walk(forModel);
    expect([...holders.highlights].sort()).toEqual(['panel', 'recording', 'screenshot']);
    expect([...holders.focus].sort()).toEqual(['recording', 'screenshot']);
  });

  it('has limits that leave room for a box and a focus', () => {
    expect(STORYBOARD_LIMITS.maxHighlights).toBe(4);
    expect(STORYBOARD_LIMITS.maxHighlightLabelLength).toBe(40);
    expect(STORYBOARD_LIMITS.minHighlightSide).toBeLessThan(STORYBOARD_LIMITS.minFocusSide);
  });
});
