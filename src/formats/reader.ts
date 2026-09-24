import { Rsc7Resource, ResourceError } from './rsc7';

const SYSTEM_BASE = 0x50000000;
const GRAPHICS_BASE = 0x60000000;

/**
 * Random-access reader over a decompressed resource. Resource pointers are
 * 64-bit values whose high nibble selects the segment (0x5 = system,
 * 0x6 = graphics) and whose low 28 bits are an offset into that segment.
 */
export class ResourceReader {
  private readonly sys: DataView;
  private readonly gfx: DataView;

  constructor(readonly res: Rsc7Resource) {
    this.sys = new DataView(res.system.buffer, res.system.byteOffset, res.system.byteLength);
    this.gfx = new DataView(res.graphics.buffer, res.graphics.byteOffset, res.graphics.byteLength);
  }

  /** Converts a 64-bit pointer (as a JS number) into a segment + offset. */
  private resolve(ptr: number, length: number): { view: DataView; bytes: Uint8Array; offset: number } {
    const base = ptr >= GRAPHICS_BASE && ptr < GRAPHICS_BASE + 0x10000000 ? GRAPHICS_BASE : SYSTEM_BASE;
    if (ptr < SYSTEM_BASE || ptr >= GRAPHICS_BASE + 0x10000000) {
      throw new ResourceError(`Invalid resource pointer 0x${ptr.toString(16)}`);
    }
    const offset = ptr - base;
    const isGfx = base === GRAPHICS_BASE;
    const view = isGfx ? this.gfx : this.sys;
    if (offset + length > view.byteLength) {
      throw new ResourceError(`Resource pointer 0x${ptr.toString(16)} (+${length}) is out of range`);
    }
    return { view, bytes: isGfx ? this.res.graphics : this.res.system, offset };
  }

  isValid(ptr: number): boolean {
    if (!ptr) return false;
    const inSys = ptr >= SYSTEM_BASE && ptr - SYSTEM_BASE < this.sys.byteLength;
    const inGfx = ptr >= GRAPHICS_BASE && ptr - GRAPHICS_BASE < this.gfx.byteLength;
    return inSys || inGfx;
  }

  u8(ptr: number): number {
    const r = this.resolve(ptr, 1);
    return r.view.getUint8(r.offset);
  }
  i8(ptr: number): number {
    const r = this.resolve(ptr, 1);
    return r.view.getInt8(r.offset);
  }
  u16(ptr: number): number {
    const r = this.resolve(ptr, 2);
    return r.view.getUint16(r.offset, true);
  }
  i16(ptr: number): number {
    const r = this.resolve(ptr, 2);
    return r.view.getInt16(r.offset, true);
  }
  u32(ptr: number): number {
    const r = this.resolve(ptr, 4);
    return r.view.getUint32(r.offset, true);
  }
  i32(ptr: number): number {
    const r = this.resolve(ptr, 4);
    return r.view.getInt32(r.offset, true);
  }
  f32(ptr: number): number {
    const r = this.resolve(ptr, 4);
    return r.view.getFloat32(r.offset, true);
  }
  /** Reads a 64-bit pointer. Resource pointers always fit in 53 bits. */
  ptr(ptr: number): number {
    const r = this.resolve(ptr, 8);
    const lo = r.view.getUint32(r.offset, true);
    const hi = r.view.getUint32(r.offset + 4, true);
    return hi * 0x100000000 + lo;
  }
  vec3(ptr: number): [number, number, number] {
    return [this.f32(ptr), this.f32(ptr + 4), this.f32(ptr + 8)];
  }
  vec4(ptr: number): [number, number, number, number] {
    return [this.f32(ptr), this.f32(ptr + 4), this.f32(ptr + 8), this.f32(ptr + 12)];
  }

  /** Returns a view of `length` bytes (no copy). */
  bytes(ptr: number, length: number): Uint8Array {
    const r = this.resolve(ptr, length);
    return r.bytes.subarray(r.offset, r.offset + length);
  }

  /** Reads a NUL-terminated ASCII string, or undefined for a null pointer. */
  string(ptr: number): string | undefined {
    if (!this.isValid(ptr)) return undefined;
    const r = this.resolve(ptr, 1);
    const end = r.bytes.indexOf(0, r.offset);
    const slice = r.bytes.subarray(r.offset, end < 0 ? r.bytes.length : end);
    let s = '';
    for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
    return s;
  }

  /** Reads an array of 64-bit pointers. */
  ptrArray(ptr: number, count: number): number[] {
    const out: number[] = [];
    if (!this.isValid(ptr)) return out;
    for (let i = 0; i < count; i++) out.push(this.ptr(ptr + i * 8));
    return out;
  }

  /** Reads the common { ptr, u16 count, u16 capacity } list header. */
  list(ptr: number): { items: number; count: number } {
    return { items: this.ptr(ptr), count: this.u16(ptr + 8) };
  }
}
