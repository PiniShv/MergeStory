/**
 * The watch page: one self-contained HTML file with the player, chapters, review checklist
 * and the evidence behind every narration line. No external scripts, fonts, images or
 * trackers; the content security policy only allows the asset origins and the page's own
 * inline style and script (pinned by hash).
 *
 * All text comes from a pull request or a model, so it is treated as hostile: cleaned,
 * length-capped and HTML-escaped, and links are only emitted for validated http(s) URLs.
 */
import { createHash } from 'node:crypto';
import { MergeStoryError } from '../core/errors.ts';
import type { AssetUrls } from '../core/providers.ts';
import type { Chapter } from '../core/types.ts';
import { contentTypeFor } from './content-types.ts';
import { SEVERITY_LABEL, severityOf, severityRank } from './severity.ts';
import {
  cleanText,
  escapeAttribute,
  escapeHtml,
  formatDate,
  formatDateTime,
  formatTimestamp,
  htmlText,
  safeAssetUrl,
  safeHttpUrl,
  shortSha,
} from './text.ts';
import type { EvidenceLink, WatchPageData } from './types.ts';

const MAX_CHAPTERS = 60;
const MAX_CHECKLIST = 40;
const MAX_CLAIMS = 400;
const MAX_EVIDENCE_PER_CLAIM = 12;
const MAX_UNCERTAINTIES = 20;

const VOICE_LABEL: Record<string, string> = {
  kokoro: 'Kokoro (local)',
  say: 'macOS say (local)',
  openai: 'OpenAI text to speech',
  elevenlabs: 'ElevenLabs',
  none: 'No narration (silent video)',
};

const CSS = String.raw`
:root{color-scheme:dark light;--bg:#05070d;--card:rgba(20,28,54,.72);--card-2:rgba(8,12,26,.55);--line:rgba(150,165,215,.16);--line-strong:rgba(150,165,215,.34);--text:#f4f6ff;--text-2:#cdd5ec;--muted:#98a3c2;--accent:#8c7bff;--accent-2:#39d2f2;--accent-soft:rgba(140,123,255,.16);--accent-2-soft:rgba(57,210,242,.12);--info:#60a5fa;--low:#3ddc97;--medium:#ffc861;--high:#ff6b81;--glow-a:rgba(140,123,255,.22);--glow-b:rgba(57,210,242,.12);--grid:rgba(150,165,215,.06);--title-a:#f4f6ff;--title-b:#c9c1ff;--title-c:#8fe9fb;--shadow:0 34px 80px -28px rgba(0,0,0,.8);--lift:0 24px 60px -40px rgba(0,0,0,.65);--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{--bg:#f3f5fb;--card:#fff;--card-2:#f4f6fc;--line:#dde2f0;--line-strong:#c2cae3;--text:#0b1020;--text-2:#29325a;--muted:#566083;--accent:#5a45ee;--accent-2:#08718c;--accent-soft:rgba(90,69,238,.09);--accent-2-soft:rgba(8,113,140,.09);--info:#2563eb;--low:#087a52;--medium:#8f5600;--high:#cf2c47;--glow-a:rgba(90,69,238,.1);--glow-b:rgba(8,113,140,.08);--grid:rgba(30,41,80,.05);--title-a:#0b1020;--title-b:#4a35d8;--title-c:#08718c;--shadow:0 28px 60px -30px rgba(25,35,80,.35);--lift:0 18px 44px -34px rgba(25,35,80,.35)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{position:relative;margin:0;min-height:100vh;font:16px/1.6 var(--font);color:var(--text-2);background:radial-gradient(1100px 520px at 12% -8%,var(--glow-a),transparent 62%),radial-gradient(900px 460px at 100% 0,var(--glow-b),transparent 58%),var(--bg);background-repeat:no-repeat;-webkit-font-smoothing:antialiased}
body::before{content:"";position:absolute;z-index:-1;inset:0 0 auto 0;height:620px;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(ellipse 70% 100% at 50% 0,#000 20%,transparent 78%);mask-image:radial-gradient(ellipse 70% 100% at 50% 0,#000 20%,transparent 78%);pointer-events:none}
.wrap{width:min(1200px,100% - 32px);margin-inline:auto}
a{color:var(--accent-2);text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent-2);outline-offset:3px;border-radius:6px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:16px;top:12px;z-index:5;padding:8px 12px;border-radius:8px;background:var(--card);color:var(--text)}
.top{border-bottom:1px solid var(--line)}
.bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 20px;padding:14px 0}
.brand{display:inline-flex;align-items:center;gap:10px;font-size:1.05rem;font-weight:750;letter-spacing:-.015em;color:var(--text)}
.logo{width:28px;height:28px}
.where{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;color:var(--muted);font:500 .9rem var(--mono)}
.pill{padding:3px 12px;border:1px solid color-mix(in srgb,var(--accent-2) 40%,transparent);border-radius:999px;background:var(--accent-2-soft);color:var(--accent-2);font:500 .82rem var(--mono);text-decoration:none}
a.pill:hover{background:color-mix(in srgb,var(--accent-2) 20%,transparent)}
main{padding:40px 0 28px}
main:focus{outline:none}
h1{margin:0 0 14px;max-width:30ch;color:var(--text);font-size:clamp(1.8rem,4vw,2.85rem);font-weight:780;line-height:1.1;letter-spacing:-.03em;text-wrap:balance;background:linear-gradient(92deg,var(--title-a) 8%,var(--title-b) 58%,var(--title-c) 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;padding-bottom:.06em}
h2{display:flex;align-items:center;gap:10px;margin:0 0 16px;color:var(--text);font-size:1.2rem;font-weight:700;letter-spacing:-.015em}
h2::before{content:"";flex:none;width:4px;height:1.05em;border-radius:2px;background:linear-gradient(180deg,var(--accent),var(--accent-2))}
.summary{max-width:70ch;margin:0 0 18px;color:var(--text-2);font-size:1.12rem;line-height:1.6}
.facts-inline{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 30px;padding:0;list-style:none;color:var(--muted);font-size:.9rem}
.facts-inline li{padding:3px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card)}
code{font-family:var(--mono);font-size:.88em}
.stage{display:grid;grid-template-columns:minmax(0,1fr);gap:22px;margin-bottom:30px}
@media (min-width:980px){.stage.has-chapters{grid-template-columns:minmax(0,1fr) 340px;align-items:stretch}.stage.has-chapters .chapters{max-height:none;contain:size layout;margin-bottom:0}}
.player{overflow:hidden;border-radius:18px;background:#000;box-shadow:var(--shadow),0 0 0 1px var(--line-strong)}
video{display:block;width:100%;aspect-ratio:16/9;background:#000}
.fallback{margin:0;padding:16px;color:#cdd5ec}
.file-link{margin:12px 4px 0;font-size:.9rem}
.card{margin-bottom:22px;padding:24px 26px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,0) 55%),var(--card);box-shadow:var(--lift)}
.chapters{max-height:min(70vh,520px);margin:0;padding:20px 12px 12px;overflow:auto}
.chapters h2{padding:0 14px}
.chapters ol{display:grid;gap:2px;margin:0;padding:0;list-style:none}
.chapter{display:grid;grid-template-columns:auto 1fr;align-items:baseline;gap:12px;width:100%;padding:10px 14px;border:0;border-radius:11px;background:none;color:var(--text-2);font:inherit;line-height:1.35;text-align:left;cursor:pointer;transition:background .15s}
.chapter:hover{background:var(--accent-soft)}
.chapter:focus-visible{outline:2px solid var(--accent-2);outline-offset:-2px}
.chapter[aria-current=true]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent);color:var(--text);font-weight:600}
.t{min-width:3.2ch;color:var(--accent-2);font:600 .84rem var(--mono)}
.checks{display:grid;gap:10px;margin:0;padding:0;list-style:none}
.check{--sev:var(--info);display:grid;grid-template-columns:auto 1fr;gap:14px;padding:14px 16px 14px 14px;border:1px solid var(--line);border-left:3px solid var(--sev);border-radius:12px;background:var(--card-2)}
.sev-high{--sev:var(--high)}
.sev-medium{--sev:var(--medium)}
.sev-low{--sev:var(--low)}
.check input{appearance:none;-webkit-appearance:none;display:grid;place-content:center;width:22px;height:22px;margin:2px 0 0;border:2px solid var(--line-strong);border-radius:7px;background:var(--card);cursor:pointer;transition:background .15s,border-color .15s}
.check input::after{content:"";width:11px;height:6px;border-bottom:2.5px solid #fff;border-left:2.5px solid #fff;transform:translateY(-1px) rotate(-45deg) scale(0);transition:transform .12s}
.check input:checked{border-color:var(--accent);background:var(--accent)}
.check input:checked::after{transform:translateY(-1px) rotate(-45deg) scale(1)}
.check input:checked+div .line strong{opacity:.6;text-decoration:line-through;text-decoration-thickness:2px}
.line{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.line strong{color:var(--text);font-size:1.05rem;letter-spacing:-.01em}
.sev{padding:2px 10px;border:1px solid color-mix(in srgb,var(--sev) 55%,transparent);border-radius:999px;background:color-mix(in srgb,var(--sev) 14%,transparent);color:var(--sev);font:750 .72rem var(--font);letter-spacing:.08em;text-transform:uppercase}
.check p{margin:6px 0 0}
.check .ref{margin-top:10px}
.stat{margin:0 0 2px;color:var(--text);font-size:1.05rem}
.stat strong{color:var(--accent-2);font-size:2rem;font-weight:750;letter-spacing:-.03em}
.meter{display:block;width:100%;height:8px;margin:10px 0 16px;border:0;border-radius:999px;overflow:hidden;appearance:none;-webkit-appearance:none;background:var(--line)}
.meter::-webkit-progress-bar{border-radius:999px;background:var(--line)}
.meter::-webkit-progress-value{border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.meter::-moz-progress-bar{border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.muted{margin:0 0 16px;color:var(--muted);font-size:.95rem}
details{margin-top:8px;border:1px solid var(--line);border-radius:12px;background:var(--card-2)}
summary{display:flex;align-items:center;gap:12px;padding:12px 16px;color:var(--text);font-weight:600;cursor:pointer;list-style:none;border-radius:12px}
summary:hover{background:var(--accent-soft)}
summary::-webkit-details-marker{display:none}
summary::before{content:"";flex:none;width:7px;height:7px;margin:0 3px 0 2px;border-right:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(-45deg);transition:transform .15s}
details[open]>summary{border-bottom:1px solid var(--line);border-bottom-left-radius:0;border-bottom-right-radius:0}
details[open]>summary::before{transform:rotate(45deg)}
.count{margin-left:auto;padding:1px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:.8rem;font-weight:500;white-space:nowrap}
.claims{display:grid;gap:14px;margin:0;padding:16px 18px 18px;list-style:none}
.claims li{padding-left:14px;border-left:2px solid color-mix(in srgb,var(--accent) 55%,transparent);color:var(--text-2)}
.ev{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{padding:2px 9px;border:1px solid color-mix(in srgb,var(--accent-2) 32%,transparent);border-radius:8px;background:var(--accent-2-soft);color:var(--text-2);font:500 .78rem var(--mono);text-decoration:none;overflow-wrap:anywhere}
a.chip{color:var(--accent-2)}
a.chip:hover{background:color-mix(in srgb,var(--accent-2) 22%,transparent)}
.none{display:inline-block;margin-top:8px;padding:1px 9px;border:1px dashed color-mix(in srgb,var(--medium) 60%,transparent);border-radius:8px;color:var(--medium);font-size:.8rem}
.plain{margin:0;padding-left:20px}
.plain li{margin:6px 0}
.warn{border-left:3px solid var(--medium)}
.note{margin-bottom:22px;padding:15px 18px;border-left:3px solid var(--accent);border-radius:8px 14px 14px 8px;background:var(--accent-soft);color:var(--text-2)}
.note strong{color:var(--text)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px;margin:0}
.facts dt{color:var(--muted);font-size:.76rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase}
.facts dd{margin:3px 0 0;color:var(--text)}
footer{padding:24px 0 48px;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}
footer p{margin:0 0 6px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:759px){.chapters{max-height:none;padding:18px 0 14px;overflow:visible}.chapters h2{padding:0 18px}.chapters ol{display:flex;gap:8px;padding:2px 40px 6px 18px;overflow-x:auto;scroll-snap-type:x proximity;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent)}.chapter{flex:none;width:auto;padding:7px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card-2);white-space:nowrap;scroll-snap-align:start}.chapter[aria-current=true]{border-color:var(--accent);box-shadow:none}}
@media (max-width:560px){.card{padding:18px 16px}main{padding-top:26px}h2{font-size:1.1rem}.summary{font-size:1.04rem}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (forced-colors:active){h1{-webkit-text-fill-color:currentColor;background:none}}
`.trim();

const SCRIPT = String.raw`
(function () {
  var video = document.getElementById('v');
  if (!video) return;
  var data = document.getElementById('cues');
  if (data) {
    try {
      var list = JSON.parse(data.textContent);
      var track = video.addTextTrack('captions', data.getAttribute('data-label') || 'Captions', data.getAttribute('data-lang') || 'en');
      list.forEach(function (c) { track.addCue(new VTTCue(c[0], c[1], c[2])); });
      if (data.getAttribute('data-show') === 'true') track.mode = 'showing';
    } catch (e) {}
  }
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.chapter'));
  if (!buttons.length) return;
  var starts = buttons.map(function (b) { return Number(b.getAttribute('data-start')) || 0; });
  var current = -1;
  // Keep the playing chapter in view inside the list (or strip), without moving the page.
  function reveal(b) {
    var p = b.parentElement;
    while (p && p !== document.body) {
      var st = getComputedStyle(p);
      var y = /(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 1;
      var x = /(auto|scroll)/.test(st.overflowX) && p.scrollWidth > p.clientWidth + 1;
      if (y || x) {
        var pr = p.getBoundingClientRect(), br = b.getBoundingClientRect();
        if (y && br.top < pr.top) p.scrollTop -= pr.top - br.top + 8;
        else if (y && br.bottom > pr.bottom) p.scrollTop += br.bottom - pr.bottom + 8;
        if (x && br.left < pr.left) p.scrollLeft -= pr.left - br.left + 8;
        else if (x && br.right > pr.right) p.scrollLeft += br.right - pr.right + 8;
      }
      p = p.parentElement;
    }
  }
  function mark() {
    var t = video.currentTime, index = 0, i;
    for (i = 0; i < starts.length; i++) if (starts[i] <= t + 0.25) index = i;
    if (index === current) return;
    current = index;
    buttons.forEach(function (b, n) {
      if (n === index) { b.setAttribute('aria-current', 'true'); reveal(b); } else b.removeAttribute('aria-current');
    });
  }
  buttons.forEach(function (b, n) {
    b.addEventListener('click', function () {
      video.currentTime = starts[n];
      var started = video.play();
      if (started && started.catch) started.catch(function () {});
      mark();
    });
  });
  video.addEventListener('timeupdate', mark);
  video.addEventListener('seeked', mark);
  var at = /[#&]t=(\d+(?:\.\d+)?)/.exec(location.hash);
  if (at) video.addEventListener('loadedmetadata', function () { video.currentTime = Number(at[1]); mark(); }, { once: true });
  mark();
})();
`.trim();

const LOGO = [
  '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">',
  '<defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8c7bff"/><stop offset="1" stop-color="#39d2f2"/></linearGradient></defs>',
  '<rect width="32" height="32" rx="8" fill="url(#lg)"/>',
  '<path d="M12 9.5v13l11-6.5z" fill="#fff"/>',
  '</svg>',
].join('');

function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

function invalidAsset(what: string): MergeStoryError {
  return new MergeStoryError('PUBLISH_FAILED', `The watch page was given an invalid ${what} URL.`, {
    hint: 'Asset links must be http(s) URLs or plain relative file names.',
  });
}

function requiredAssetUrl(value: string | null | undefined, what: string): string {
  const safe = safeAssetUrl(value);
  if (!safe) throw invalidAsset(what);
  return safe;
}

function optionalAssetUrl(value: string | null | undefined, what: string): string | null {
  return value === null || value === undefined || value === '' ? null : requiredAssetUrl(value, what);
}

/** Language code and visible name of the caption track. Anything unusable falls back to English. */
function captionLanguage(code: string | undefined): { srclang: string; label: string } {
  const tag = typeof code === 'string' ? code.trim() : '';
  if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(tag)) {
    try {
      const label = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
      if (label && label !== tag) return { srclang: tag, label };
    } catch {
      // The runtime does not know this tag.
    }
  }
  return { srclang: 'en', label: 'English' };
}

const MAX_CUES = 2000;

/** Valid caption cues as [start, end, text] triples; anything malformed is dropped. */
function validCues(cues: unknown): [number, number, string][] {
  if (!Array.isArray(cues)) return [];
  const out: [number, number, string][] = [];
  for (const cue of cues.slice(0, MAX_CUES)) {
    if (!cue || typeof cue !== 'object') continue;
    const { startSec, endSec, text } = cue as { startSec?: unknown; endSec?: unknown; text?: unknown };
    if (typeof startSec !== 'number' || typeof endSec !== 'number' || typeof text !== 'string') continue;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec)
      continue;
    const line = cleanText(text, 400);
    if (line) out.push([Math.round(startSec * 1000) / 1000, Math.round(endSec * 1000) / 1000, line]);
  }
  return out;
}

/** JSON that is safe inside a script element: nothing in it can close the element or open a comment. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The CSP source for one asset: its origin, or 'self' for a relative file name. */
function sourceOf(url: string): string {
  return /^https?:/i.test(url) ? new URL(url).origin : "'self'";
}

function sourceList(urls: (string | null)[]): string {
  const sources = [...new Set(urls.filter((u): u is string => u !== null).map(sourceOf))];
  return sources.length > 0 ? sources.join(' ') : "'none'";
}

function videoType(url: string): string {
  const path = /^https?:/i.test(url) ? new URL(url).pathname : url;
  const type = contentTypeFor(path);
  return type.startsWith('video/') ? type : 'video/mp4';
}

/** A link for a validated http(s) URL, or plain text when the URL is missing or unsafe. */
function linkOrText(label: unknown, url: unknown, className: string): string {
  const text = escapeHtml(cleanText(label, 120)) || 'link';
  const cls = className ? ` class="${className}"` : '';
  const href = safeHttpUrl(url);
  if (!href) return `<span${cls}>${text}</span>`;
  return `<a${cls} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function renderChapters(chapters: Chapter[]): string {
  const items = (Array.isArray(chapters) ? chapters : [])
    .filter((c) => c && typeof c.startSec === 'number' && Number.isFinite(c.startSec))
    .map((c) => ({ title: cleanText(c.title, 120), startSec: Math.max(0, c.startSec) }))
    .sort((a, b) => a.startSec - b.startSec)
    .slice(0, MAX_CHAPTERS);
  if (items.length === 0) return '';
  const rows = items.map((c, i) => {
    const start = Math.round(c.startSec * 10) / 10;
    const title = escapeHtml(c.title || `Chapter ${i + 1}`);
    return `<li><button type="button" class="chapter" data-start="${start}"><span class="t">${formatTimestamp(c.startSec)}</span><span>${title}</span></button></li>`;
  });
  return `<nav class="card chapters" aria-labelledby="h-chapters"><h2 id="h-chapters">Chapters</h2><ol>${rows.join('')}</ol></nav>`;
}

function renderChecklist(checklist: WatchPageData['checklist']): string {
  const items = (Array.isArray(checklist) ? checklist : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, order) => ({ item, order, severity: severityOf(item.severity) }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.order - b.order)
    .slice(0, MAX_CHECKLIST);
  const body =
    items.length === 0
      ? '<p class="muted">MergeStory did not flag anything specific. Review the change as usual.</p>'
      : `<ul class="checks">${items
          .map(({ item, severity }, i) => {
            const title = htmlText(item.title, 160) || 'Review item';
            const detail = htmlText(item.detail, 600);
            const ref = item.ref
              ? `<p class="ref">${linkOrText(item.ref.label, item.ref.url, 'chip')}</p>`
              : '';
            return (
              `<li class="check sev-${severity}"><input type="checkbox" id="rv${i}" aria-labelledby="rv${i}-t">` +
              `<div><div class="line"><span class="sev">${SEVERITY_LABEL[severity]}</span><strong id="rv${i}-t">${title}</strong></div>` +
              `${detail ? `<p>${detail}</p>` : ''}${ref}</div></li>`
            );
          })
          .join('')}</ul>`;
  return `<section class="card" aria-labelledby="h-review"><h2 id="h-review">What to review</h2>${body}</section>`;
}

function renderEvidence(evidence: EvidenceLink[]): string {
  const links = (Array.isArray(evidence) ? evidence : []).filter((e) => e && typeof e === 'object');
  if (links.length === 0) return '<span class="none">No evidence cited</span>';
  const shown = links.slice(0, MAX_EVIDENCE_PER_CLAIM).map((e) => linkOrText(e.label, e.url, 'chip'));
  const more = links.length - shown.length;
  if (more > 0) shown.push(`<span class="chip">+${more} more</span>`);
  return `<span class="ev">${shown.join('')}</span>`;
}

function renderTrust(claims: WatchPageData['claims']): string {
  const all = (Array.isArray(claims) ? claims : []).filter((c) => c && typeof c === 'object');
  const grounded = all.filter((c) => Array.isArray(c.evidence) && c.evidence.length > 0).length;
  if (all.length === 0) {
    return (
      '<section class="card" aria-labelledby="h-trust"><h2 id="h-trust">Why you can trust this video</h2>' +
      '<p class="muted">The narration lines and their evidence are not listed for this video.</p></section>'
    );
  }
  const groups = new Map<string, string[]>();
  for (const claim of all.slice(0, MAX_CLAIMS)) {
    const chapter = cleanText(claim.chapter, 120) || 'Other';
    const row = `<li><span>${htmlText(claim.text, 500)}</span> ${renderEvidence(claim.evidence)}</li>`;
    const rows = groups.get(chapter);
    if (rows) rows.push(row);
    else groups.set(chapter, [row]);
  }
  const details = [...groups]
    .map(
      ([chapter, rows]) =>
        `<details><summary>${escapeHtml(chapter)}<span class="count">${rows.length} ${rows.length === 1 ? 'line' : 'lines'}</span></summary><ul class="claims">${rows.join('')}</ul></details>`,
    )
    .join('');
  const hidden = all.length - Math.min(all.length, MAX_CLAIMS);
  const single = all.length === 1;
  return (
    '<section class="card" aria-labelledby="h-trust"><h2 id="h-trust">Why you can trust this video</h2>' +
    `<p class="stat"><strong>${grounded} of ${all.length}</strong> narration ${single ? 'line cites' : 'lines cite'} evidence from the change.</p>` +
    `<progress class="meter" max="${all.length}" value="${grounded}" aria-hidden="true"></progress>` +
    '<p class="muted">Each line points at files, hunks, symbols, commits or tests of this change, and MergeStory checks every reference before it renders the video. Open a chapter to see what its lines rely on.</p>' +
    `${details}${hidden > 0 ? `<p class="muted">${hidden} more lines are not shown.</p>` : ''}</section>`
  );
}

function renderUncertainties(items: string[]): string {
  const list = (Array.isArray(items) ? items : [])
    .map((u) => cleanText(u, 400))
    .filter(Boolean)
    .slice(0, MAX_UNCERTAINTIES);
  if (list.length === 0) return '';
  return (
    '<section class="card warn" aria-labelledby="h-unsure"><h2 id="h-unsure">What the video could not confirm</h2>' +
    `<ul class="plain">${list.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul></section>`
  );
}

function storyboardLine(data: WatchPageData): string {
  if (data.storyboardSource === 'llm') {
    const model = cleanText(data.generator?.llm, 80);
    return model ? `Written by the language model ${model}.` : 'Written by a language model.';
  }
  if (data.storyboardSource === 'agent') return 'Written by a coding agent.';
  return 'Built offline from the diff, without a language model.';
}

function renderMade(data: WatchPageData): string {
  const voiceId = cleanText(data.generator?.tts, 40);
  const voice = VOICE_LABEL[voiceId] ?? voiceId;
  const date = formatDate(data.generatedAt);
  const sha = shortSha(data.headSha);
  const rows: [string, string][] = [['Storyboard', escapeHtml(storyboardLine(data))]];
  if (voice) rows.push(['Voice', escapeHtml(voice)]);
  if (date) rows.push(['Generated', escapeHtml(date)]);
  if (sha) rows.push(['Commit', `<code>${sha}</code>`]);
  return (
    '<section class="card" aria-labelledby="h-made"><h2 id="h-made">How it was made</h2>' +
    `<dl class="facts">${rows.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl></section>`
  );
}

function contentSecurityPolicy(media: string, images: string, styleHash: string, scriptHash: string): string {
  return [
    "default-src 'none'",
    `img-src ${images}`,
    `media-src ${media}`,
    `style-src 'sha256-${styleHash}'`,
    `script-src 'sha256-${scriptHash}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Self-contained HTML page: no external scripts, fonts or trackers; all text escaped. */
export function buildWatchPage(data: WatchPageData, urls: AssetUrls): string {
  const video = requiredAssetUrl(urls.video, 'video');
  const poster = optionalAssetUrl(urls.poster, 'poster');
  const captions = optionalAssetUrl(urls.captions, 'captions');
  const expires = formatDateTime(urls.linkExpiresAt);

  const title = htmlText(data.title, 200) || 'Untitled change';
  const summary = htmlText(data.summary, 1200);
  const version = htmlText(data.engineVersion, 24);
  const sha = shortSha(data.headSha);
  const length =
    Number.isFinite(data.durationSec) && data.durationSec > 0 ? formatTimestamp(data.durationSec) : null;
  const changeLabel = linkOrText(data.changeLabel, data.changeUrl, 'pill');
  const chapters = renderChapters(data.chapters);

  const csp = contentSecurityPolicy(
    sourceList([video, captions]),
    sourceList([poster]),
    sha256Base64(CSS),
    sha256Base64(SCRIPT),
  );

  const language = captionLanguage(data.language);
  const showCaptions = data.captionsDefault !== false;
  // A page opened from disk cannot load a separate caption file, so it carries the cues itself.
  const cues = captions ? validCues(urls.captionCues) : [];
  const track =
    captions && cues.length === 0
      ? `<track kind="captions" srclang="${language.srclang}" label="${escapeHtml(language.label)}" src="${escapeHtml(captions)}"${showCaptions ? ' default' : ''}>`
      : '';
  const cueData =
    cues.length > 0
      ? `<script type="application/json" id="cues" data-lang="${language.srclang}" data-label="${escapeHtml(language.label)}" data-show="${showCaptions}">${jsonForScript(cues)}</script>`
      : '';
  const facts = [length ? `<li>Length ${length}</li>` : '', sha ? `<li>Commit <code>${sha}</code></li>` : '']
    .filter(Boolean)
    .join('');

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    `<meta name="generator" content="MergeStory ${version}">`,
    `<title>${title} - MergeStory</title>`,
    `<style>${CSS}</style>`,
  ].join('\n');

  const body = [
    '<a class="skip" href="#main">Skip to the video</a>',
    `<header class="top"><div class="wrap bar"><span class="brand">${LOGO}<span>MergeStory</span></span>` +
      `<span class="where"><span>${htmlText(data.repoLabel, 120)}</span>${changeLabel}</span></div></header>`,
    '<main id="main" class="wrap" tabindex="-1">',
    `<h1>${title}</h1>`,
    summary ? `<p class="summary">${summary}</p>` : '',
    facts ? `<ul class="facts-inline">${facts}</ul>` : '',
    `<div class="stage${chapters ? ' has-chapters' : ''}"><div>`,
    `<div class="player"><video id="v" controls playsinline preload="metadata"${poster ? ` poster="${escapeHtml(poster)}"` : ''} aria-label="Video walkthrough of the change">`,
    `<source src="${escapeHtml(video)}" type="${videoType(video)}">`,
    track,
    `<p class="fallback">Your browser cannot play this video. <a href="${escapeHtml(video)}">Open the video file</a>.</p>`,
    '</video></div>',
    `<p class="file-link"><a href="${escapeHtml(video)}">Open the video file</a></p>`,
    `</div>${chapters}</div>`,
    renderChecklist(data.checklist),
    renderTrust(data.claims),
    renderUncertainties(data.uncertainties),
    data.hasSimulatedVisuals
      ? '<div class="note" role="note"><strong>Some visuals are simulated.</strong> They are labelled as such on screen. They illustrate how parts of the change fit together and are not recordings of the running application.</div>'
      : '',
    renderMade(data),
    '</main>',
    '<footer><div class="wrap">',
    `<p>Made with MergeStory ${version} - every change has a story. The video explains the change; it does not replace code review.</p>`,
    expires ? `<p>This link expires on ${escapeHtml(expires)}.</p>` : '',
    '</div></footer>',
    cueData,
    `<script>${SCRIPT}</script>`,
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}
