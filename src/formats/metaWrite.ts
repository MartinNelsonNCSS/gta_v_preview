import { deflateSync } from 'fflate';
import { HashNames, joaat } from './hash';
import { arrayItem, EntryInfo, EnumInfo, MetaObject, MetaType, StructInfo } from './meta';
import { packSegment } from './resourceBuilder';
import { ResourceError } from './rsc7';

/**
 * Writer for RAGE "Meta" resources (RSC7 version 2), the inverse of
 * MetaDocument: plain objects (as the reader produces them) are encoded with
 * a schema of structure/enum descriptors, usually taken from an existing file
 * of the same kind. Instances of each structure type go into one data block;
 * pointers are stored as (block index + 1) | (offset << 12).
 */

const SYS = 0x50000000;
const ARRAYINFO = 0x100;

export interface MetaSchema {
  structs: StructInfo[];
  enums: EnumInfo[];
  /** 0x70-byte root header to start from (keeps the original's version fields). */
  rootHeader?: Uint8Array;
  /** 16-byte RSC7 header to start from. */
  fileHeader?: Uint8Array;
}

interface Block {
  name: number;
  bytes: Uint8Array;
  length: number;
}

const align = (n: number, a = 16) => Math.ceil(n / a) * a;

export class MetaWriter {
  private readonly byName = new Map<number, StructInfo>();
  private readonly byTypeName = new Map<string, StructInfo>();
  private readonly enums = new Map<number, EnumInfo>();
  private readonly blocks: Block[] = [];
  private readonly blockIndex = new Map<number, number>();

  constructor(private readonly schema: MetaSchema, private readonly names: HashNames) {
    for (const s of schema.structs) {
      this.byName.set(s.name, s);
      this.byName.set(s.key, s);
      this.byTypeName.set(names.get(s.name), s);
    }
    for (const e of schema.enums) {
      this.enums.set(e.name, e);
      this.enums.set(e.key, e);
    }
  }

  /** Encodes `root` (a MetaObject whose `_type` names its structure) into a complete .ymt/.ytyp/.ymap file. */
  write(root: MetaObject, metaName?: string): Uint8Array {
    const info = this.byTypeName.get(root._type);
    if (!info) throw new ResourceError(`No structure "${root._type}" in the schema.`);
    const { block, offset } = this.allocate(info.name, info.size, 1);
    this.writeStruct(info, root, block, offset);
    return this.assemble(this.blockIndex.get(info.name)!, metaName);
  }

  // -- data --------------------------------------------------------------------

  private allocate(name: number, size: number, count: number): { block: Block; offset: number } {
    let index = this.blockIndex.get(name);
    if (index === undefined) {
      index = this.blocks.length;
      this.blocks.push({ name, bytes: new Uint8Array(256), length: 0 });
      this.blockIndex.set(name, index);
    }
    const block = this.blocks[index];
    const offset = align(block.length);
    const end = offset + size * count;
    if (end > 0xfffff) throw new ResourceError('Meta data block is too large.');
    if (end > block.bytes.length) {
      const grown = new Uint8Array(Math.max(end, block.bytes.length * 2));
      grown.set(block.bytes);
      block.bytes = grown;
    }
    block.length = end;
    return { block, offset };
  }

  private view(block: Block): DataView {
    return new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength);
  }

  private pointer(block: Block, offset: number): number {
    return ((this.blocks.indexOf(block) + 1) & 0xfff) | (offset << 12);
  }

  private structFor(ref: number): StructInfo {
    const s = this.byName.get(ref);
    if (!s) throw new ResourceError(`Structure 0x${ref.toString(16)} is missing from the schema.`);
    return s;
  }

  private writeStruct(info: StructInfo, obj: MetaObject | undefined, block: Block, offset: number): void {
    for (const entry of info.entries) {
      if (entry.name === ARRAYINFO) continue;
      const value = obj?.[this.names.get(entry.name)];
      this.writeValue(info, entry, value, block, offset + entry.offset);
    }
  }

  private writeValue(owner: StructInfo, entry: EntryInfo, value: unknown, block: Block, p: number): void {
    const v = () => this.view(block);
    const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'boolean' ? Number(x) : Number(x ?? 0) || 0);
    switch (entry.type) {
      case MetaType.Boolean:
        return v().setUint8(p, value ? 1 : 0);
      case MetaType.SignedByte:
        return v().setInt8(p, num(value));
      case MetaType.UnsignedByte:
        return v().setUint8(p, num(value));
      case MetaType.SignedShort:
        return v().setInt16(p, num(value), true);
      case MetaType.UnsignedShort:
      case MetaType.ShortFlags:
        return v().setUint16(p, num(value), true);
      case MetaType.SignedInt:
        return v().setInt32(p, num(value), true);
      case MetaType.UnsignedInt:
      case MetaType.IntFlags1:
      case MetaType.IntFlags2:
        return v().setUint32(p, num(value) >>> 0, true);
      case MetaType.Float:
        return v().setFloat32(p, num(value), true);
      case MetaType.Float_XYZ:
      case MetaType.Float_XYZW: {
        const arr = Array.isArray(value) ? value : [];
        for (let i = 0; i < (entry.type === MetaType.Float_XYZ ? 3 : 4); i++) v().setFloat32(p + i * 4, num(arr[i]), true);
        return;
      }
      case MetaType.Hash:
        return v().setUint32(p, hashOf(value), true);
      case MetaType.ByteEnum:
        return v().setUint8(p, this.enumValue(entry.refKey, value));
      case MetaType.IntEnum:
        return v().setInt32(p, this.enumValue(entry.refKey, value), true);
      case MetaType.ArrayOfChars: {
        const len = entry.refKey & 0xffff;
        const s = String(value ?? '');
        for (let i = 0; i < len; i++) v().setUint8(p + i, i < s.length ? s.charCodeAt(i) & 0xff : 0);
        return;
      }
      case MetaType.Structure:
        return this.writeStruct(this.structFor(entry.refKey), value as MetaObject, block, p);
      case MetaType.StructurePointer: {
        const obj = value as MetaObject | null | undefined;
        if (!obj) return v().setUint32(p, 0, true);
        const info = this.byTypeName.get(obj._type);
        if (!info) throw new ResourceError(`No structure "${obj._type}" in the schema.`);
        const target = this.allocate(info.name, info.size, 1);
        this.writeStruct(info, obj, target.block, target.offset);
        return v().setUint32(p, this.pointer(target.block, target.offset), true);
      }
      case MetaType.CharPointer:
      case MetaType.DataBlockPointer:
        if (value) throw new ResourceError(`Writing meta type 0x${entry.type.toString(16)} isn't supported.`);
        return;
      case MetaType.Array: {
        const items = Array.isArray(value) ? value : [];
        const item = arrayItem(owner, entry);
        if (!items.length) return;
        if (!item) throw new ResourceError('Array entry without an item description.');
        let target: { block: Block; offset: number };
        if (item.type === MetaType.Structure) {
          const info = this.structFor(item.refKey);
          target = this.allocate(info.name, info.size, items.length);
          items.forEach((x, i) => this.writeStruct(info, x as MetaObject, target.block, target.offset + i * info.size));
        } else {
          // Arrays of plain values live in a block named after the value's meta type.
          const size = elementSize(item, (r) => this.structFor(r).size);
          if (!size) throw new ResourceError(`Writing arrays of meta type 0x${item.type.toString(16)} isn't supported.`);
          target = this.allocate(item.type, size, items.length);
          items.forEach((x, i) => this.writeValue(owner, item, x, target.block, target.offset + i * size));
        }
        const view = v();
        view.setUint32(p, this.pointer(target.block, target.offset), true);
        view.setUint32(p + 4, 0, true);
        view.setUint16(p + 8, items.length, true);
        view.setUint16(p + 10, items.length, true);
        return;
      }
      case MetaType.ArrayOfBytes: {
        const items = Array.isArray(value) ? value : [];
        const item = arrayItem(owner, entry);
        const count = entry.refKey & 0xffff;
        if (!item) return;
        const size = elementSize(item, (r) => this.structFor(r).size);
        for (let i = 0; i < count; i++) this.writeValue(owner, item, items[i], block, p + i * size);
        return;
      }
      default:
        if (value !== undefined && value !== null) throw new ResourceError(`Writing meta type 0x${entry.type.toString(16)} isn't supported.`);
    }
  }

  private enumValue(ref: number, value: unknown): number {
    if (typeof value === 'number') return value;
    const e = this.enums.get(ref);
    if (e && typeof value === 'string') {
      for (const [n, hash] of e.values) if (this.names.get(hash) === value || hash === hashOf(value)) return n;
    }
    if (value === undefined || value === null || value === '') return 0;
    throw new ResourceError(`Unknown enum value "${String(value)}".`);
  }

  // -- file --------------------------------------------------------------------

  private assemble(rootBlock: number, metaName?: string): Uint8Array {
    const structs = this.schema.structs;
    const enums = this.schema.enums;
    // Layout: root, page map, struct infos + entries, enum infos + entries, block infos, block data, name.
    let at = 0x70;
    const pageMap = at;
    at += 0x10 + 8 * 16;
    const structInfos = (at = align(at));
    at += structs.length * 0x20;
    const structEntries = structs.map((s) => {
      const o = align(at);
      at = o + s.entries.length * 0x10;
      return o;
    });
    const enumInfos = (at = align(at));
    at += enums.length * 0x18;
    const enumEntries = enums.map((e) => {
      const o = align(at);
      at = o + e.values.size * 8;
      return o;
    });
    const blockInfos = (at = align(at));
    at += this.blocks.length * 0x10;
    const blockData = this.blocks.map((b) => {
      const o = align(at);
      at = o + align(b.length);
      return o;
    });
    const nameBytes = metaName ? new TextEncoder().encode(`${metaName}\0`) : undefined;
    const nameAt = nameBytes ? align(at) : 0;
    if (nameBytes) at = nameAt + nameBytes.length;

    const pack = packSegment([at], true);
    const out = new Uint8Array(pack.size);
    const v = new DataView(out.buffer);
    const ptr = (o: number, target: number) => {
      v.setUint32(o, (SYS + target) >>> 0, true);
      v.setUint32(o + 4, 0, true);
    };

    if (this.schema.rootHeader) out.set(this.schema.rootHeader.subarray(0, 0x70), 0);
    ptr(0x08, pageMap);
    v.setInt32(0x1c, rootBlock + 1, true);
    ptr(0x20, structInfos);
    ptr(0x28, enumInfos);
    ptr(0x30, blockInfos);
    if (nameBytes) ptr(0x38, nameAt);
    else v.setBigUint64(0x38, 0n, true);
    v.setBigUint64(0x40, 0n, true);
    v.setUint16(0x48, structs.length, true);
    v.setUint16(0x4a, enums.length, true);
    v.setUint16(0x4c, this.blocks.length, true);
    out[pageMap + 8] = pack.pageCount;
    out[pageMap + 9] = 0;

    structs.forEach((s, i) => {
      const o = structInfos + i * 0x20;
      if (s.raw) out.set(s.raw.info, o);
      v.setUint32(o, s.name >>> 0, true);
      v.setUint32(o + 4, s.key >>> 0, true);
      v.setInt32(o + 0x18, s.size, true);
      v.setInt16(o + 0x1e, s.entries.length, true);
      if (s.entries.length) ptr(o + 0x10, structEntries[i]);
      s.entries.forEach((e, j) => {
        const eo = structEntries[i] + j * 0x10;
        if (s.raw) out.set(s.raw.entries.subarray(j * 0x10, j * 0x10 + 0x10), eo);
        v.setUint32(eo, e.name >>> 0, true);
        v.setInt32(eo + 4, e.offset, true);
        out[eo + 8] = e.type;
        // Arrays point at their item description (fixes files written with a wrong index).
        const item = e.type === MetaType.Array || e.type === MetaType.ArrayOfBytes ? arrayItem(s, e) : undefined;
        v.setInt16(eo + 0x0a, item ? s.entries.indexOf(item) : e.refIndex, true);
        v.setUint32(eo + 0x0c, e.refKey >>> 0, true);
      });
    });
    enums.forEach((e, i) => {
      const o = enumInfos + i * 0x18;
      if (e.raw) out.set(e.raw.info, o);
      v.setUint32(o, e.name >>> 0, true);
      v.setUint32(o + 4, e.key >>> 0, true);
      v.setInt32(o + 0x10, e.values.size, true);
      if (e.values.size) ptr(o + 0x08, enumEntries[i]);
      [...e.values].forEach(([value, hash], j) => {
        v.setUint32(enumEntries[i] + j * 8, hash >>> 0, true);
        v.setInt32(enumEntries[i] + j * 8 + 4, value, true);
      });
    });
    this.blocks.forEach((b, i) => {
      const o = blockInfos + i * 0x10;
      v.setUint32(o, b.name >>> 0, true);
      v.setInt32(o + 4, b.length, true);
      ptr(o + 8, blockData[i]);
      out.set(b.bytes.subarray(0, b.length), blockData[i]);
    });
    if (nameBytes) out.set(nameBytes, nameAt);

    // RSC7 header: version 2; the version nibbles live in the top bits of the page flags.
    const header = new Uint8Array(16);
    const hv = new DataView(header.buffer);
    if (this.schema.fileHeader) header.set(this.schema.fileHeader.subarray(0, 16));
    else {
      hv.setUint32(0, 0x37435352, true);
      hv.setUint32(4, 2, true);
      hv.setUint32(12, 0x20000000, true);
    }
    hv.setUint32(8, ((hv.getUint32(8, true) & 0xf0000000) | pack.flags) >>> 0, true);
    hv.setUint32(12, hv.getUint32(12, true) & 0xf0000000, true);
    const compressed = deflateSync(out, { level: 6 });
    const file = new Uint8Array(16 + compressed.length);
    file.set(header);
    file.set(compressed, 16);
    return file;
  }
}

/** Hash for a Hash field: `hash_XXXXXXXX` as-is, otherwise the lower-case joaat of the name. */
export function hashOf(value: unknown): number {
  if (typeof value === 'number') return value >>> 0;
  const s = String(value ?? '');
  if (!s) return 0;
  const m = /^hash_([0-9a-f]{8})$/i.exec(s);
  return m ? parseInt(m[1], 16) : joaat(s);
}

function elementSize(item: EntryInfo, structSize: (ref: number) => number): number {
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
      return structSize(item.refKey);
    default:
      return 0;
  }
}
