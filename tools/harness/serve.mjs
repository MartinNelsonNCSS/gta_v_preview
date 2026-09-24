// Dev server for the webview harness: node tools/harness/serve.mjs <samples-dir> [port]
import { createServer } from 'http';
import { readFile, readdir, stat } from 'fs/promises';
import { join, extname, relative, resolve } from 'path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 5178);
const repo = resolve(new URL('../..', import.meta.url).pathname);
const EXTS = ['.ydr', '.ydd', '.ytyp', '.ytd', '.yft', '.ybn', '.ymap'];
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.map': 'application/json' };

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (EXTS.includes(extname(e.name).toLowerCase())) out.push(relative(root, p).split('\\').join('/'));
  }
  return out;
}

const page = (file) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/dist/webview.css">
<style>:root{--vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc;--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-font-size:13px;--vscode-focusBorder:#0078d4;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-dropdown-background:#3c3c3c;--vscode-sideBar-background:#252526;--vscode-editorWidget-background:#252526}</style>
</head><body><div id="app"></div><script src="/out/harness.js"></script><script src="/dist/webview.js"></script></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') {
      const file = url.searchParams.get('file');
      if (file) return res.writeHead(200, { 'content-type': 'text/html' }).end(page(file));
      const files = (await walk(root)).filter((f) => /\.(ydr|ydd|ytyp|ytd|ymap|ybn)$/i.test(f));
      return res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<body style="font:13px sans-serif;background:#1e1e1e;color:#ccc">${files.map((f) => `<div><a style="color:#4fc3f7" href="/?file=${encodeURIComponent(f)}">${f}</a></div>`).join('')}</body>`
      );
    }
    if (url.pathname === '/api/list') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await walk(root)));
    let path;
    if (url.pathname.startsWith('/files/')) path = join(root, decodeURIComponent(url.pathname.slice(7)));
    else if (url.pathname.startsWith('/dist/') || url.pathname.startsWith('/out/')) path = join(repo, url.pathname);
    if (!path || !(await stat(path)).isFile()) throw new Error('not found');
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(await readFile(path));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`harness: http://localhost:${port}/ serving ${root}`));
