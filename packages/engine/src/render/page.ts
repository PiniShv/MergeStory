/**
 * The render page: one self-contained HTML document (fonts and runtime inlined) and a small
 * wrapper around a Playwright page that seeks the runtime and captures frames over CDP.
 *
 * The page has no network access. Three layers enforce this: a content security policy, request
 * blocking in the browser context, and the context's offline mode.
 */
import type { Browser, BrowserContext, CDPSession } from 'playwright-core';
import { MergeStoryError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import type { MergeStoryRuntimeApi, RenderPlan } from '../core/render-plan.ts';

export const PAGE_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** A "</script" inside inline script text would end the element early. */
export function escapeInlineScript(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1');
}

export interface PageSources {
  runtimeJs: string;
  fontsCss: string;
}

/** The HTML document that hosts the runtime. */
export function buildPageHtml({ runtimeJs, fontsCss }: PageSources): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">` +
    '<title>MergeStory</title>' +
    `<style>${fontsCss}</style></head>` +
    `<body><script>${escapeInlineScript(runtimeJs)}</script></body></html>`
  );
}

export type CaptureFormat =
  | { format: 'jpeg'; quality: number; optimizeForSpeed: boolean }
  | { format: 'png'; optimizeForSpeed: boolean };

/** A page that does not answer within this time is treated as stuck. */
const COMMAND_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 120_000;

/** Wait for `work`, but give up with a clear error when the browser does not answer in time. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new MergeStoryError('RENDER_FAILED', `The browser stopped responding while ${what}.`, {
            hint: 'Close other heavy programs, lower render.concurrency, or try another browser with MERGESTORY_BROWSER_PATH.',
          }),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([work, stuck]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the page offers to code that runs inside it (the engine's TypeScript has no DOM types). */
interface BrowserGlobals {
  __MERGESTORY__: MergeStoryRuntimeApi;
  document: { fonts: Iterable<{ load(): Promise<unknown> }> };
}

interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** A plan loaded in a page of its own browser context. */
export class PlanPage {
  private readonly context: BrowserContext;
  private readonly cdp: CDPSession;
  private blocked = 0;
  private readonly errors: string[] = [];

  private constructor(context: BrowserContext, cdp: CDPSession) {
    this.context = context;
    this.cdp = cdp;
  }

  /** Open a page, load the runtime and the plan, and wait until fonts and images are ready. */
  static async open(browser: Browser, plan: RenderPlan, html: string, logger?: Logger): Promise<PlanPage> {
    const context = await browser.newContext({
      viewport: { width: plan.width, height: plan.height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      locale: 'en-US',
      timezoneId: 'UTC',
      offline: true,
    });
    let instance: PlanPage | null = null;
    try {
      await context.route('**/*', (route) => {
        if (instance) instance.blocked++;
        return route.abort();
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      instance = new PlanPage(context, cdp);
      page.on('pageerror', (error) => instance?.errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') instance?.errors.push(message.text());
      });
      await page.setContent(html, { waitUntil: 'load' });
      // Fonts of scenes that are not visible yet would otherwise load late and flash in a frame.
      await page.evaluate(() => {
        const host = globalThis as unknown as BrowserGlobals;
        return Promise.all(Array.from(host.document.fonts, (face) => face.load())).then(() => undefined);
      });
      await within(
        page.evaluate((p) => (globalThis as unknown as BrowserGlobals).__MERGESTORY__.load(p), plan),
        LOAD_TIMEOUT_MS,
        'loading the render plan',
      );
      logger?.debug('Render page ready', { width: plan.width, height: plan.height });
      return instance;
    } catch (err) {
      await context.close().catch(() => undefined);
      if (err instanceof MergeStoryError) throw err;
      throw new MergeStoryError('RENDER_FAILED', 'The video runtime could not load the render plan.', {
        hint: 'Run "mergestory doctor" and try again. If it keeps failing, report the error with --debug output.',
        cause: err,
        details: { pageErrors: instance?.errors.slice(0, 3) ?? [] },
      });
    }
  }

  /** Requests the page tried to make (all were blocked). */
  get blockedRequests(): number {
    return this.blocked;
  }

  /** Errors the page reported (console errors and uncaught exceptions). */
  get pageErrors(): readonly string[] {
    return this.errors;
  }

  /** Show the frame at `timeSec`. Returns false only when the frame is identical to the previous seek's. */
  async seek(timeSec: number): Promise<boolean> {
    if (!Number.isFinite(timeSec))
      throw new MergeStoryError('INTERNAL', 'Cannot seek to a time that is not a number.');
    const response = (await within(
      this.cdp.send('Runtime.evaluate', {
        expression: `window.__MERGESTORY__.seek(${timeSec})`,
        returnByValue: true,
      }),
      COMMAND_TIMEOUT_MS,
      `showing the frame at ${timeSec.toFixed(2)} s`,
    )) as EvaluateResult;
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'unknown error';
      throw new MergeStoryError(
        'RENDER_FAILED',
        `The video runtime failed at ${timeSec.toFixed(2)} s: ${detail.split('\n')[0]}`,
        {
          hint: 'This is a bug in a scene template. Report it with the storyboard that triggered it.',
        },
      );
    }
    const value = response.result?.value as { dirty?: unknown } | undefined;
    return value?.dirty !== false;
  }

  /** Capture the current frame. */
  async capture(options: CaptureFormat): Promise<Buffer> {
    const { data } = await within(
      this.cdp.send('Page.captureScreenshot', options),
      COMMAND_TIMEOUT_MS,
      'capturing a frame',
    );
    return Buffer.from(data, 'base64');
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}
