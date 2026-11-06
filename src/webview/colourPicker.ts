import { h } from './ui';

/*
 * A colour picker that works in sRGB (the colour space game textures use),
 * with Hex, RGB and HSB fields. The browser's own <input type="color"> opens
 * the operating system's picker; on macOS that one's sliders work in Display
 * P3 or Generic RGB and the result is converted to sRGB, so the numbers typed
 * there aren't the numbers that end up in the texture.
 *
 * `colourInput` is a drop-in for <input type="color">: a button whose `value`
 * is "#rrggbb", firing "input" while the colour changes and "change" when the
 * picker closes.
 */

export interface Hsb {
  h: number;
  s: number;
  b: number;
}

/** "#rrggbb" → [r, g, b] (0–255). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** RGB (0–255) → HSB (h 0–360, s and b 0–100), unrounded. */
export function rgbToHsb(r: number, g: number, b: number): Hsb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max ? (d / max) * 100 : 0, b: (max / 255) * 100 };
}

/** HSB → RGB, rounded to whole 0–255 values. */
export function hsbToRgb({ h: hue, s, b }: Hsb): [number, number, number] {
  const v = b / 100;
  const c = v * (s / 100);
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, bl] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return [r, g, bl].map((t) => Math.round((t + m) * 255)) as [number, number, number];
}

function normalHex(text: string): string | undefined {
  const t = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(t)) return `#${[...t.toLowerCase()].map((c) => c + c).join('')}`;
  return undefined;
}

/** A colour button that opens the sRGB picker. Use like <input type="color">. */
export function colourInput(value: string, title = 'Colour'): HTMLButtonElement {
  const button = h('button', { type: 'button', class: 'colour-input', title });
  let current = normalHex(value) ?? '#000000';
  const paint = () => {
    button.style.background = current;
    button.title = `${title} (${current})`;
  };
  Object.defineProperty(button, 'value', {
    get: () => current,
    set: (v: string) => {
      current = normalHex(String(v)) ?? current;
      paint();
      if (open?.button === button) open.sync();
    },
  });
  paint();
  button.addEventListener('click', (e) => {
    e.preventDefault();
    if (open?.button === button) close();
    else openPicker(button, title);
  });
  return button;
}

interface Open {
  button: HTMLButtonElement;
  el: HTMLElement;
  sync(): void;
  changed: boolean;
}

let open: Open | undefined;

function close(): void {
  if (!open) return;
  const o = open;
  open = undefined;
  o.el.remove();
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', escape, true);
  o.button.classList.remove('open');
  if (o.changed) o.button.dispatchEvent(new Event('change', { bubbles: true }));
}

function outside(e: Event): void {
  if (open && !open.el.contains(e.target as Node) && e.target !== open.button) close();
}

function escape(e: KeyboardEvent): void {
  if (open && (e.key === 'Escape' || (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT'))) {
    e.stopPropagation();
    e.preventDefault();
    const b = open.button;
    close();
    b.focus();
  }
}

function openPicker(button: HTMLButtonElement, title: string): void {
  close();
  const before = button.value;
  // HSB is kept as typed (not recomputed from the rounded RGB), so the fields don't jump while editing.
  let hsb = rgbToHsb(...hexToRgb(before));

  const svDot = h('div', { class: 'colour-sv-dot' });
  const sv = h('div', { class: 'colour-sv' }, svDot);
  const hueDot = h('div', { class: 'colour-hue-dot' });
  const hue = h('div', { class: 'colour-hue' }, hueDot);
  const oldSwatch = h('button', { type: 'button', class: 'colour-was', title: `Back to ${before}`, style: `background:${before}` });
  const newSwatch = h('div', { class: 'colour-now' });
  const hex = h('input', { type: 'text', class: 'colour-hex', maxlength: 7, title: 'Hex (sRGB)' });
  hex.spellcheck = false;
  const num = (label: string, max: number, tip: string) => {
    const input = h('input', { type: 'number', min: 0, max, step: 1, title: tip });
    return { input, el: h('label', { class: 'colour-num' }, h('span', null, label), input) };
  };
  const R = num('R', 255, 'Red (0–255)');
  const G = num('G', 255, 'Green (0–255)');
  const B = num('B', 255, 'Blue (0–255)');
  const H = num('H', 360, 'Hue (0–360°)');
  const S = num('S', 100, 'Saturation (0–100%)');
  const V = num('B', 100, 'Brightness (0–100%)');

  const el = h(
    'div',
    { class: 'colour-popover', role: 'dialog', 'aria-label': title },
    sv,
    hue,
    h('div', { class: 'colour-row' }, h('div', { class: 'colour-compare' }, oldSwatch, newSwatch), hex),
    h('div', { class: 'colour-row' }, R.el, G.el, B.el),
    h('div', { class: 'colour-row' }, H.el, S.el, V.el),
    h('div', { class: 'colour-note muted small' }, 'sRGB: these are the exact values saved in the texture.')
  );

  /** Shows the state; `skip` is the field being typed in (left alone). */
  const show = (skip?: HTMLInputElement) => {
    const hexValue = button.value;
    const [r, g, b] = hexToRgb(hexValue);
    const set = (i: HTMLInputElement, v: string) => i !== skip && (i.value = v);
    set(hex, hexValue);
    set(R.input, String(r));
    set(G.input, String(g));
    set(B.input, String(b));
    set(H.input, String(Math.round(hsb.h) % 360));
    set(S.input, String(Math.round(hsb.s)));
    set(V.input, String(Math.round(hsb.b)));
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${rgbToHex(...hsbToRgb({ h: hsb.h, s: 100, b: 100 }))})`;
    svDot.style.left = `${hsb.s}%`;
    svDot.style.top = `${100 - hsb.b}%`;
    hueDot.style.left = `${(hsb.h / 360) * 100}%`;
    newSwatch.style.background = hexValue;
  };
  const emit = (hexValue: string, skip?: HTMLInputElement) => {
    const changed = hexValue !== button.value;
    // Set through the property without re-syncing the HSB from the rounded RGB.
    const o = open;
    open = undefined;
    button.value = hexValue;
    open = o;
    show(skip);
    if (changed && open) {
      open.changed = true;
      button.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  const fromHsb = (skip?: HTMLInputElement) => emit(rgbToHex(...hsbToRgb(hsb)), skip);
  const fromHex = (hexValue: string, skip?: HTMLInputElement) => {
    hsb = rgbToHsb(...hexToRgb(hexValue));
    emit(hexValue, skip);
  };

  const drag = (target: HTMLElement, at: (x: number, y: number) => void) => {
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = target.getBoundingClientRect();
        at(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
      };
      move(e);
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  };
  drag(sv, (x, y) => {
    hsb = { h: hsb.h, s: x * 100, b: (1 - y) * 100 };
    fromHsb();
  });
  drag(hue, (x) => {
    hsb = { ...hsb, h: Math.min(359.999, x * 360) };
    fromHsb();
  });

  hex.addEventListener('input', () => {
    const v = normalHex(hex.value);
    if (v && hex.value.replace('#', '').length === 6) fromHex(v, hex);
  });
  hex.addEventListener('change', () => {
    const v = normalHex(hex.value);
    if (v) fromHex(v);
    else show();
  });
  const clampInt = (i: HTMLInputElement, max: number) => (i.value.trim() === '' ? undefined : Math.max(0, Math.min(max, Math.round(Number(i.value)))));
  for (const [f, k] of [[R, 0], [G, 1], [B, 2]] as const) {
    f.input.addEventListener('input', () => {
      const v = clampInt(f.input, 255);
      if (v === undefined || Number.isNaN(v)) return;
      const rgb = hexToRgb(button.value);
      rgb[k] = v;
      fromHex(rgbToHex(...rgb), f.input);
    });
    f.input.addEventListener('change', () => show());
  }
  for (const [f, k, max] of [[H, 'h', 360], [S, 's', 100], [V, 'b', 100]] as const) {
    f.input.addEventListener('input', () => {
      const v = clampInt(f.input, max);
      if (v === undefined || Number.isNaN(v)) return;
      hsb = { ...hsb, [k]: k === 'h' ? v % 360 : v };
      fromHsb(f.input);
    });
    f.input.addEventListener('change', () => show());
  }
  oldSwatch.addEventListener('click', () => fromHex(before));

  open = { button, el, sync: () => ((hsb = rgbToHsb(...hexToRgb(button.value))), show()), changed: false };
  button.classList.add('open');
  document.body.append(el);
  show();
  // Below the button, kept on screen.
  const r = button.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 6);
  let top = r.bottom + 4;
  if (top + ht > window.innerHeight - 6) top = Math.max(6, r.top - ht - 4);
  left = Math.max(6, left);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  hex.focus();
  hex.select();
}
