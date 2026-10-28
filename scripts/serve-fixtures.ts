/**
 * Static server for fixtures/. GSAP and Motion are served straight from
 * node_modules under /vendor so the pages never hit a CDN.
 *
 *   pnpm fixtures            → http://localhost:4599
 *   PORT=5000 pnpm fixtures
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures');
const VENDOR: Record<string, string> = {
  '/vendor/gsap.js': join(ROOT, 'node_modules/gsap/dist/gsap.min.js'),
  '/vendor/motion.js': join(ROOT, 'node_modules/motion/dist/motion.js'),
};
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function startFixtureServer(port = 4599): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = VENDOR[url.pathname];
    if (!file) {
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      file = join(FIXTURES, rel);
      if (!file.startsWith(FIXTURES)) {
        res.writeHead(403).end();
        return;
      }
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4599);
  startFixtureServer(port).then(() => console.log(`fixtures → http://localhost:${port}`));
}
