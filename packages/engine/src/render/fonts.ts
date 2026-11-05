/** Bundled fonts as @font-face rules with base64 data URLs, so the render page never loads anything. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

interface FontFace {
  family: string;
  weight: number;
  /** Module path of the woff2 file. */
  file: string;
}

const INTER = (weight: number): FontFace => ({
  family: 'Inter',
  weight,
  file: `@fontsource/inter/files/inter-latin-${weight}-normal.woff2`,
});

const MONO = (weight: number): FontFace => ({
  family: 'JetBrains Mono',
  weight,
  file: `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`,
});

export const FONT_FACES: readonly FontFace[] = [
  INTER(400),
  INTER(500),
  INTER(600),
  INTER(700),
  INTER(800),
  MONO(400),
  MONO(500),
  MONO(700),
];

let cached: Promise<string> | null = null;

/** CSS with every bundled font face embedded. Read once per process. */
export function fontFacesCss(): Promise<string> {
  cached ??= (async () => {
    const require = createRequire(import.meta.url);
    const rules: string[] = [];
    for (const face of FONT_FACES) {
      const data = await readFile(require.resolve(face.file));
      rules.push(
        `@font-face{font-family:'${face.family}';font-weight:${face.weight};font-style:normal;font-display:block;` +
          `src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');}`,
      );
    }
    return rules.join('\n');
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}
