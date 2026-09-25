import { ResourceError } from './rsc7';

/**
 * Minimal DDS reading/writing for the formats GTA V uses. Block-compressed
 * formats use their FourCC; BC7 uses the DX10 extended header.
 */

const DDSD_CAPS = 0x1, DDSD_HEIGHT = 0x2, DDSD_WIDTH = 0x4, DDSD_PITCH = 0x8, DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000, DDSD_LINEARSIZE = 0x80000;
const DDPF_ALPHAPIXELS = 0x1, DDPF_ALPHA = 0x2, DDPF_FOURCC = 0x4, DDPF_RGB = 0x40, DDPF_LUMINANCE = 0x20000;
const DDSCAPS_COMPLEX = 0x8, DDSCAPS_TEXTURE = 0x1000, DDSCAPS_MIPMAP = 0x400000;
const DXGI_BC7_UNORM = 98;

const fourCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

interface PixelFormat {
  flags: number;
  fourCC?: string;
  bits?: number;
  masks?: [number, number, number, number]; // r, g, b, a
  blockBytes?: number;
  pixelBytes?: number;
}

const PIXEL_FORMATS: Record<string, PixelFormat> = {
  DXT1: { flags: DDPF_FOURCC, fourCC: 'DXT1', blockBytes: 8 },
  DXT3: { flags: DDPF_FOURCC, fourCC: 'DXT3', blockBytes: 16 },
  DXT5: { flags: DDPF_FOURCC, fourCC: 'DXT5', blockBytes: 16 },
  BC4: { flags: DDPF_FOURCC, fourCC: 'ATI1', blockBytes: 8 },
  BC5: { flags: DDPF_FOURCC, fourCC: 'ATI2', blockBytes: 16 },
  BC7: { flags: DDPF_FOURCC, fourCC: 'DX10', blockBytes: 16 },
  A8R8G8B8: { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bits: 32, masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000], pixelBytes: 4 },
  X8R8G8B8: { flags: DDPF_RGB, bits: 32, masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0], pixelBytes: 4 },
  A8B8G8R8: { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bits: 32, masks: [0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000], pixelBytes: 4 },
  R5G6B5: { flags: DDPF_RGB, bits: 16, masks: [0xf800, 0x07e0, 0x001f, 0], pixelBytes: 2 },
  A1R5G5B5: { flags: DDPF_RGB | DDPF_ALPHAPIXELS, bits: 16, masks: [0x7c00, 0x03e0, 0x001f, 0x8000], pixelBytes: 2 },
  L8: { flags: DDPF_LUMINANCE, bits: 8, masks: [0xff, 0, 0, 0], pixelBytes: 1 },
  A8: { flags: DDPF_ALPHA, bits: 8, masks: [0, 0, 0, 0xff], pixelBytes: 1 },
};

/** Builds a .dds file from raw texture data (all mips back to back). */
export function buildDds(format: string, width: number, height: number, levels: number, data: Uint8Array): Uint8Array {
  const pf = PIXEL_FORMATS[format];
  if (!pf) throw new ResourceError(`Exporting ${format} textures as DDS isn't supported.`);
  const dx10 = pf.fourCC === 'DX10';
  const headerSize = 128 + (dx10 ? 20 : 0);
  const out = new Uint8Array(headerSize + data.length);
  const v = new DataView(out.buffer);
  const compressed = !!pf.blockBytes;
  const pitchOrLinear = compressed
    ? Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * pf.blockBytes!
    : width * (pf.pixelBytes ?? 4);

  v.setUint32(0, fourCC('DDS '), true);
  v.setUint32(4, 124, true);
  v.setUint32(8, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_MIPMAPCOUNT | (compressed ? DDSD_LINEARSIZE : DDSD_PITCH), true);
  v.setUint32(12, height, true);
  v.setUint32(16, width, true);
  v.setUint32(20, pitchOrLinear, true);
  v.setUint32(28, levels, true);
  // Pixel format at 76.
  v.setUint32(76, 32, true);
  v.setUint32(80, pf.flags, true);
  if (pf.fourCC) v.setUint32(84, fourCC(pf.fourCC), true);
  if (pf.bits) {
    v.setUint32(88, pf.bits, true);
    const [rm, gm, bm, am] = pf.masks!;
    v.setUint32(92, rm, true);
    v.setUint32(96, gm, true);
    v.setUint32(100, bm, true);
    v.setUint32(104, am, true);
  }
  v.setUint32(108, DDSCAPS_TEXTURE | (levels > 1 ? DDSCAPS_MIPMAP | DDSCAPS_COMPLEX : 0), true);
  if (dx10) {
    v.setUint32(128, DXGI_BC7_UNORM, true);
    v.setUint32(132, 3, true); // D3D10_RESOURCE_DIMENSION_TEXTURE2D
    v.setUint32(140, 1, true); // array size
  }
  out.set(data, headerSize);
  return out;
}

export interface DdsImage {
  format: string;
  width: number;
  height: number;
  /** Top mip level only. */
  data: Uint8Array;
}

/** Reads the top mip of a .dds file in one of the supported formats. */
export function parseDds(file: Uint8Array): DdsImage {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.length < 128 || v.getUint32(0, true) !== fourCC('DDS ')) throw new ResourceError('Not a DDS file.');
  const height = v.getUint32(12, true);
  const width = v.getUint32(16, true);
  const flags = v.getUint32(80, true);
  const cc = v.getUint32(84, true);
  let offset = 128;
  let format: string | undefined;
  if (flags & DDPF_FOURCC) {
    const name = String.fromCharCode(cc & 0xff, (cc >> 8) & 0xff, (cc >> 16) & 0xff, cc >>> 24);
    if (name === 'DX10') {
      offset += 20;
      const dxgi = v.getUint32(128, true);
      if (dxgi === DXGI_BC7_UNORM || dxgi === 99) format = 'BC7';
      else if (dxgi === 71 || dxgi === 72) format = 'DXT1';
      else if (dxgi === 74 || dxgi === 75) format = 'DXT3';
      else if (dxgi === 77 || dxgi === 78) format = 'DXT5';
      else if (dxgi === 80) format = 'BC4';
      else if (dxgi === 83) format = 'BC5';
      else if (dxgi === 28 || dxgi === 29) format = 'A8B8G8R8';
      else if (dxgi === 87) format = 'A8R8G8B8';
    } else {
      format = { DXT1: 'DXT1', DXT3: 'DXT3', DXT5: 'DXT5', ATI1: 'BC4', BC4U: 'BC4', ATI2: 'BC5', BC5U: 'BC5' }[name];
    }
  } else {
    const bits = v.getUint32(88, true);
    const rm = v.getUint32(92, true);
    const am = v.getUint32(104, true);
    if (bits === 32) format = rm === 0x00ff0000 ? (am ? 'A8R8G8B8' : 'X8R8G8B8') : 'A8B8G8R8';
    else if (bits === 16) format = rm === 0xf800 ? 'R5G6B5' : 'A1R5G5B5';
    else if (bits === 8) format = flags & DDPF_ALPHA ? 'A8' : 'L8';
  }
  const pf = format ? PIXEL_FORMATS[format] : undefined;
  if (!format || !pf) throw new ResourceError('This DDS format is not supported.');
  const size = pf.blockBytes
    ? Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * pf.blockBytes
    : width * height * (pf.pixelBytes ?? 4);
  if (offset + size > file.length) throw new ResourceError('The DDS file is truncated.');
  return { format, width, height, data: file.slice(offset, offset + size) };
}
