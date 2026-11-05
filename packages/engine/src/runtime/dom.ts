/** Tiny DOM builders. Text is always set with textContent, never parsed as HTML. */

type Child = Node | string | number | null | undefined | false;

export interface ElementProps {
  class?: string;
  style?: Partial<Record<string, string>>;
  attrs?: Record<string, string>;
  text?: string;
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(
      typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child,
    );
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.style)
    for (const [k, v] of Object.entries(props.style)) if (v !== undefined) el.style.setProperty(k, v);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

/** Register a stylesheet once (templates call this at module load). */
const registered = new Set<string>();
export function css(id: string, text: string): void {
  if (registered.has(id)) return;
  registered.add(id);
  const style = document.createElement('style');
  style.dataset.ms = id;
  style.textContent = text;
  document.head.append(style);
}
