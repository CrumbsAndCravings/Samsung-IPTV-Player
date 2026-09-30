// A tiny DOM helper instead of a UI framework.

type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  attrs?: { [name: string]: string };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.attrs) for (const name of Object.keys(props.attrs)) el.setAttribute(name, props.attrs[name]);
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

// Removes every child (Element.replaceChildren needs Chromium 86).
export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function toggle(el: Element, className: string, on: boolean): void {
  if (el.classList.contains(className) !== on) el.classList.toggle(className, on);
}
