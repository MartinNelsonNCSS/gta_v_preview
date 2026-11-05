import * as vscode from 'vscode';
import { fontFamilies } from '../formats/fontNames';

/*
 * The computer's installed font families, read from the system font folders
 * (desktop only; in vscode.dev there is no file system to read). Scanned once
 * per session, in the background.
 */

const MAX_FONT_FILE = 40 * 1024 * 1024;

function fontDirs(): vscode.Uri[] {
  const p = typeof process !== 'undefined' ? process : undefined;
  if (!p?.platform) return [];
  const env = p.env ?? {};
  const home = env.HOME ?? env.USERPROFILE;
  const dirs: string[] = [];
  if (p.platform === 'win32') {
    dirs.push(`${env.WINDIR ?? 'C:\\Windows'}\\Fonts`);
    if (env.LOCALAPPDATA) dirs.push(`${env.LOCALAPPDATA}\\Microsoft\\Windows\\Fonts`);
  } else if (p.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts');
    if (home) dirs.push(`${home}/Library/Fonts`);
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts');
    if (home) dirs.push(`${home}/.local/share/fonts`, `${home}/.fonts`);
  }
  return dirs.map((d) => vscode.Uri.file(d));
}

async function fontFiles(dir: vscode.Uri, depth: number, out: vscode.Uri[]): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name, type] of entries) {
    const uri = vscode.Uri.joinPath(dir, name);
    if (type & vscode.FileType.Directory) {
      if (depth > 0) await fontFiles(uri, depth - 1, out);
    } else if (/\.(ttf|otf|ttc)$/i.test(name)) out.push(uri);
  }
}

let scan: Promise<string[]> | undefined;

export function systemFonts(): Promise<string[]> {
  scan ??= (async () => {
    const files: vscode.Uri[] = [];
    for (const dir of fontDirs()) await fontFiles(dir, 3, files);
    const families = new Set<string>();
    // A few at a time: there can be thousands of font files.
    for (let i = 0; i < files.length; i += 24) {
      await Promise.all(
        files.slice(i, i + 24).map(async (uri) => {
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_FONT_FILE) return;
            for (const f of fontFamilies(await vscode.workspace.fs.readFile(uri))) if (!f.startsWith('.')) families.add(f);
          } catch {
            // Unreadable font: skip it.
          }
        })
      );
    }
    return [...families].sort((a, b) => a.localeCompare(b));
  })();
  return scan;
}
