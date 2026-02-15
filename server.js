import { createRequestHandler } from '@remix-run/node';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const buildDir = join(__dirname, 'build');
const clientDir = join(buildDir, 'client');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

const build = await import('./build/server/index.js');
const handler = createRequestHandler(build, 'production');

const server = createServer(async (req, res) => {
  // Health check
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // Serve static files from build/client
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const staticPath = join(clientDir, urlPath);

  if (urlPath !== '/' && existsSync(staticPath)) {
    try {
      const stat = statSync(staticPath);
      if (stat.isFile()) {
        const ext = extname(staticPath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const isImmutable = urlPath.startsWith('/assets/');
        const cacheControl = isImmutable
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size,
          'Cache-Control': cacheControl,
        });
        createReadStream(staticPath).pipe(res);
        return;
      }
    } catch {}
  }

  // COEP/COOP headers for WebContainer
  if (!urlPath.startsWith('/webcontainer/vercel-preview')) {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Remix SSR handler
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    const body = req.method !== 'GET' && req.method !== 'HEAD'
      ? await new Promise((resolve) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
        })
      : null;

    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      body,
      duplex: 'half',
    });

    const response = await handler(request);

    const setCookiesFromApi = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : null;
    const setCookies = setCookiesFromApi ? [...setCookiesFromApi] : [];

    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() === 'set-cookie') {
        if (!setCookiesFromApi) setCookies.push(value);
        continue;
      }
      res.setHeader(key, value);
    }

    if (setCookies.length > 0) {
      res.setHeader('Set-Cookie', setCookies);
    }

    res.writeHead(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(value);
        }
      };
      pump().catch(() => res.end());
    } else {
      res.end();
    }
  } catch (err) {
    console.error('SSR Error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

const PORT = parseInt(process.env.PORT || '5171', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
