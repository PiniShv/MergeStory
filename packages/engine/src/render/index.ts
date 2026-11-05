/** Rendering: RenderPlan -> MP4, through the browser runtime and FFmpeg. */
import type { Config } from '../core/config.ts';
import type { Renderer } from '../core/providers.ts';
import { type BrowserExecutable, locateBrowser } from './browser.ts';
import { ChromiumRenderer } from './chromium-renderer.ts';

export type { BrowserExecutable } from './browser.ts';
export { ChromiumRenderer } from './chromium-renderer.ts';

export function createRenderer(config: Config): Renderer {
  return new ChromiumRenderer(config);
}

/** Find a Chromium-family browser to render with. Throws BROWSER_NOT_FOUND with install hints. */
export async function resolveBrowserExecutable(config: Config): Promise<BrowserExecutable> {
  return locateBrowser(config);
}
