/**
 * Minimal static file server for the frontend/index.html demo.
 * Serves one file (index.html) on port 3000. Replaces `npx serve`
 * which we don't have installed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HTML = path.resolve(__dirname, '..', '..', 'frontend', 'index.html');

const server = http.createServer((req, res) => {
  let file = HTML;
  if (req.url && req.url !== '/' && !req.url.startsWith('?')) {
    file = path.join(path.dirname(HTML), req.url);
  }
  if (!fs.existsSync(file)) file = HTML;
  const buf = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
});

server.listen(PORT, () => {
  console.log(`[frontend] http://localhost:${PORT}  (${HTML})`);
});
