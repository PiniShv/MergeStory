import type { Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { RenderPlan } from '../core/render-plan.ts';
import { FONT_FACES, fontFacesCss } from './fonts.ts';
import { buildPageHtml, escapeInlineScript, PAGE_CSP, PlanPage } from './page.ts';
import { loadRuntimeBundle } from './runtime-bundle.ts';

describe('escapeInlineScript', () => {
  it('stops a script from closing its own element', () => {
    expect(escapeInlineScript('a</script>b</SCRIPT >c')).toBe('a<\\/script>b<\\/SCRIPT >c');
    expect(escapeInlineScript('no end tag here')).toBe('no end tag here');
  });
});

describe('buildPageHtml', () => {
  const html = buildPageHtml({
    runtimeJs: 'window.x = "</script><b>";',
    fontsCss: '@font-face{font-family:"T";}',
  });

  it('has a content security policy that allows no network access', () => {
    expect(PAGE_CSP).toBe(
      "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    );
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('inlines the fonts and the runtime, with the script end tag escaped', () => {
    expect(html).toContain('<style>@font-face{font-family:"T";}</style>');
    expect(html).toContain('window.x = "<\\/script><b>";');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});

describe('fontFacesCss', () => {
  it('embeds every bundled face as a data URL and reads them only once', async () => {
    const css = await fontFacesCss();
    expect(FONT_FACES).toHaveLength(8);
    expect(css.match(/@font-face/g)).toHaveLength(8);
    for (const weight of [400, 500, 600, 700, 800])
      expect(css).toContain(`font-family:'Inter';font-weight:${weight}`);
    for (const weight of [400, 500, 700])
      expect(css).toContain(`font-family:'JetBrains Mono';font-weight:${weight}`);
    expect(css.match(/src:url\(data:font\/woff2;base64,/g)).toHaveLength(8);
    expect(css).not.toMatch(/url\((?!data:)/);
    expect(fontFacesCss()).toBe(fontFacesCss());
  });
});

describe('loadRuntimeBundle', () => {
  it('returns the runtime script, defined on window.__MERGESTORY__', async () => {
    const script = await loadRuntimeBundle();
    expect(script).toContain('__MERGESTORY__');
    expect(script.length).toBeGreaterThan(1000);
    expect(await loadRuntimeBundle()).toBe(script);
  });
});

describe('PlanPage.open', () => {
  it('opens every plan offline and blocks every request, whatever its theme', async () => {
    let contextOptions: unknown;
    let routed: unknown;
    const context = {
      route: async (pattern: unknown) => {
        routed = pattern;
      },
      newPage: async () => {
        throw new Error('stop once the context is set up');
      },
      close: async () => undefined,
    };
    const browser = {
      newContext: async (options: unknown) => {
        contextOptions = options;
        return context;
      },
    } as unknown as Browser;
    const plan = {
      width: 640,
      height: 360,
      theme: 'dark',
      colors: { accent: '#ff8800' },
    } as unknown as RenderPlan;
    await expect(PlanPage.open(browser, plan, '<!doctype html>')).rejects.toThrow();
    expect(contextOptions).toMatchObject({ offline: true, serviceWorkers: 'block' });
    expect(routed).toBe('**/*');
  });
});
