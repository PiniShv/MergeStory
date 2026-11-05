import { describe, expect, it } from 'vitest';
import {
  BASE_FONTS,
  DIAGRAM_AREA,
  EDGE_WRAP,
  fitScale,
  fontsForScale,
  NODE_CHROME,
} from '../core/diagram-metrics.ts';
import type { ArchitectureResolved } from '../core/render-plan.ts';
import {
  type ArchitectureVisual,
  countLines,
  edgeLabelSize,
  estimateNodeSize,
  foldRows,
  layoutArchitecture,
  longestSegment,
  MAX_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  type Placed,
  textWidth,
  transpose,
} from './layout.ts';

type Node = ArchitectureVisual['nodes'][number];
type Edge = ArchitectureVisual['edges'][number];

const node = (id: string, label = id, detail: string | null = null): Node => ({
  id,
  label,
  detail,
  kind: 'module',
  status: 'unchanged',
  beat: 0,
  evidence: [],
});
const edge = (from: string, to: string, label: string | null = null): Edge => ({
  from,
  to,
  label,
  status: 'added',
  beat: 0,
});

function visual(nodes: Node[], edges: Edge[], direction: 'LR' | 'TB' = 'LR'): ArchitectureVisual {
  return { type: 'architecture', direction, nodes, edges };
}

function overlaps(
  a: ArchitectureResolved['nodes'][number],
  b: ArchitectureResolved['nodes'][number],
): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
}

function expectClean(layout: ReturnType<typeof layoutArchitecture>): void {
  for (let i = 0; i < layout.nodes.length; i++) {
    const a = layout.nodes[i]!;
    expect(a.x - a.w / 2, `${a.id} left`).toBeGreaterThanOrEqual(0);
    expect(a.y - a.h / 2, `${a.id} top`).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w / 2, `${a.id} right`).toBeLessThanOrEqual(layout.width);
    expect(a.y + a.h / 2, `${a.id} bottom`).toBeLessThanOrEqual(layout.height);
    for (let j = i + 1; j < layout.nodes.length; j++) {
      expect(overlaps(a, layout.nodes[j]!), `${a.id} overlaps ${layout.nodes[j]!.id}`).toBe(false);
    }
  }
  for (const e of layout.edges) {
    expect(e.points.length).toBeGreaterThanOrEqual(2);
    for (const p of e.points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  }
}

const LABEL = { px: 30, weight: 700, spacingEm: -0.015 } as const;
const DETAIL = { px: 22, weight: 500 } as const;

describe('textWidth', () => {
  it('adds up the advance widths of the video font', () => {
    // Measured in the browser with the embedded font: 205.2 px.
    expect(textWidth('WeatherClient', LABEL)).toBeGreaterThan(204);
    expect(textWidth('WeatherClient', LABEL)).toBeLessThan(209);
    // Measured: 269.8 px.
    expect(textWidth('WEATHER_MAX_RETRIES', DETAIL)).toBeGreaterThan(269);
    expect(textWidth('WEATHER_MAX_RETRIES', DETAIL)).toBeLessThan(275);
  });

  it('grows with the weight and the size, and counts letter spacing', () => {
    const text = 'Forecast-Request';
    expect(textWidth(text, { px: 22, weight: 700 })).toBeGreaterThan(
      textWidth(text, { px: 22, weight: 500 }),
    );
    expect(textWidth(text, { px: 44, weight: 500 })).toBeCloseTo(
      2 * textWidth(text, { px: 22, weight: 500 }),
      6,
    );
    expect(textWidth(text, { px: 22, weight: 500, spacingEm: -0.02 })).toBeLessThan(
      textWidth(text, { px: 22, weight: 500 }),
    );
  });

  it('knows common punctuation and treats other characters as average ones', () => {
    expect(textWidth('…', DETAIL)).toBeGreaterThan(0);
    expect(textWidth('日本', DETAIL)).toBeCloseTo(2 * 22, 6);
    expect(textWidth('é', DETAIL)).toBeCloseTo(0.6 * 22, 6);
    expect(textWidth('', DETAIL)).toBe(0);
  });
});

describe('countLines', () => {
  it('counts one line for text that fits and none for empty text', () => {
    expect(countLines('retry options', 400, DETAIL)).toBe(1);
    expect(countLines('   ', 400, DETAIL)).toBe(0);
  });

  it('wraps at spaces', () => {
    const text = 'one two three four five six seven eight nine ten';
    const full = textWidth(text, DETAIL);
    expect(countLines(text, full + 1, DETAIL)).toBe(1);
    expect(countLines(text, full / 2, DETAIL)).toBeGreaterThanOrEqual(2);
    expect(countLines(text, full / 2, DETAIL)).toBeLessThanOrEqual(3);
    expect(countLines(text, full / 4, DETAIL)).toBeGreaterThanOrEqual(4);
  });

  it('breaks a word that is wider than the box', () => {
    const word = 'FORECAST_MAX_RETRIES_PER_REQUEST';
    expect(countLines(word, textWidth(word, DETAIL) / 2.5, DETAIL)).toBe(3);
  });
});

describe('estimateNodeSize', () => {
  it('never goes below the minimum size', () => {
    expect(estimateNodeSize('A', null)).toMatchObject({ w: MIN_NODE_WIDTH, h: MIN_NODE_HEIGHT });
  });

  it('is wide enough for a label and a detail on one line each', () => {
    const size = estimateNodeSize('WeatherClient', 'src/client.ts');
    const text = size.w - NODE_CHROME;
    expect(text).toBeGreaterThanOrEqual(textWidth('WeatherClient', LABEL));
    expect(text).toBeGreaterThanOrEqual(textWidth('src/client.ts', DETAIL));
    expect(size.labelLines).toBe(1);
    expect(size.detailLines).toBe(1);
  });

  it('has room for the detail line in the height', () => {
    const plain = estimateNodeSize('WeatherClient', null);
    const detailed = estimateNodeSize('WeatherClient', 'src/client.ts');
    expect(detailed.h).toBeGreaterThan(plain.h);
    expect(detailed.h).toBeGreaterThanOrEqual(2 * 22 + 30 * 1.15 + 6 + 22 * 1.2);
  });

  it('widens for long labels, up to a limit, then wraps and grows taller', () => {
    const wide = estimateNodeSize('Forecast gateway adapter service', null);
    expect(wide.w).toBeGreaterThan(MIN_NODE_WIDTH);
    expect(wide.w).toBeLessThanOrEqual(MAX_NODE_WIDTH);
    const capped = estimateNodeSize('word '.repeat(40), null);
    expect(capped.w).toBe(MAX_NODE_WIDTH);
    expect(capped.labelLines).toBe(2);
    const tall = estimateNodeSize(
      'Client',
      'a long description that needs more than one line of text to fit in the box',
    );
    expect(tall.detailLines).toBe(2);
    expect(tall.h).toBeGreaterThan(estimateNodeSize('Client', 'short').h);
  });

  it('is never narrower than its longest word, so names are not broken', () => {
    const word = 'WEATHER_MAX_RETRIES';
    const size = estimateNodeSize('Loader', word, { maxWidth: 300 });
    expect(size.w - NODE_CHROME).toBeGreaterThanOrEqual(textWidth(word, DETAIL));
  });

  it('wraps more when asked for narrower cards, and grows with larger fonts', () => {
    const label = 'Forecast gateway adapter service';
    expect(estimateNodeSize(label, null, { maxWidth: 340 }).w).toBeLessThan(estimateNodeSize(label, null).w);
    expect(estimateNodeSize(label, null, { maxWidth: 340 }).labelLines).toBe(2);
    const big = estimateNodeSize('WeatherClient', 'src/client.ts', { fonts: fontsForScale(0.7) });
    expect(big.w).toBeGreaterThan(estimateNodeSize('WeatherClient', 'src/client.ts').w);
  });
});

describe('edgeLabelSize', () => {
  it('keeps a short label on one line and sizes the pill to its text', () => {
    const box = edgeLabelSize('retry options', BASE_FONTS, EDGE_WRAP.LR);
    expect(box.lines).toBe(1);
    expect(box.h).toBeGreaterThanOrEqual(1.7 * 22);
    expect(box.h).toBeLessThan(1.7 * 22 + 1);
    expect(box.w).toBeGreaterThan(textWidth('retry options', { px: 22, weight: 600 }));
  });

  it('wraps a long label to two lines at the wrap width, but never narrower than its longest word', () => {
    const font = { px: 22, weight: 600 } as const;
    const box = edgeLabelSize('POST + Forecast-Request', BASE_FONTS, 200);
    expect(box.lines).toBe(2);
    expect(box.w).toBeGreaterThanOrEqual(longestSegment('POST + Forecast-Request', font) + 2 * 0.7 * 22);
    expect(box.h).toBeGreaterThan(edgeLabelSize('x', BASE_FONTS, 200).h);
    const narrow = edgeLabelSize('Forecast-Request-Policy-Handler', BASE_FONTS, 100);
    expect(narrow.w).toBeGreaterThanOrEqual(
      longestSegment('Forecast-Request-Policy-Handler', font) + 2 * 0.7 * 22,
    );
  });

  it('wraps later for a top to bottom diagram', () => {
    const label = 'sends the forecast request to the weather API';
    expect(edgeLabelSize(label, BASE_FONTS, EDGE_WRAP.TB).lines).toBeLessThanOrEqual(
      edgeLabelSize(label, BASE_FONTS, EDGE_WRAP.LR).lines,
    );
  });
});

describe('layoutArchitecture', () => {
  const nodes = [
    node('client', 'Forecast client', 'src/client.ts'),
    node('retry', 'Retry', 'withRetry'),
    node('http', 'HTTP layer'),
  ];
  const edges = [edge('client', 'retry', 'wraps calls'), edge('retry', 'http')];

  it('places nodes left to right for LR without overlaps', () => {
    const layout = layoutArchitecture(visual(nodes, edges, 'LR'));
    expectClean(layout);
    const x = (id: string) => layout.nodes.find((n) => n.id === id)!.x;
    expect(x('client')).toBeLessThan(x('retry'));
    expect(x('retry')).toBeLessThan(x('http'));
    expect(layout.width).toBeGreaterThan(layout.height);
  });

  it('places nodes top to bottom for TB', () => {
    const layout = layoutArchitecture(visual(nodes, edges, 'TB'));
    expectClean(layout);
    const y = (id: string) => layout.nodes.find((n) => n.id === id)!.y;
    expect(y('client')).toBeLessThan(y('retry'));
    expect(y('retry')).toBeLessThan(y('http'));
    expect(layout.height).toBeGreaterThan(layout.width / 4);
  });

  it('keeps the data of nodes and edges and routes edges from source to target', () => {
    const layout = layoutArchitecture(visual(nodes, edges));
    expect(layout.nodes[0]).toMatchObject({
      id: 'client',
      label: 'Forecast client',
      detail: 'src/client.ts',
      kind: 'module',
      status: 'unchanged',
      beat: 0,
    });
    expect(layout.nodes.every((n) => n.w >= MIN_NODE_WIDTH && n.h >= MIN_NODE_HEIGHT)).toBe(true);
    const first = layout.edges[0]!;
    expect(first).toMatchObject({ from: 'client', to: 'retry', label: 'wraps calls', status: 'added' });
    const client = layout.nodes.find((n) => n.id === 'client')!;
    const retry = layout.nodes.find((n) => n.id === 'retry')!;
    const start = first.points[0]!;
    const end = first.points[first.points.length - 1]!;
    expect(Math.abs(start.x - client.x)).toBeLessThanOrEqual(client.w / 2 + 1);
    expect(Math.abs(end.x - retry.x)).toBeLessThanOrEqual(retry.w / 2 + 1);
    expect(start.x).toBeLessThan(end.x);
  });

  it('lays out a wide graph of nine nodes without overlaps', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      node(`n${i}`, `Component number ${i}`, i % 2 ? 'with a detail line' : null),
    );
    const links = [
      edge('n0', 'n1'),
      edge('n0', 'n2', 'calls'),
      edge('n0', 'n3'),
      edge('n1', 'n4'),
      edge('n2', 'n4'),
      edge('n3', 'n5', 'publishes event'),
      edge('n4', 'n6'),
      edge('n5', 'n6'),
      edge('n6', 'n7'),
      edge('n6', 'n8'),
    ];
    for (const direction of ['LR', 'TB'] as const) {
      expectClean(layoutArchitecture(visual(many, links, direction)));
    }
  });

  it('copes with cycles, repeated edges and self references', () => {
    const layout = layoutArchitecture(
      visual(
        [node('a'), node('b')],
        [edge('a', 'b', 'one'), edge('a', 'b', 'two'), edge('b', 'a'), edge('a', 'a')],
      ),
    );
    expectClean(layout);
    expect(layout.edges).toHaveLength(4);
  });

  it('drops edges to unknown nodes and repeated node ids', () => {
    const layout = layoutArchitecture(
      visual(
        [node('a'), node('b'), node('a', 'Duplicate')],
        [edge('a', 'b'), edge('a', 'ghost'), edge('ghost', 'b')],
      ),
    );
    expect(layout.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(layout.nodes[0]?.label).toBe('a');
    expect(layout.edges).toHaveLength(1);
    expectClean(layout);
  });

  it('lays out nodes without edges and an empty diagram', () => {
    expectClean(layoutArchitecture(visual([node('a'), node('b'), node('c')], [])));
    const empty = layoutArchitecture(visual([], []));
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
  });

  it('gives every node room for its own text', () => {
    const real = [
      node('caller', 'Your code', 'client.getForecast(...)'),
      node('client', 'WeatherClient', 'src/client.ts'),
      node('config', 'loadConfig', 'WEATHER_MAX_RETRIES'),
      node('api', 'Forecast API', 'GET /v1/forecast'),
      node('retry', 'withRetry', 'src/retry.ts'),
    ];
    const links = [
      edge('caller', 'client', 'getForecast()'),
      edge('config', 'client', 'retry options'),
      edge('client', 'api', 'POST + Forecast-Request'),
      edge('client', 'retry', 'every attempt'),
    ];
    for (const direction of ['LR', 'TB'] as const) {
      const layout = layoutArchitecture(visual(real, links, direction));
      expectClean(layout);
      const scale = fitScale(layout.width, layout.height);
      const fonts = fontsForScale(scale * 0.97);
      for (const n of layout.nodes) {
        const source = real.find((r) => r.id === n.id)!;
        const room = n.w - NODE_CHROME;
        expect(room, `${n.id} label`).toBeGreaterThanOrEqual(
          textWidth(source.label, { px: fonts.label, weight: 700, spacingEm: -0.015 }) - 1,
        );
        expect(room, `${n.id} detail`).toBeGreaterThanOrEqual(
          textWidth(source.detail ?? '', { px: fonts.detail, weight: 500 }) - 1,
        );
        expect(n.h).toBeGreaterThanOrEqual(MIN_NODE_HEIGHT);
      }
    }
  });

  it('keeps text legible when the diagram has to shrink', () => {
    const four = Array.from({ length: 4 }, (_, i) =>
      node(`n${i}`, `Component number ${i}`, `src/component-${i}/index.ts`),
    );
    const chain = Array.from({ length: 3 }, (_, i) =>
      edge(`n${i}`, `n${i + 1}`, `step ${i + 1} of the flow`),
    );
    const layout = layoutArchitecture(visual(four, chain, 'LR'));
    expectClean(layout);
    const scale = fitScale(layout.width, layout.height);
    expect(scale).toBeGreaterThan(0.6);
    const fonts = fontsForScale(scale);
    expect(fonts.detail * scale).toBeGreaterThanOrEqual(22 - 1e-9);
    expect(fonts.label * scale).toBeGreaterThanOrEqual(26 - 1e-9);
    for (const n of layout.nodes) {
      // A path may wrap after a slash or a hyphen, but never inside a piece.
      expect(n.w - NODE_CHROME).toBeGreaterThanOrEqual(
        longestSegment('src/component-0/index.ts', { px: fonts.detail * 0.97, weight: 500 }),
      );
    }
  });

  it('wraps a path at slashes to keep the diagram larger', () => {
    const long = 'src/forecast/components/retry-policy/index.ts';
    const wide = estimateNodeSize('Retry', long);
    const narrow = estimateNodeSize('Retry', long, { maxWidth: 340 });
    expect(narrow.w).toBeLessThan(wide.w);
    expect(narrow.detailLines).toBe(2);
    expect(narrow.w - NODE_CHROME).toBeGreaterThanOrEqual(longestSegment(long, DETAIL));
  });

  it('still lays out a very long chain without overlaps or runaway sizes', () => {
    const many = Array.from({ length: 9 }, (_, i) => node(`n${i}`, `Component number ${i}`, `src/c${i}.ts`));
    const chain = Array.from({ length: 8 }, (_, i) => edge(`n${i}`, `n${i + 1}`, `step ${i + 1}`));
    for (const direction of ['LR', 'TB'] as const) {
      const layout = layoutArchitecture(visual(many, chain, direction));
      expectClean(layout);
      expect(layout.nodes.every((n) => n.w <= MAX_NODE_WIDTH * 1.7)).toBe(true);
      expect(fitScale(layout.width, layout.height)).toBeGreaterThan(0.15);
    }
  });

  it('lets a diagram that is small on the page grow instead of staying tiny', () => {
    const layout = layoutArchitecture(visual([node('a', 'App'), node('b', 'API')], [edge('a', 'b')]));
    expect(fitScale(layout.width, layout.height)).toBe(DIAGRAM_AREA.maxScale);
  });

  it('is deterministic', () => {
    const first = layoutArchitecture(visual(nodes, edges));
    const second = layoutArchitecture(visual(nodes, edges));
    expect(second).toEqual(first);
  });
});

describe('folding a long chain into two rows', () => {
  /** A left to right chain of `count` nodes, as dagre would draw it. */
  function chain(count: number): Placed {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      label: `Node ${i}`,
      detail: null,
      kind: 'module' as const,
      status: 'unchanged' as const,
      beat: 0,
      x: 200 + i * 500,
      y: 120,
      w: 300,
      h: 110,
    }));
    const edges = Array.from({ length: count - 1 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
      label: null,
      status: 'unchanged' as const,
      beat: 0,
      points: [
        { x: 350 + i * 500, y: 120 },
        { x: 550 + i * 500, y: 120 },
      ],
    }));
    return { width: 400 + count * 500, height: 240, nodes, edges };
  }

  it('does not fold fewer than three ranks', () => {
    expect(foldRows(chain(2))).toBeNull();
  });

  it('puts the second half of the ranks in a row below the first, starting at the left', () => {
    const folded = foldRows(chain(6))!;
    const top = folded.nodes.filter((n) => n.y < 200);
    const bottom = folded.nodes.filter((n) => n.y >= 200);
    expect(top.map((n) => n.id)).toEqual(['n0', 'n1', 'n2']);
    expect(bottom.map((n) => n.id)).toEqual(['n3', 'n4', 'n5']);
    const left = (nodes: typeof top) => Math.min(...nodes.map((n) => n.x - n.w / 2));
    expect(left(bottom)).toBeCloseTo(left(top), 5);
    expect(folded.width).toBeLessThan(chain(6).width * 0.6);
    expect(folded.height).toBeGreaterThan(chain(6).height * 2);
    // Keeps the order inside each row.
    expect(top[0]!.x).toBeLessThan(top[1]!.x);
    expect(bottom[0]!.x).toBeLessThan(bottom[1]!.x);
  });

  it('keeps every node inside the box and apart from the others', () => {
    for (const count of [4, 5, 7, 9]) {
      const folded = foldRows(chain(count))!;
      for (const n of folded.nodes) {
        expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
        expect(n.y - n.h / 2).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w / 2).toBeLessThanOrEqual(folded.width);
        expect(n.y + n.h / 2).toBeLessThanOrEqual(folded.height);
      }
      for (let i = 0; i < folded.nodes.length; i++)
        for (let j = i + 1; j < folded.nodes.length; j++)
          expect(overlaps(folded.nodes[i]!, folded.nodes[j]!)).toBe(false);
    }
  });

  it('keeps the route of an edge inside a row and joins the rows with a channel between them', () => {
    const folded = foldRows(chain(6))!;
    const byId = new Map(folded.nodes.map((n) => [n.id, n]));
    const inside = folded.edges.find((e) => e.from === 'n0')!;
    expect(inside.points).toHaveLength(2);
    expect(inside.points[0]!.y).toBe(inside.points[1]!.y);
    const join = folded.edges.find((e) => e.from === 'n2' && e.to === 'n3')!;
    const a = byId.get('n2')!;
    const b = byId.get('n3')!;
    expect(join.points).toHaveLength(4);
    // Out of the bottom of the last node of the first row, into the top of the first node of the second.
    expect(join.points[0]).toEqual({ x: a.x, y: a.y + a.h / 2 });
    expect(join.points[3]).toEqual({ x: b.x, y: b.y - b.h / 2 });
    const channel = join.points[1]!.y;
    expect(channel).toBeGreaterThan(a.y + a.h / 2);
    expect(channel).toBeLessThan(b.y - b.h / 2);
    expect(join.points[2]!.y).toBe(channel);
  });

  it('spaces several edges between the rows apart', () => {
    const placed = chain(6);
    placed.edges.push({
      from: 'n1',
      to: 'n4',
      label: null,
      status: 'unchanged',
      beat: 0,
      points: [
        { x: 700, y: 120 },
        { x: 2200, y: 120 },
      ],
    });
    const folded = foldRows(placed)!;
    const channels = folded.edges.filter((e) => e.points.length === 4).map((e) => e.points[1]!.y);
    expect(channels).toHaveLength(2);
    expect(Math.abs(channels[0]! - channels[1]!)).toBeGreaterThanOrEqual(20);
  });

  it('gives up when an arrow between the rows would run through another card', () => {
    // Node n2 stands under n0 in the first row, in the way of the arrow n0 -> n3.
    const placed = chain(6);
    placed.nodes.push({
      id: 'blocker',
      label: 'Blocker',
      detail: null,
      kind: 'module',
      status: 'unchanged',
      beat: 0,
      x: 200,
      y: 330,
      w: 300,
      h: 110,
    });
    placed.edges = [
      {
        from: 'n0',
        to: 'n5',
        label: null,
        status: 'unchanged',
        beat: 0,
        points: [
          { x: 200, y: 120 },
          { x: 2700, y: 120 },
        ],
      },
      ...placed.edges.filter((e) => e.from !== 'n0'),
    ];
    // The fold would put n0's arrow straight down through the blocker.
    expect(foldRows({ ...placed, height: 400 })).toBeNull();
  });

  it('folds a top to bottom layout into two columns the same way', () => {
    const topToBottom = transpose(chain(6));
    const folded = transpose(foldRows(transpose(topToBottom))!);
    const sides = new Set(folded.nodes.map((n) => (n.x < folded.width / 2 ? 'left' : 'right')));
    expect(sides.size).toBe(2);
  });

  it('is what makes a long chain legible: the diagram is drawn large, not thin', () => {
    const names = ['Dashboard', 'WeatherClient', 'RetryPolicy', 'Gateway', 'Ledger', 'Settlements'];
    const nodes = names.map((n, i) => node(`n${i}`, n, `src/${n.toLowerCase()}.ts`));
    const links = names.slice(1).map((_, i) => edge(`n${i}`, `n${i + 1}`, `step ${i + 1}`));
    for (const direction of ['LR', 'TB'] as const) {
      const layout = layoutArchitecture(visual(nodes, links, direction));
      expectClean(layout);
      const scale = fitScale(layout.width, layout.height);
      expect(scale).toBeGreaterThan(0.75);
      const fonts = fontsForScale(scale);
      expect(fonts.detail * scale).toBeGreaterThanOrEqual(22 - 1e-9);
      expect(fonts.label * scale).toBeGreaterThanOrEqual(26 - 1e-9);
    }
  });

  it('leaves a diagram that already fits alone', () => {
    const small = layoutArchitecture(
      visual([node('a', 'App'), node('b', 'API'), node('c', 'DB')], [edge('a', 'b'), edge('b', 'c')]),
    );
    const ys = new Set(small.nodes.map((n) => Math.round(n.y)));
    expect(ys.size).toBe(1);
    expect(small.direction).toBe('LR');
  });
});
