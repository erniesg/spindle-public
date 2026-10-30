// Native-DOM primitives for spindleUiCss. They only create elements, set text and
// classes; callers own events, data, timers and navigation. Text is never parsed as HTML.
export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type StatusState = 'idle' | 'loading' | 'success' | 'error';
export type Content = Node | string;

export interface ButtonOptions {variant?: ButtonVariant; type?: 'button' | 'submit'; disabled?: boolean}
export interface TextFieldOptions {
  name: string;
  type?: 'text' | 'password' | 'email' | 'url';
  autocomplete?: string;
  value?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  minLength?: number;
  maxLength?: number;
}
export interface TextField {root: HTMLDivElement; input: HTMLInputElement}

let nextId = 0;
const id = (kind: string) => `sp-${kind}-${++nextId}`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A themed button. Defaults to type="button" so it never submits a form by accident. */
export function button(label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const node = element('button', 'sp-button', label);
  node.type = options.type ?? 'button';
  node.dataset.variant = options.variant ?? 'secondary';
  node.disabled = options.disabled ?? false;
  return node;
}

/** A visible label programmatically tied to a text/password input, plus an optional hint. */
export function textField(label: string, options: TextFieldOptions): TextField {
  const root = element('div', 'sp-text-field');
  const input = element('input', 'sp-field');
  const caption = element('label', 'sp-label', label);
  input.id = id('field');
  caption.htmlFor = input.id;
  input.type = options.type ?? 'text';
  input.name = options.name;
  if (options.autocomplete !== undefined) input.autocomplete = options.autocomplete as AutoFill;
  if (options.value !== undefined) input.value = options.value;
  if (options.minLength !== undefined) input.minLength = options.minLength;
  if (options.maxLength !== undefined) input.maxLength = options.maxLength;
  input.required = options.required ?? false;
  input.disabled = options.disabled ?? false;
  root.append(caption, input);
  if (options.hint !== undefined) {
    const hint = element('p', 'sp-hint', options.hint);
    hint.id = id('hint');
    input.setAttribute('aria-describedby', hint.id);
    root.append(hint);
  }
  return {root, input};
}

/** A bordered surface. A title becomes its heading and accessible name. */
export function card(title: string | undefined, ...children: Content[]): HTMLElement {
  const root = element('section', 'sp-card');
  if (title !== undefined) {
    const heading = element('h2', 'sp-card-title', title);
    heading.id = id('card');
    root.setAttribute('aria-labelledby', heading.id);
    root.append(heading);
  }
  root.append(...children);
  return root;
}

/** A polite live region for status, loading and error text. Update it with setStatus. */
export function statusRegion(state: StatusState = 'idle', message = ''): HTMLParagraphElement {
  const node = element('p', 'sp-status');
  node.setAttribute('role', 'status');
  setStatus(node, state, message);
  return node;
}

export function setStatus(region: HTMLElement, state: StatusState, message: string): void {
  region.dataset.state = state;
  region.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
  region.textContent = message;
}
