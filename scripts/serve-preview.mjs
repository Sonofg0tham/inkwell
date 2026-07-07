// Tiny static server for the built extension pages (visual review only).
// Serves .output/chrome-mv3 on http://localhost:8123
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.output', 'chrome-mv3');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let rel = urlPath === '/' ? '/preview-popup.html' : urlPath;
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) throw new Error('traversal');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(8123, () => console.log('preview server on http://localhost:8123'));
