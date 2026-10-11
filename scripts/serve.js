// Static dev server with caching disabled (always serves the current files).
// Usage: node scripts/serve.js [dir] [port]   (defaults: project root, 8088)
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const port = Number(process.argv[3] || process.env.PORT || 8088);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bmp': 'image/bmp',
  '.png': 'image/png',
  '.raw': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
};

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end(); return; }
  let file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store, must-revalidate',
        'Expires': '0',
      });
      res.end(data);
    });
  });
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}/`));
