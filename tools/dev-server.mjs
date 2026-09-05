/*
 * tools/dev-server.mjs - the whole site, API included, on one localhost port.
 *
 *   node tools/dev-server.mjs        (npm start)
 *
 * http-server is enough for the static pages, but not for a fetch to
 * /api/anything: the point of this file is that the same api/*.mjs handlers
 * Vercel will run are the ones answering here, with no framework in between
 * and nothing stubbed. It also applies vercel.json's own redirects and
 * headers, so a Content-Security-Policy mistake shows up on localhost rather
 * than in production.
 *
 * Zero dependencies, like every other tool in this repo.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join, resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const site = resolve(repo, 'public');
const apiRoot = resolve(repo, 'api');

/*
 * Both of these have to happen before anything reads lib/config.mjs, which
 * snapshots process.env at module load.
 *
 * That is why this file has no static import from lib/ or api/: a module's own
 * body is evaluated before the imports of any module that comes after it in
 * the importer's list, so a test whose first import is this file gets these
 * two lines applied in time. Handlers are imported on demand in the router.
 */
loadEnvFile(repo);
if (!process.env.UF_INSECURE_COOKIES) process.env.UF_INSECURE_COOKIES = '1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const config = JSON.parse(readFileSync(resolve(repo, 'vercel.json'), 'utf8'));

/* Vercel matches these sources with path-to-regexp. The handful this project
   uses are valid regular expressions as they stand, which is close enough for
   a dev server and keeps the deployed headers honest locally. */
const headerRules = (config.headers || []).map((entry) => ({
  test: new RegExp('^' + entry.source + '$'),
  headers: entry.headers || []
}));

const redirects = new Map((config.redirects || []).map((rule) => [rule.source, rule]));

function applyHeaders(res, pathname) {
  for (const rule of headerRules) {
    if (!rule.test.test(pathname)) continue;
    for (const header of rule.headers) res.setHeader(header.key, header.value);
  }
}

/* Path traversal is the one thing a static server must not get wrong. The
   resolved path has to sit inside public/ or it is not served, whatever it
   decodes to. */
function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (error) {
    return null;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const full = resolve(site, '.' + rel);
  if (full !== site && !full.startsWith(site + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

/*
 * The same file-to-route mapping Vercel applies to api/: /api/auth/session
 * resolves to api/auth/session.mjs. Segments are checked against a strict
 * pattern rather than merely scanned for "..", because that is the check that
 * keeps this honest if the pattern ever loosens.
 */
async function apiModule(pathname) {
  const parts = pathname.slice(5).split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => !/^[a-z0-9][a-z0-9-]*$/i.test(part))) return null;

  const base = join(apiRoot, ...parts);
  for (const candidate of [base + '.mjs', join(base, 'index.mjs')]) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  return null;
}

function sendStatic(res, full, status) {
  const body = readFileSync(full);
  res.statusCode = status || 200;
  res.setHeader('Content-Type', TYPES[extname(full).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

function sendMiss(res) {
  const page = resolve(site, '404.html');
  /* The same page the hosts serve for a miss, with the same status. Serving
     200 here would hide a broken link from every tool that looks at status. */
  if (existsSync(page)) {
    sendStatic(res, page, 404);
    return;
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found\n');
}

async function route(req, res) {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  applyHeaders(res, pathname);

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const mod = await apiModule(pathname);
    if (!mod || typeof mod.default !== 'function') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'No such endpoint.' } }));
      return;
    }
    /* Vercel's Node runtime pre-parses a JSON body and sets req.body. Leaving
       it alone here exercises the other half of readJson - the half that has
       to read the stream - on every local request. */
    await mod.default(req, res);
    return;
  }

  const redirect = redirects.get(pathname);
  if (redirect) {
    res.statusCode = redirect.permanent === false ? 307 : 308;
    res.setHeader('Location', redirect.destination);
    res.end();
    return;
  }

  const full = resolveStatic(pathname);
  if (full) sendStatic(res, full, 200);
  else sendMiss(res);
}

export function createServer(options) {
  const quiet = Boolean(options && options.quiet);

  return createHttpServer((req, res) => {
    const started = Date.now();
    if (!quiet) {
      res.on('finish', () => {
        const ms = Date.now() - started;
        console.log('  ' + req.method + ' ' + req.url + ' -> ' + res.statusCode + ' (' + ms + 'ms)');
      });
    }

    /* Every handler is already wrapped by lib/http.mjs's handler(), so this
       only catches a route that failed before reaching one - a syntax error in
       a module, say. Without it, one bad import takes the server down. */
    route(req, res).catch((error) => {
      console.error('[dev] ' + (req.method || '?') + ' ' + (req.url || '?'), error);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'server_error', message: 'Dev server failed.' } }));
    });
  });
}

/* Resolves once the port is actually accepting connections, so a test can
   start hitting it on the next line without a sleep. */
export function start(options) {
  const settings = options || {};
  const server = createServer(settings);

  return new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(settings.port === undefined ? 8080 : settings.port, '127.0.0.1', () => {
      const port = server.address().port;
      resolvePort({
        server: server,
        port: port,
        origin: 'http://127.0.0.1:' + port,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

/* Only when run directly, so importing this from a test does not open a port
   nobody asked for. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  const { hasDatabase } = await import('../lib/config.mjs');

  const started = await start({ port: port });
  console.log('Urban Flame dev server on ' + started.origin);
  console.log('  static  public/');
  console.log('  api     api/*.mjs');
  console.log(
    '  data    ' +
      (hasDatabase()
        ? 'DATABASE_URL is set - the API is live'
        : 'no DATABASE_URL - the API answers 503 and the site falls back to localStorage')
  );
}
