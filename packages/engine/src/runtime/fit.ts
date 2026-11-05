/**
 * Text fitting. Measuring needs a laid-out DOM with the final fonts, so the runtime calls it
 * once at load time (after fonts are ready). Results depend only on content, never on time.
 */

/**
 * Shrink an element's font size in steps until its content fits its box (or the minimum is reached).
 * The element must already be in the document with its final width (and height, if `maxHeight` is set).
 */
export function fitText(
  el: HTMLElement,
  options: { max: number; min: number; maxHeight?: number; step?: number },
): number {
  const step = options.step ?? 2;
  let size = options.max;
  el.style.fontSize = `${size}px`;
  const fits = () =>
    el.scrollWidth <= el.clientWidth + 1 &&
    (options.maxHeight === undefined ? true : el.scrollHeight <= options.maxHeight + 1);
  while (size > options.min && !fits()) {
    size -= step;
    el.style.fontSize = `${size}px`;
  }
  return size;
}

/** Whole text lines in a block, from its scroll height. Tolerates sub-pixel rounding. */
export function lineCount(scrollHeight: number, lineHeightPx: number): number {
  if (lineHeightPx <= 0) return 0;
  return Math.max(1, Math.round(scrollHeight / lineHeightPx));
}

/**
 * Shrink the font size until the text wraps to at most `maxLines` lines.
 * Give either a unitless `lineHeight` (scales with the font) or a fixed `lineHeightPx`.
 * Returns the chosen size; at the minimum size the text may still be longer (callers clamp it with CSS).
 */
export function fitLines(
  el: HTMLElement,
  options: {
    max: number;
    min: number;
    maxLines: number;
    lineHeight?: number;
    lineHeightPx?: number;
    step?: number;
  },
): number {
  const step = options.step ?? 2;
  let size = options.max;
  const lineHeightAt = (px: number) => options.lineHeightPx ?? px * (options.lineHeight ?? 1.2);
  const apply = () => {
    el.style.fontSize = `${size}px`;
  };
  const fits = () =>
    el.scrollWidth <= el.clientWidth + 1 &&
    lineCount(el.scrollHeight, lineHeightAt(size)) <= options.maxLines;
  apply();
  while (size > options.min && !fits()) {
    size = Math.max(options.min, size - step);
    apply();
  }
  return size;
}

/**
 * Try several (size range, line limit) stages in order and settle on the first that fits, for
 * example "at most 2 lines from 92 to 56 px, else 3 lines from 56 to 44 px". If nothing fits, the
 * last stage's smallest size is used. Returns the chosen size and the line limit it was chosen for.
 */
export function fitStages(
  el: HTMLElement,
  stages: readonly { max: number; min: number; maxLines: number }[],
  options: { lineHeight?: number; lineHeightPx?: number; step?: number },
): { size: number; maxLines: number } {
  const step = options.step ?? 2;
  const lineHeightAt = (px: number) => options.lineHeightPx ?? px * (options.lineHeight ?? 1.2);
  let last = { size: stages[0]?.min ?? 16, maxLines: stages[0]?.maxLines ?? 1 };
  for (const stage of stages) {
    const sizes: number[] = [];
    for (let size = stage.max; size > stage.min; size -= step) sizes.push(size);
    sizes.push(stage.min);
    for (const size of sizes) {
      el.style.fontSize = `${size}px`;
      last = { size, maxLines: stage.maxLines };
      if (
        el.scrollWidth <= el.clientWidth + 1 &&
        lineCount(el.scrollHeight, lineHeightAt(size)) <= stage.maxLines
      ) {
        return last;
      }
    }
  }
  el.style.fontSize = `${last.size}px`;
  return last;
}

/** Cut an element's text after `lines` lines with an ellipsis. Call it after measuring: it hides any overflow. */
export function clampLines(el: HTMLElement, lines: number): void {
  el.style.display = '-webkit-box';
  el.style.overflow = 'hidden';
  el.style.setProperty('-webkit-box-orient', 'vertical');
  el.style.setProperty('-webkit-line-clamp', String(lines));
}

/** Clamp text to a number of characters on a word boundary, adding an ellipsis. */
export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxChars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Keep the start and the end of a string and replace the middle with an ellipsis. */
export function middleTruncate(text: string, maxChars: number, tailShare = 0.6): string {
  const chars = Array.from(text);
  if (maxChars < 1) return '';
  if (chars.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  const keep = maxChars - 1;
  const tail = Math.min(keep - 1, Math.max(1, Math.round(keep * tailShare)));
  const head = Math.max(1, keep - tail);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

/**
 * Shorten a path or "path:lines" label to `maxChars` characters, keeping the whole file name when
 * possible ("src/pay…/retry.ts:12-40"), because the end of a path says the most.
 */
export function truncatePath(path: string, maxChars: number): string {
  if (Array.from(path).length <= maxChars) return path;
  const slash = path.lastIndexOf('/');
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const baseLen = Array.from(base).length;
  if (slash >= 0 && baseLen + 2 <= maxChars) {
    const headLen = maxChars - baseLen - 2;
    const dir = Array.from(path.slice(0, slash)).slice(0, Math.max(0, headLen)).join('');
    return headLen >= 2 ? `${dir}…/${base}` : `…/${base}`;
  }
  return middleTruncate(path, maxChars, 0.7);
}

/** Width of monospaced text in pixels (JetBrains Mono advances 0.6 em per character). */
export function monoWidth(chars: number, fontSizePx: number): number {
  return chars * fontSizePx * 0.6;
}

/** How many monospaced characters fit in `widthPx`. */
export function monoChars(widthPx: number, fontSizePx: number): number {
  return Math.max(1, Math.floor(widthPx / (fontSizePx * 0.6)));
}

/** Integer with thousands separators ("1,284"). Locale independent. */
export function formatInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Two-digit counter ("02"). */
export function pad2(value: number): string {
  return String(Math.max(0, Math.round(value))).padStart(2, '0');
}
