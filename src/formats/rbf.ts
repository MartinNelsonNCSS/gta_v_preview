/**
 * RBF ("RBF0") binary XML, used by a few GTA V files such as creature metadata
 * (.ymt). Elements and attributes refer to names through descriptor indices;
 * a name is spelled out the first time it is used. Elements carry typed
 * attributes, then children (typed values, nested elements or byte blocks),
 * and end with FF FF.
 */

export type RbfValue =
  | { kind: 'uint'; name: string; value: number }
  | { kind: 'float'; name: string; value: number }
  | { kind: 'bool'; name: string; value: boolean }
  | { kind: 'string'; name: string; value: string };

export interface RbfElement {
  kind: 'element';
  name: string;
  attributes?: RbfValue[];
  children?: (RbfElement | RbfValue | { kind: 'bytes'; value: Uint8Array })[];
}

/** An element like `<name content="char_array">1 2 3</name>`. */
export function rbfArray(name: string, content: 'char_array' | 'short_array', values: number[]): RbfElement {
  const bytes = content === 'char_array' ? Uint8Array.from(values) : new Uint8Array(new Uint16Array(values).buffer);
  return { kind: 'element', name, attributes: [{ kind: 'string', name: 'content', value: content }], children: [{ kind: 'bytes', value: bytes }] };
}

/** An element like `<name value="0x1F" />` (a uint value node). */
export const rbfUint = (name: string, value: number): RbfValue => ({ kind: 'uint', name, value: value >>> 0 });

export const rbfElement = (name: string, children: RbfElement['children'] = [], attributes: RbfValue[] = []): RbfElement => ({ kind: 'element', name, children, attributes });

export function writeRbf(root: RbfElement): Uint8Array {
  const out: number[] = [];
  const descriptors = new Map<string, number>();
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => (u8(v), u8(v >> 8));
  const u32 = (v: number) => (u16(v), u16(v >>> 16));
  const ascii = (s: string) => {
    for (let i = 0; i < s.length; i++) u8(s.charCodeAt(i));
  };
  const record = (name: string, type: number) => {
    let index = descriptors.get(name);
    const isNew = index === undefined;
    if (isNew) {
      index = descriptors.size;
      if (index > 0xfc) throw new Error('Too many distinct names for an RBF file.');
      descriptors.set(name, index);
    }
    u8(index!);
    u8(type);
    if (isNew) {
      u16(name.length);
      ascii(name);
    }
  };
  const value = (v: RbfValue) => {
    switch (v.kind) {
      case 'uint':
        record(v.name, 0x10);
        return u32(v.value);
      case 'bool':
        return record(v.name, v.value ? 0x20 : 0x30);
      case 'float': {
        record(v.name, 0x40);
        const f = new DataView(new ArrayBuffer(4));
        f.setFloat32(0, v.value, true);
        return u32(f.getUint32(0, true));
      }
      case 'string':
        record(v.name, 0x60);
        u16(v.value.length);
        return ascii(v.value);
    }
  };
  const element = (e: RbfElement) => {
    record(e.name, 0);
    u32(0);
    const attributes = e.attributes ?? [];
    u16(attributes.length);
    attributes.forEach(value);
    for (const c of e.children ?? []) {
      if (c.kind === 'element') element(c);
      else if (c.kind === 'bytes') {
        u8(0xfd);
        u8(0xff);
        u32(c.value.length);
        c.value.forEach((b) => u8(b));
      } else value(c);
    }
    u8(0xff);
    u8(0xff);
  };
  u32(0x30464252); // "RBF0"
  element(root);
  return Uint8Array.from(out);
}

/** Reads an RBF file back into elements (for checks and tests). */
export function readRbf(data: Uint8Array): RbfElement {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0, true) !== 0x30464252) throw new Error('Not an RBF file.');
  let p = 4;
  const names: string[] = [];
  const stack: RbfElement[] = [];
  let root: RbfElement | undefined;
  const add = (c: NonNullable<RbfElement['children']>[number]) => stack[stack.length - 1]?.children!.push(c);
  while (p < data.length) {
    const index = data[p++];
    if (index === 0xff) {
      p++;
      const done = stack.pop()!;
      if (!stack.length) root = done;
      continue;
    }
    if (index === 0xfd) {
      p++;
      const len = v.getUint32(p, true);
      p += 4;
      add({ kind: 'bytes', value: data.slice(p, p + len) });
      p += len;
      continue;
    }
    const type = data[p++];
    if (index >= names.length) {
      const len = v.getUint16(p, true);
      p += 2;
      names.push(String.fromCharCode(...data.subarray(p, p + len)));
      p += len;
    }
    const name = names[index];
    if (type === 0) {
      p += 4;
      const count = v.getUint16(p, true);
      p += 2;
      const e: RbfElement = { kind: 'element', name, attributes: [], children: [] };
      add(e);
      stack.push(e);
      (e as { pendingAttributes?: number }).pendingAttributes = count;
      continue;
    }
    let value: RbfValue;
    if (type === 0x10) (value = { kind: 'uint', name, value: v.getUint32(p, true) }), (p += 4);
    else if (type === 0x20 || type === 0x30) value = { kind: 'bool', name, value: type === 0x20 };
    else if (type === 0x40) (value = { kind: 'float', name, value: v.getFloat32(p, true) }), (p += 4);
    else if (type === 0x60) {
      const len = v.getUint16(p, true);
      value = { kind: 'string', name, value: String.fromCharCode(...data.subarray(p + 2, p + 2 + len)) };
      p += 2 + len;
    } else throw new Error(`Unknown RBF type 0x${type.toString(16)}.`);
    const parent = stack[stack.length - 1] as RbfElement & { pendingAttributes?: number };
    if (parent?.pendingAttributes) {
      parent.attributes!.push(value);
      parent.pendingAttributes--;
    } else add(value);
  }
  if (!root) throw new Error('Unterminated RBF file.');
  delete (root as { pendingAttributes?: number }).pendingAttributes;
  return root;
}
