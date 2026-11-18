import { describe, expect, it } from 'vitest';
import { sampleStoryboard } from '../testing/sample-change.ts';
import {
  PanelSchema,
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
