/**
 * Prepares a message for `webview.postMessage`. VS Code serializes messages
 * with JSON.stringify and transfers typed arrays specially, but a Node
 * `Buffer` (what file reads return on desktop) turns itself into
 * `{ type: 'Buffer', data: [...] }` through its toJSON before that happens, so
 * the webview receives a plain object instead of bytes. Buffers are swapped
 * for plain Uint8Array views of the same memory.
 */
export function forWebview<T>(message: T): T {
  return plain(message, new Set()) as T;
}

function plain(value: unknown, seen: Set<unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) {
    if (value instanceof Uint8Array && value.constructor !== Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return value;
  }
  if (value instanceof ArrayBuffer || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((v, i) => {
      const p = plain(v, seen);
      if (p !== v) (out ??= value.slice())[i] = p;
    });
    return out ?? value;
  }
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = plain(v, seen);
    if (p !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = p;
  }
  return out ?? value;
}
