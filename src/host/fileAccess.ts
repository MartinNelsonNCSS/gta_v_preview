import * as vscode from 'vscode';
import { readRsc7SystemOnly, Rsc7Resource, SystemInflater } from '../formats/rsc7';
import { isEncrypted } from '../formats/scan';

type NodeFs = typeof import('fs');

let nodeFs: NodeFs | null | undefined;
/** Node's fs when running in a desktop extension host; null in the web extension host. */
function fs(): NodeFs | null {
  if (nodeFs === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nodeFs = typeof require === 'function' ? (require('fs') as NodeFs) : null;
    } catch {
      nodeFs = null;
    }
  }
  return nodeFs;
}

export interface SystemRead {
  /** First 16 bytes (the RSC7 header). */
  head: Uint8Array;
  /** Decompressed system segment, or undefined for encrypted/unreadable files. */
  res?: Rsc7Resource;
  error?: string;
}

const CHUNK = 64 * 1024;

/**
 * Reads just enough of a resource file to decompress its system segment. On
 * local disk only the start of the file is read, which makes scanning large
 * texture dictionaries much faster than reading them whole.
 */
export async function readSystemSegment(uri: vscode.Uri): Promise<SystemRead> {
  const f = uri.scheme === 'file' ? fs() : null;
  if (!f) {
    const data = await vscode.workspace.fs.readFile(uri);
    const head = data.subarray(0, 16);
    if (isEncrypted(head)) return { head };
    try {
      return { head, res: readRsc7SystemOnly(data) };
    } catch (err) {
      return { head, error: (err as Error).message };
    }
  }
  const handle = await f.promises.open(uri.fsPath, 'r');
  try {
    const head = new Uint8Array(16);
    await handle.read(head, 0, 16, 0);
    if (isEncrypted(head)) return { head };
    let inflater: SystemInflater;
    try {
      inflater = new SystemInflater(head);
    } catch (err) {
      return { head, error: (err as Error).message };
    }
    const { size } = await handle.stat();
    const buf = new Uint8Array(CHUNK);
    for (let pos = 16; pos < size && !inflater.done; pos += CHUNK) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      inflater.push(buf.slice(0, bytesRead), pos + bytesRead >= size);
    }
    return { head, res: inflater.result() };
  } catch (err) {
    return { head: new Uint8Array(16), error: (err as Error).message };
  } finally {
    await handle.close();
  }
}
