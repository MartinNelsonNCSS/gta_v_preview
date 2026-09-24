import type { HostToWebview, WebviewToHost } from '../shared/model';

// ---------------------------------------------------------------------------
// Host messaging
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();

type Listener = (m: HostToWebview) => void;
const listeners = new Set<Listener>();
window.addEventListener('message', (e: MessageEvent<HostToWebview>) => listeners.forEach((l) => l(e.data)));

export function onHostMessage(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let nextRequestId = 1;
export function newRequestId(): number {
  return nextRequestId++;
}

type Reply<T extends HostToWebview['type']> = Extract<HostToWebview, { type: T; requestId: number }>;

/** Sends a request and resolves with the host's single reply of type `reply`. */
export function hostRequest<T extends HostToWebview['type']>(
  message: Extract<WebviewToHost, { requestId: number }>,
  reply: T
): Promise<Reply<T>> {
  return new Promise((resolve) => {
    const off = onHostMessage((m) => {
      if (m.type === reply && (m as { requestId?: number }).requestId === message.requestId) {
        off();
        resolve(m as Reply<T>);
      }
    });
    vscode.postMessage(message);
  });
}

/** Persisted per-editor UI preferences (toggles etc). */
export function pref<T>(key: string, fallback: T): T {
  const v = vscode.getState()?.[key];
  return v === undefined ? fallback : (v as T);
}
export function setPref(key: string, value: unknown): void {
  vscode.setState({ ...(vscode.getState() ?? {}), [key]: value });
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript: h('div', { class: 'x', onclick }, 'text', child) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k in el && k !== 'style' && k !== 'class') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k === 'class' ? 'class' : k, String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function checkbox(label: string, key: string, initial: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const value = pref(key, initial);
  const input = h('input', {
    type: 'checkbox',
    checked: value,
    onchange: () => {
      setPref(key, input.checked);
      onChange(input.checked);
    },
  });
  return h('label', { class: 'toggle' }, input, label);
}

export function select<T extends string>(
  options: { value: T; label: string; disabled?: boolean }[],
  value: T,
  onChange: (v: T) => void
): HTMLSelectElement {
  const el = h(
    'select',
    { onchange: () => onChange(el.value as T) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value, disabled: o.disabled }, o.label))
  );
  return el;
}

export function fmt(n: number, digits = 2): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(digits);
}

export function errorView(message: string): HTMLElement {
  return h('div', { class: 'error-view' }, h('div', { class: 'error-title' }, 'Unable to preview this file'), h('div', null, message));
}

/**
 * "Cut" slider: hides geometry above the chosen height. `range` is read
 * lazily so it reflects content that loads after the slider is created.
 */
export function cutSlider(range: () => { min: number; max: number } | undefined, onChange: (z: number | null) => void): HTMLElement {
  const input = h('input', { type: 'range', min: 0, max: 1000, value: 1000, class: 'cut-slider', title: 'Cut height: hide everything above this level' });
  input.addEventListener('input', () => {
    const r = range();
    const t = Number(input.value) / 1000;
    onChange(!r || t >= 1 ? null : r.min + (r.max - r.min) * t);
  });
  return h('label', { class: 'toggle' }, 'Cut', input);
}
