import { ResourceReader } from './reader';
import { readRsc7 } from './rsc7';
import { readDrawable, DrawableOptions } from './drawable';
import type { DrawableData } from '../shared/model';

const ROOT = 0x50000000;

/**
 * Pointers to every fragDrawable in a fragment: main, named array, and
 * others referenced from the root (e.g. the damaged model), with names.
 */
export function fragmentDrawables(r: ResourceReader): { ptr: number; name: string }[] {
  const fragName = (r.string(r.ptr(ROOT + 0x58)) ?? '').replace(/^pack:\//i, '');
  const mainPtr = r.ptr(ROOT + 0x30);
  const out: { ptr: number; name: string }[] = [];
  const seen = new Set<number>();
  const add = (ptr: number, name: string) => {
    if (!r.isValid(ptr) || seen.has(ptr)) return;
    seen.add(ptr);
    out.push({ ptr, name });
  };
  add(mainPtr, fragName || 'fragment');

  // Named drawable array (e.g. alternative parts of some props).
  const arrayPtr = r.ptr(ROOT + 0x38);
  const namesPtr = r.ptr(ROOT + 0x40);
  const count = r.u32(ROOT + 0x48);
  if (r.isValid(arrayPtr) && count > 0 && count < 256) {
    for (let i = 0; i < count; i++) {
      const name = r.isValid(namesPtr) ? r.string(r.ptr(namesPtr + i * 8)) : undefined;
      add(r.ptr(arrayPtr + i * 8), name || `${fragName} [${i}]`);
    }
  }

  // Other fragDrawables referenced from the root (the damaged model on vehicles).
  // They're recognised by sharing the main drawable's vtable value.
  if (r.isValid(mainPtr)) {
    const vft = r.u32(mainPtr);
    for (let o = 0x60; o < 0x130; o += 8) {
      const p = r.ptr(ROOT + o);
      if (!r.isValid(p) || seen.has(p)) continue;
      try {
        if (r.u32(p) === vft && r.isValid(r.ptr(p + 0x50))) add(p, `${fragName} (damaged)`);
      } catch {
        // Not a drawable.
      }
    }
  }
  return out;
}

/**
 * Parses a .yft fragment (vehicles, breakable props). Returns the main
 * drawable first, then any extra drawables the fragment carries (the damaged
 * model, and the named drawable array used by some props).
 */
export function parseYft(file: Uint8Array, opts: DrawableOptions): DrawableData[] {
  const r = new ResourceReader(readRsc7(file));
  return fragmentDrawables(r).map(({ ptr, name }) => {
    const d = readDrawable(r, ptr, opts, 'frag');
    // Fragment drawables are usually named "skel"; the fragment name is more useful.
    d.name = name;
    return d;
  });
}
