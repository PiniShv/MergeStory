/** playwright-core is large, so it is loaded the first time a browser is needed. */
import type * as PlaywrightCore from 'playwright-core';

let loaded: Promise<typeof PlaywrightCore> | null = null;

export function loadPlaywright(): Promise<typeof PlaywrightCore> {
  loaded ??= import('playwright-core');
  return loaded;
}
