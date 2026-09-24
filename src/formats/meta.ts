import { ResourceReader } from './reader';
import { HashNames } from './hash';

/**
 * Decoder for RAGE "Meta" resources (RSC7 version 2): .ytyp, .ymap, .ymt ...
 *
 * A meta file is self-describing: it carries structure descriptors (field
 * name hash, offset, type) and a list of data blocks, each holding instances
 * of one structure type. Pointers inside the data refer to (block, offset)
 * pairs. We walk the root structure and produce a plain JS object tree.
 */

const ROOT = 0x50000000;
const ARRAYINFO = 0x100;

export const enum MetaType {
  Boolean = 0x01,
  Structure = 0x05,
  StructurePointer = 0x07,
  SignedByte = 0x10,
  UnsignedByte = 0x11,
  SignedShort = 0x12,
  UnsignedShort = 0x13,
  SignedInt = 0x14,
  UnsignedInt = 0x15,
  Float = 0x21,
  Float_XYZ = 0x33,
  Float_XYZW = 0x34,
  ArrayOfChars = 0x40,
  CharPointer = 0x44,
  Hash = 0x4a,
  ArrayOfBytes = 0x50,
  Array = 0x52,
  DataBlockPointer = 0x59,
  ByteEnum = 0x60,
  IntEnum = 0x62,
  IntFlags1 = 0x63,
  ShortFlags = 0x64,
  IntFlags2 = 0x65,
}

interface EntryInfo {
  name: number;
  offset: number;
  type: number;
  refIndex: number;
  refKey: number;
}

interface StructInfo {
  name: number;
  key: number;
  size: number;
  entries: EntryInfo[];
}

interface Block {
  name: number;
  length: number;
  ptr: number;
}

export interface MetaObject {
  _type: string;
  [field: string]: unknown;
}

export class MetaDocument {
  readonly structsByKey = new Map<number, StructInfo>();
  readonly structsByName = new Map<number, StructInfo>();
  readonly enumsByKey = new Map<number, Map<number, number>>();
  readonly blocks: Block[] = [];
  readonly rootBlock: number;
  readonly name?: string;

  constructor(private readonly r: ResourceReader, private readonly names: HashNames) {
    const structPtr = r.ptr(ROOT + 0x20);
    const enumPtr = r.ptr(ROOT + 0x28);
    const blockPtr = r.ptr(ROOT + 0x30);
    this.name = r.string(r.ptr(ROOT + 0x38));
    const structCount = r.u16(ROOT + 0x48);
    const enumCount = r.u16(ROOT + 0x4a);
    const blockCount = r.u16(ROOT + 0x4c);
    this.rootBlock = r.i32(ROOT + 0x1c) - 1;

    for (let i = 0; i < structCount; i++) {
      const p = structPtr + i * 0x20;
      const entriesPtr = r.ptr(p + 0x10);
      const entries: EntryInfo[] = [];
      const n = r.i16(p + 0x1e);
      for (let j = 0; j < n; j++) {
        const e = entriesPtr + j * 0x10;
        entries.push({
          name: r.u32(e),
          offset: r.i32(e + 4),
          type: r.u8(e + 8),
          refIndex: r.i16(e + 0x0a),
          refKey: r.u32(e + 0x0c),
        });
      }
      const info: StructInfo = { name: r.u32(p), key: r.u32(p + 4), size: r.i32(p + 0x18), entries };
      this.structsByKey.set(info.key, info);
      this.structsByName.set(info.name, info);
    }

    for (let i = 0; i < enumCount; i++) {
      const p = enumPtr + i * 0x18;
      const entriesPtr = r.ptr(p + 0x08);
      const n = r.i32(p + 0x10);
      const values = new Map<number, number>();
      for (let j = 0; j < n; j++) values.set(r.i32(entriesPtr + j * 8 + 4), r.u32(entriesPtr + j * 8));
      // Entries reference enums by name hash; index by key too for safety.
      this.enumsByKey.set(r.u32(p), values);
      this.enumsByKey.set(r.u32(p + 4), values);
    }

    for (let i = 0; i < blockCount; i++) {
      const p = blockPtr + i * 0x10;
      this.blocks.push({ name: r.u32(p), length: r.i32(p + 4), ptr: r.ptr(p + 8) });
    }
  }

  /** Decodes the root structure into a plain object tree. */
  decodeRoot(): MetaObject | undefined {
    const block = this.blocks[this.rootBlock];
    if (!block) return undefined;
    const info = this.structsByName.get(block.name);
    if (!info) return undefined;
    return this.decodeStruct(info, block.ptr, 0);
  }

  /** Converts an encoded meta pointer (block index + offset) to a resource pointer. */
  private resolve(encoded: number): { ptr: number; block: Block } | undefined {
    const index = (encoded & 0xfff) - 1;
    const offset = (encoded >>> 12) & 0xfffff;
    const block = this.blocks[index];
    if (!block || offset >= block.length) return undefined;
    return { ptr: block.ptr + offset, block };
  }

  private decodeStruct(info: StructInfo, ptr: number, depth: number): MetaObject {
    const obj: MetaObject = { _type: this.names.get(info.name) };
    if (depth > 32) return obj;
    for (const entry of info.entries) {
      if (entry.name === ARRAYINFO) continue;
      const key = this.names.get(entry.name);
      try {
        obj[key] = this.decodeValue(info, entry, ptr + entry.offset, depth);
      } catch (err) {
        obj[key] = `<error: ${(err as Error).message}>`;
      }
    }
    return obj;
  }

  private decodeValue(owner: StructInfo, entry: EntryInfo, p: number, depth: number): unknown {
    const r = this.r;
    switch (entry.type) {
      case MetaType.Boolean:
        return r.u8(p) !== 0;
      case MetaType.SignedByte:
        return r.i8(p);
      case MetaType.UnsignedByte:
        return r.u8(p);
      case MetaType.SignedShort:
        return r.i16(p);
      case MetaType.UnsignedShort:
        return r.u16(p);
      case MetaType.SignedInt:
        return r.i32(p);
      case MetaType.UnsignedInt:
      case MetaType.IntFlags1:
      case MetaType.IntFlags2:
        return r.u32(p);
      case MetaType.ShortFlags:
        return r.u16(p);
      case MetaType.Float:
        return r.f32(p);
      case MetaType.Float_XYZ:
        return r.vec3(p);
      case MetaType.Float_XYZW:
        return r.vec4(p);
      case MetaType.Hash:
        return this.names.get(r.u32(p));
      case MetaType.ByteEnum:
        return this.enumName(entry.refKey, r.u8(p));
      case MetaType.IntEnum:
        return this.enumName(entry.refKey, r.i32(p));
      case MetaType.ArrayOfChars: {
        const len = entry.refKey & 0xffff;
        let s = '';
        for (let i = 0; i < len; i++) {
          const c = r.u8(p + i);
          if (!c) break;
          s += String.fromCharCode(c);
        }
        return s;
      }
      case MetaType.Structure: {
        const info = this.structInfo(entry.refKey);
        return info ? this.decodeStruct(info, p, depth + 1) : null;
      }
      case MetaType.StructurePointer:
        return this.decodePointer(p, depth);
      case MetaType.CharPointer: {
        const target = this.resolve(r.u32(p));
        const count = r.u16(p + 8);
        if (!target) return '';
        let s = '';
        for (let i = 0; i < count; i++) {
          const c = r.u8(target.ptr + i);
          if (!c) break;
          s += String.fromCharCode(c);
        }
        return s;
      }
      case MetaType.DataBlockPointer:
        return null;
      case MetaType.Array: {
        const item = owner.entries[entry.refIndex];
        const target = this.resolve(r.u32(p));
        const count = r.u16(p + 8);
        if (!item || !target || count === 0) return [];
        return this.decodeArray(owner, item, target.ptr, count, depth);
      }
      case MetaType.ArrayOfBytes: {
        const item = owner.entries[entry.refIndex];
        const count = entry.refKey & 0xffff;
        if (!item) return [];
        return this.decodeArray(owner, item, p, count, depth);
      }
      default:
        return `<type 0x${entry.type.toString(16)}>`;
    }
  }

  private decodeArray(owner: StructInfo, item: EntryInfo, ptr: number, count: number, depth: number): unknown[] {
    const out: unknown[] = [];
    const size = this.elementSize(item);
    if (size === 0) return out;
    for (let i = 0; i < count; i++) {
      const p = ptr + i * size;
      if (item.type === MetaType.StructurePointer) {
        out.push(this.decodePointer(p, depth));
      } else {
        out.push(this.decodeValue(owner, item, p, depth + 1));
      }
    }
    return out;
  }

  /** A StructurePointer is 8 bytes; the target's type comes from its block. */
  private decodePointer(p: number, depth: number): MetaObject | null {
    const target = this.resolve(this.r.u32(p));
    if (!target) return null;
    const info = this.structsByName.get(target.block.name);
    return info ? this.decodeStruct(info, target.ptr, depth + 1) : null;
  }

  private elementSize(item: EntryInfo): number {
    switch (item.type) {
      case MetaType.Boolean:
      case MetaType.SignedByte:
      case MetaType.UnsignedByte:
      case MetaType.ByteEnum:
        return 1;
      case MetaType.SignedShort:
      case MetaType.UnsignedShort:
      case MetaType.ShortFlags:
        return 2;
      case MetaType.SignedInt:
      case MetaType.UnsignedInt:
      case MetaType.Float:
      case MetaType.Hash:
      case MetaType.IntEnum:
      case MetaType.IntFlags1:
      case MetaType.IntFlags2:
        return 4;
      case MetaType.StructurePointer:
        return 8;
      case MetaType.Float_XYZ:
      case MetaType.Float_XYZW:
      case MetaType.CharPointer:
      case MetaType.Array:
        return 16;
      case MetaType.Structure:
        return this.structInfo(item.refKey)?.size ?? 0;
      default:
        return 0;
    }
  }

  /** Entries reference structures by name hash (older tools used the key). */
  private structInfo(ref: number): StructInfo | undefined {
    return this.structsByName.get(ref) ?? this.structsByKey.get(ref);
  }

  private enumName(enumKey: number, value: number): string | number {
    const hash = this.enumsByKey.get(enumKey)?.get(value);
    return hash !== undefined ? this.names.get(hash) : value;
  }
}
