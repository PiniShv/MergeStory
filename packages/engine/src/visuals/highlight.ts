/**
 * Syntax highlighting with Shiki. The highlighter is created once per process, themes are loaded
 * together and grammars are loaded the first time a language is needed.
 */
import { type BundledLanguage, bundledLanguages, bundledLanguagesAlias, createHighlighter } from 'shiki';
import type { Logger } from '../core/logger.ts';
import type { CodeToken, ThemeName } from '../core/render-plan.ts';

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

const THEMES = { dark: 'github-dark-default', light: 'github-light-default' } as const;

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>();
const failedLanguages = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEMES.dark, THEMES.light], langs: [] }).catch(
    (err) => {
      highlighterPromise = null; // let a later call try again
      throw err;
    },
  );
  return highlighterPromise;
}

const PLAIN_LANGUAGES = new Set(['', 'text', 'plaintext', 'plain', 'txt']);

/** The Shiki grammar id for a language name, or null when the text should be shown without colours. */
export function resolveLanguage(language: string | null | undefined): string | null {
  const id = (language ?? '').trim().toLowerCase();
  if (PLAIN_LANGUAGES.has(id)) return null;
  if (id in bundledLanguages || id in bundledLanguagesAlias) return id;
  return null;
}

/** One plain token per line, no colours. Used for unknown languages and when highlighting is unavailable. */
export function plainTokens(text: string): CodeToken[][] {
  return text.split('\n').map((line) => (line === '' ? [] : [{ t: line, c: null, s: 0 }]));
}

export interface HighlightOptions {
  language: string | null | undefined;
  theme: ThemeName;
  logger?: Logger;
}

/** Shiki font style bits: 1 italic, 2 bold, 4 underline (strikethrough, 8, is not drawn). */
function fontBits(fontStyle: number | undefined): number {
  return fontStyle !== undefined && fontStyle > 0 ? fontStyle & 7 : 0;
}

/**
 * Highlight a whole text and return tokens per line. Highlighting the whole text keeps the grammar
 * state correct across lines (block comments, template strings), so callers slice lines afterwards.
 * Colours equal to the theme's default foreground become null.
 */
export async function highlightText(text: string, options: HighlightOptions): Promise<CodeToken[][]> {
  const lineCount = text.split('\n').length;
  const language = resolveLanguage(options.language);
  if (language === null || failedLanguages.has(language)) return plainTokens(text);
  try {
    const highlighter = await getHighlighter();
    if (!loadedLanguages.has(language)) {
      await highlighter.loadLanguage(language as BundledLanguage);
      loadedLanguages.add(language);
    }
    const result = highlighter.codeToTokens(text, {
      lang: language as BundledLanguage,
      theme: THEMES[options.theme],
    });
    const foreground = result.fg?.toLowerCase() ?? null;
    const lines = result.tokens.map((line) => {
      const out: CodeToken[] = [];
      for (const token of line) {
        if (token.content === '') continue;
        const color = token.color ? token.color.toLowerCase() : null;
        const c = color === null || color === foreground ? null : color;
        const s = fontBits(token.fontStyle);
        const last = out[out.length - 1];
        if (last && last.c === c && last.s === s) last.t += token.content;
        else out.push({ t: token.content, c, s });
      }
      return out;
    });
    while (lines.length < lineCount) lines.push([]);
    return lines;
  } catch (err) {
    failedLanguages.add(language);
    options.logger?.warn('Syntax highlighting is unavailable for a language; showing it without colours.', {
      language,
      error: err instanceof Error ? err.message : String(err),
    });
    return plainTokens(text);
  }
}
