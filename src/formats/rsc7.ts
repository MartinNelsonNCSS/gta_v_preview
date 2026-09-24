import { Inflate, inflateSync } from 'fflate';

/** Magic numbers found at the start of GTA V resource files. */
const MAGIC_RSC7 = 0x37435352; // "RSC7"
const MAGIC_RSC8 = 0x38435352; // "RSC8" (Gen9 / Enhanced edition)
const MAGIC_FXAP = 0x50415846; // "FXAP" (FiveM asset escrow)

export class ResourceError extends Error {}

export interface Rsc7Resource {
  version: number;
  system: Uint8Array;
  graphics: Uint8Array;
}

/**
 * Size of a resource segment, decoded from the RSC7 page flags.
 * Mirrors CodeWalker's RpfResourceFileEntry.GetSizeFromFlags.
 */
export function sizeFromFlags(flags: number): number {
  const s0 = ((flags >>> 27) & 0x1) << 0;
  const s1 = ((flags >>> 26) & 0x1) << 1;
  const s2 = ((flags >>> 25) & 0x1) << 2;
  const s3 = ((flags >>> 24) & 0x1) << 3;
  const s4 = ((flags >>> 17) & 0x7f) << 4;
  const s5 = ((flags >>> 11) & 0x3f) << 5;
  const s6 = ((flags >>> 7) & 0xf) << 6;
  const s7 = ((flags >>> 5) & 0x3) << 7;
  const s8 = ((flags >>> 4) & 0x1) << 8;
  const ss = flags & 0xf;
  const baseSize = 0x200 << ss;
  return baseSize * (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8);
}

interface Rsc7Header {
  version: number;
  systemSize: number;
  graphicsSize: number;
}

function readHeader(file: Uint8Array): Rsc7Header {
  if (file.byteLength < 16) {
    throw new ResourceError('File is too small to be a GTA V resource.');
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const magic = view.getUint32(0, true);
  if (magic === MAGIC_FXAP) {
    throw new ResourceError(
      'This file is protected by FiveM asset escrow (FXAP) and is encrypted; it cannot be previewed.'
    );
  }
  if (magic === MAGIC_RSC8) {
    throw new ResourceError('Gen9 (RSC8 / Enhanced edition) resources are not supported yet.');
  }
  if (magic !== MAGIC_RSC7) {
    throw new ResourceError('Not an RSC7 resource (unexpected file header).');
  }
  return {
    version: view.getUint32(4, true),
    systemSize: sizeFromFlags(view.getUint32(8, true)),
    graphicsSize: sizeFromFlags(view.getUint32(12, true)),
  };
}

/** Unpacks an RSC7 container into its system (CPU) and graphics (GPU) segments. */
export function readRsc7(file: Uint8Array): Rsc7Resource {
  const { version, systemSize, graphicsSize } = readHeader(file);
  let data: Uint8Array;
  try {
    data = inflateSync(file.subarray(16), { out: new Uint8Array(systemSize + graphicsSize) });
  } catch (err) {
    // Some tools write uncompressed payloads; accept those if the size matches.
    if (file.byteLength - 16 >= systemSize + graphicsSize) {
      data = file.subarray(16, 16 + systemSize + graphicsSize);
    } else {
      throw new ResourceError(`Failed to decompress resource: ${(err as Error).message}`);
    }
  }
  return {
    version,
    system: data.subarray(0, systemSize),
    graphics: data.subarray(systemSize, systemSize + graphicsSize),
  };
}

/**
 * Like readRsc7, but stops decompressing once the system segment is complete.
 * Much cheaper for reading metadata (e.g. texture names) out of large files.
 * The returned graphics segment is empty.
 */
export function readRsc7SystemOnly(file: Uint8Array): Rsc7Resource {
  const { version, systemSize } = readHeader(file);
  const system = new Uint8Array(systemSize);
  let filled = 0;
  const inflater = new Inflate((chunk) => {
    const n = Math.min(chunk.length, systemSize - filled);
    if (n > 0) system.set(chunk.subarray(0, n), filled);
    filled += n;
  });
  const CHUNK = 64 * 1024;
  try {
    for (let pos = 16; pos < file.length && filled < systemSize; pos += CHUNK) {
      const end = Math.min(file.length, pos + CHUNK);
      inflater.push(file.subarray(pos, end), end === file.length);
    }
  } catch (err) {
    throw new ResourceError(`Failed to decompress resource: ${(err as Error).message}`);
  }
  return { version, system, graphics: new Uint8Array(0) };
}
