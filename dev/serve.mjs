/** Local browser preview for design and interaction checks. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8898;
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const panelPath = path.join(root, 'ext', 'sidepanel', 'index.html');

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
    if (pathname === '/preview') {
      const html = fs
        .readFileSync(panelPath, 'utf8')
        .replace(
          '<script type="module" src="panel.js"></script>',
          '<script src="/dev/mock-chrome.js"></script><script type="module" src="/ext/sidepanel/panel.js"></script>'
        )
        .replace('href="panel.css"', 'href="/ext/sidepanel/panel.css"');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`Train of Thought preview: http://127.0.0.1:${port}/preview`));
