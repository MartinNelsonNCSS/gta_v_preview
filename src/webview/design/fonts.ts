/*
 * Fonts for livery text: the computer's installed fonts (detected by
 * measuring, since webviews can't list them), plus font files added to a
 * design (stored in it, so the design looks the same on another machine).
 */

/** Common fonts on Windows, macOS and Linux (plus popular free ones people install), by style. */
const CANDIDATES: Record<string, string[]> = {
  'Bold & display': [
    'Arial Black', 'Impact', 'Haettenschweiler', 'Bahnschrift', 'Bahnschrift Condensed', 'Franklin Gothic Medium', 'Franklin Gothic Heavy',
    'Segoe UI Black', 'Rockwell Extra Bold', 'Cooper Black', 'Britannic Bold', 'Showcard Gothic', 'Stencil', 'Agency FB', 'Eras Bold ITC',
    'Bebas Neue', 'Anton', 'Oswald', 'Montserrat', 'Montserrat Black', 'Roboto Black', 'Roboto Condensed', 'Barlow Condensed', 'Teko',
    'Russo One', 'Black Ops One', 'Orbitron', 'Audiowide', 'Bungee', 'Exo 2', 'Saira Condensed', 'Rajdhani', 'Squada One', 'Titillium Web',
    'Futura', 'Avenir Next Condensed', 'DIN Condensed', 'DIN Alternate', 'Helvetica Neue', 'Gill Sans', 'Copperplate', 'Rockwell', 'Chalkduster',
  ],
  Sans: [
    'Arial', 'Arial Narrow', 'Segoe UI', 'Segoe UI Semibold', 'Calibri', 'Candara', 'Corbel', 'Tahoma', 'Trebuchet MS', 'Verdana', 'Century Gothic',
    'Lucida Sans Unicode', 'Gill Sans MT', 'Helvetica', 'Avenir', 'Avenir Next', 'SF Pro Display', 'Open Sans', 'Roboto', 'Lato', 'Inter',
    'Noto Sans', 'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Cantarell', 'Poppins', 'Raleway', 'Source Sans Pro', 'Nunito',
  ],
  Serif: [
    'Times New Roman', 'Georgia', 'Cambria', 'Constantia', 'Palatino Linotype', 'Book Antiqua', 'Garamond', 'Baskerville Old Face', 'Bodoni MT',
    'Didot', 'Baskerville', 'Hoefler Text', 'Palatino', 'Times', 'Noto Serif', 'DejaVu Serif', 'Liberation Serif', 'Playfair Display', 'Merriweather',
    'Old English Text MT', 'Algerian',
  ],
  Script: [
    'Brush Script MT', 'Segoe Script', 'Segoe Print', 'Ink Free', 'Gabriola', 'MV Boli', 'Lucida Handwriting', 'Freestyle Script', 'Kristen ITC',
    'Comic Sans MS', 'Snell Roundhand', 'Zapfino', 'Bradley Hand', 'Marker Felt', 'Noteworthy', 'Chalkboard', 'Pacifico', 'Lobster', 'Permanent Marker',
    'Dancing Script', 'Satisfy', 'Kaushan Script',
  ],
  Mono: ['Consolas', 'Courier New', 'Lucida Console', 'Cascadia Code', 'Menlo', 'Monaco', 'SF Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Fira Code', 'JetBrains Mono'],
};

export const GENERIC_FONTS = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];

let detected: Record<string, string[]> | undefined;
/** Every installed family, as read from the system's font files by the extension (desktop only). */
let system: string[] = [];

export function setSystemFonts(families: string[]): void {
  system = families.filter((f) => !f.startsWith('.'));
}

/** Installed fonts from the candidate list, by style. */
export function installedFonts(): Record<string, string[]> {
  if (detected) return detected;
  const ctx = document.createElement('canvas').getContext('2d')!;
  const sample = 'mmmmmmmmmmlliWQ@#0123456789';
  const width = (font: string) => {
    ctx.font = `72px ${font}`;
    return ctx.measureText(sample).width;
  };
  const bases = ['monospace', 'serif', 'sans-serif'].map((b) => [b, width(b)] as const);
  const has = (f: string) => bases.some(([b, w]) => Math.abs(width(`"${f}", ${b}`) - w) > 0.5);
  detected = Object.fromEntries(Object.entries(CANDIDATES).map(([style, list]) => [style, [...new Set(list)].filter(has)]));
  return detected;
}

const loaded = new Set<string>();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A family name for a font file (from its file name). */
export function familyFromFileName(name: string): string {
  return name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Custom font';
}

/** Makes a font file usable under `family`. */
export async function loadFont(family: string, data: Uint8Array | string): Promise<void> {
  if (loaded.has(family)) return;
  const bytes = typeof data === 'string' ? base64ToBytes(data) : data;
  const face = new FontFace(family, bytes.slice().buffer);
  await face.load();
  document.fonts.add(face);
  loaded.add(family);
}

/** Families added from files (in this webview). */
export function addedFonts(): string[] {
  return [...loaded].sort();
}

/**
 * A font picker: each option drawn in its own font, grouped by style, with
 * the design's added fonts first. Typing filters the list.
 */
export function fontPicker(current: string, onPick: (family: string) => void, onAddFile: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'font-picker';
  const button = document.createElement('button');
  button.className = 'font-picker-button';
  const label = () => {
    button.textContent = current;
    button.style.fontFamily = `"${current}", sans-serif`;
  };
  label();
  const pop = document.createElement('div');
  pop.className = 'font-picker-pop';
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search fonts…';
  const list = document.createElement('div');
  list.className = 'font-picker-list';
  const add = document.createElement('button');
  add.className = 'chip mini';
  add.textContent = 'Add font file…';
  add.title = 'Use a .ttf/.otf/.woff font (e.g. from Google Fonts); it is stored in the design';
  add.onclick = (e) => {
    e.stopPropagation();
    close();
    onAddFile();
  };
  pop.append(search, list, add);
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const popular = Object.entries(installedFonts()).map(([style, list]): [string, string[]] => [`Popular: ${style.toLowerCase()}`, list]);
    const groups: [string, string[]][] = [
      ['Added to this design', addedFonts()],
      ...popular,
      ...(system.length ? [[`All installed fonts (${system.length})`, system] as [string, string[]]] : []),
      ['Generic', GENERIC_FONTS],
    ];
    list.replaceChildren();
    for (const [style, fonts] of groups) {
      const shown = fonts.filter((f) => !q || f.toLowerCase().includes(q));
      if (!shown.length) continue;
      const head = document.createElement('div');
      head.className = 'font-picker-group';
      head.textContent = style;
      list.append(head);
      for (const f of shown) {
        const item = document.createElement('div');
        item.className = `font-picker-item${f === current ? ' active' : ''}`;
        item.textContent = f;
        item.style.fontFamily = GENERIC_FONTS.includes(f) ? f : `"${f}", sans-serif`;
        item.onclick = () => {
          current = f;
          label();
          close();
          onPick(f);
        };
        list.append(item);
      }
    }
  };
  const onDoc = (e: Event) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', onDoc, true);
  };
  button.onclick = () => {
    if (pop.isConnected) return close();
    wrap.append(pop);
    search.value = '';
    fill();
    search.focus();
    document.addEventListener('pointerdown', onDoc, true);
  };
  search.oninput = fill;
  search.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') (list.querySelector('.font-picker-item') as HTMLElement | null)?.click();
  };
  wrap.append(button);
  return wrap;
}
