/*
 * tools/check.mjs - zero-dependency sanity check for the static site.
 *
 *   node tools/check.mjs        (npm run check)
 *
 * Reads public/, which is the directory the hosts publish verbatim, and
 * verifies the things that silently break a hand-written multi-page site:
 * dead local links, fragments pointing at ids that do not exist, duplicate
 * ids, labels wired to nothing, missing alt text, missing per-page metadata,
 * inline styles that the deployed CSP would block, and element ids that
 * assets/js/main.js queries but no page provides.
 *
 * It also reads api/ and the two host configuration files outside public/,
 * because a renamed route can leave the client calling nothing and a renamed
 * page can leave a redirect pointing at nothing, and no page would show either.
 *
 * Exits 1 on the first category of failure so CI can gate a deploy on it.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Everything below resolves against the published directory, not the repo:
   a path that works here is a path that works on the deployed site. */
const site = resolve(repo, 'public');
const problems = [];
const stats = { pages: 0, links: 0, ids: 0, images: 0 };

function fail(file, message) {
  problems.push(`${file}: ${message}`);
}

function readText(relative) {
  return readFileSync(resolve(site, relative), 'utf8');
}

/* Comments and <script>/<style> bodies would otherwise produce phantom
   matches for href=, id= and friends. */
function strip(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>');
}

function allMatches(text, pattern) {
  const out = [];
  let match;
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  while ((match = re.exec(text)) !== null) out.push(match);
  return out;
}

const pages = readdirSync(site)
  .filter((name) => name.endsWith('.html'))
  .sort();

if (pages.length === 0) {
  console.error('No .html files found in public/.');
  process.exit(1);
}

/* A page added at the repo root instead of in public/ would never be
   published, and nothing else would notice. */
for (const stray of readdirSync(repo).filter((name) => name.endsWith('.html'))) {
  fail(stray, 'sits at the repo root, so no host would publish it - move it into public/');
}

/* Pass 1: read every page and collect its ids, so fragments in any page can
   be checked against the page they actually point at. */
const docs = new Map();

for (const page of pages) {
  const raw = readText(page);
  const html = strip(raw);
  const ids = new Set();

  for (const [, id] of allMatches(html, /\sid="([^"]*)"/g)) {
    if (!id) {
      fail(page, 'found an empty id attribute');
    } else if (ids.has(id)) {
      fail(page, `duplicate id "${id}"`);
    }
    ids.add(id);
  }

  docs.set(page, { raw, html, ids });
  stats.pages += 1;
  stats.ids += ids.size;
}

/* Pass 2: per-page checks. */
const EXTERNAL = /^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/i;

for (const page of pages) {
  const { raw, html, ids } = docs.get(page);

  /* --- document metadata ------------------------------------------------ */
  if (!/<html\s[^>]*lang="[a-z]{2}(-[A-Za-z]+)?"/.test(raw)) fail(page, 'missing <html lang="...">');
  if (!/<meta\s+charset="UTF-8">/i.test(raw)) fail(page, 'missing <meta charset="UTF-8">');
  if (!/<title>[^<]{5,}<\/title>/.test(raw)) fail(page, 'missing or too-short <title>');
  if (!/name="viewport"/.test(raw)) fail(page, 'missing viewport meta');
  if (!/name="description"\s+content="[^"]{40,}"/.test(raw)) {
    fail(page, 'missing <meta name="description"> of at least 40 characters');
  }
  if (!/href="assets\/css\/site\.css"/.test(raw)) fail(page, 'does not load assets/css/site.css');
  if (!/src="assets\/js\/main\.js"/.test(raw)) fail(page, 'does not load assets/js/main.js');
  if (!/class="skip-link"/.test(raw)) fail(page, 'missing the skip link');

  /* --- local links and assets ------------------------------------------- */
  const targets = [];

  for (const [, value] of allMatches(html, /\s(?:href|src)="([^"]*)"/g)) targets.push(value);

  for (const [, value] of allMatches(html, /\ssrcset="([^"]*)"/g)) {
    for (const candidate of value.split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) targets.push(url);
    }
  }

  for (const target of targets) {
    if (!target || EXTERNAL.test(target)) continue;
    stats.links += 1;

    const [path, fragment] = target.split('#');

    if (path) {
      if (!existsSync(resolve(site, path))) {
        fail(page, `link points at a file that does not exist: ${path}`);
        continue;
      }
      if (/\.(jpg|jpeg|png|webp|svg|avif)$/i.test(path)) stats.images += 1;
    }

    if (fragment === undefined || fragment === '') continue;

    /* Same document when there is no path, otherwise the linked page. */
    const targetIds = path ? (docs.get(path) || {}).ids : ids;
    if (!targetIds) continue; // linked to a non-HTML file with a fragment
    if (!targetIds.has(fragment)) {
      fail(page, `fragment #${fragment} does not exist in ${path || page}`);
    }
  }

  /* --- form and ARIA wiring --------------------------------------------- */
  for (const [, value] of allMatches(html, /\sfor="([^"]*)"/g)) {
    if (!ids.has(value)) fail(page, `<label for="${value}"> has no matching id`);
  }

  for (const attr of ['aria-controls', 'aria-describedby', 'aria-labelledby']) {
    for (const [, value] of allMatches(html, new RegExp(`\\s${attr}="([^"]*)"`, 'g'))) {
      for (const id of value.trim().split(/\s+/)) {
        if (id && !ids.has(id)) fail(page, `${attr}="${id}" has no matching id`);
      }
    }
  }

  /* --- markup that breaks accessibility or the CSP ---------------------- */
  for (const [tag] of allMatches(html, /<img\b[^>]*>/g)) {
    if (!/\salt="/.test(tag)) fail(page, `<img> without an alt attribute: ${tag.slice(0, 70)}`);
  }

  if (/\sstyle="/.test(html)) {
    fail(page, 'inline style attribute found - the deployed CSP sets style-src \'self\'');
  }

  for (const [block] of allMatches(html, /<button\b[^>]*>[\s\S]*?<\/button>/g)) {
    if (/<a\b/.test(block)) fail(page, 'an <a> is nested inside a <button>, which is invalid');
  }

  for (const [tag] of allMatches(html, /<a\b[^>]*\starget="_blank"[^>]*>/g)) {
    if (!/\srel="[^"]*noopener/.test(tag)) {
      fail(page, `target="_blank" without rel="noopener": ${tag.slice(0, 70)}`);
    }
  }

  /* Every interactive control inside a form needs a name or an id we drive
     from JS; a stray unlabelled input is almost always a mistake. */
  for (const [tag] of allMatches(html, /<(?:input|select|textarea)\b[^>]*>/g)) {
    if (/type="(?:hidden|submit|button)"/.test(tag)) continue;
    const id = /\sid="([^"]*)"/.exec(tag);
    if (!id) {
      fail(page, `form control without an id: ${tag.slice(0, 70)}`);
      continue;
    }
    if (!new RegExp(`for="${id[1]}"`).test(html)) {
      fail(page, `form control #${id[1]} has no <label for>`);
    }
  }
}

/* Pass 3: every id assets/js/main.js reaches for must exist on at least one
   page. This is the check that catches a rename on one side of the contract. */
const scriptPath = 'assets/js/main.js';
const script = readText(scriptPath);
const wanted = new Set(allMatches(script, /'#([a-z][a-z0-9-]*)'/g).map((m) => m[1]));
const provided = new Set();
for (const { ids } of docs.values()) for (const id of ids) provided.add(id);

for (const id of [...wanted].sort()) {
  if (!provided.has(id)) fail(scriptPath, `queries #${id}, which no page defines`);
}

/* And the reverse: ids the CSS or JS contract needs on the menu page. */
if (docs.has('menu.html')) {
  const menu = docs.get('menu.html').html;
  const sections = allMatches(menu, /<section\b[^>]*class="menu-category"[^>]*>/g);
  if (sections.length === 0) fail('menu.html', 'no .menu-category sections found');
  for (const [tag] of sections) {
    if (!/\sdata-category="[^"]+"/.test(tag)) fail('menu.html', `.menu-category without data-category: ${tag.slice(0, 60)}`);
    if (!/\sdata-label="[^"]+"/.test(tag)) fail('menu.html', `.menu-category without data-label: ${tag.slice(0, 60)}`);
  }
  const items = allMatches(menu, /class="menu-item"/g).length;
  const names = allMatches(menu, /class="item-name"/g).length;
  const prices = allMatches(menu, /class="item-price"/g).length;
  if (items !== names || items !== prices) {
    fail('menu.html', `${items} .menu-item, ${names} .item-name, ${prices} .item-price - these must match`);
  }
}

/* Pass 4: files the deploy configs and this readme promise are in the
   published directory. _headers is here too: it is how Netlify and Cloudflare
   learn the CSP, and a restructure is exactly how it gets left behind. */
const required = [
  '404.html',
  'book.html',
  'admin.html',
  'favicon.svg',
  'robots.txt',
  '_headers',
  '.nojekyll',
  'assets/css/site.css',
  'assets/js/main.js',
];

for (const name of required) {
  if (!existsSync(resolve(site, name))) fail('public', `missing ${name}`);
}

/* Pass 4b: every API path main.js calls must exist as a function in api/.
   This is the other half of the id contract in pass 3, and the reason apiSend
   is given whole paths instead of assembling them from parts: a route renamed
   or deleted on the server is caught here rather than by a guest whose booking
   silently stopped working. Vercel maps /api/x to api/x.mjs and /api/a/b to
   api/a/b.mjs, so the file name is derivable from the literal. */
const apiRoot = resolve(repo, 'api');
const apiPaths = new Set(
  allMatches(script, /'(\/api\/[a-z0-9/-]*)/g).map((m) => m[1].replace(/\/+$/, ''))
);

for (const path of [...apiPaths].sort()) {
  const relative = path.replace(/^\/api\//, '');
  if (!relative) {
    fail(scriptPath, `calls ${path}, which names no function`);
    continue;
  }
  if (!existsSync(resolve(apiRoot, `${relative}.mjs`))) {
    fail(scriptPath, `calls ${path}, but api/${relative}.mjs does not exist`);
  }
}

/* And the reverse, so a route nothing calls is noticed while it is still cheap
   to delete. Vercel's Hobby plan caps a project at twelve functions, which is
   the other reason a forgotten one is not free. */
function apiFiles(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...apiFiles(resolve(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.mjs')) out.push(`/api/${prefix}${entry.name.slice(0, -4)}`);
  }
  return out;
}

if (existsSync(apiRoot)) {
  const routes = apiFiles(apiRoot, '');
  if (routes.length > 12) {
    fail('api', `${routes.length} functions - Vercel's Hobby plan deploys at most 12`);
  }
  for (const route of routes.sort()) {
    if (!apiPaths.has(route)) fail(`api${route.slice(4)}.mjs`, `nothing in ${scriptPath} calls ${route}`);
  }
}

/* Pass 5: paths that live outside public/ but name things inside it - the two
   host configs. Nothing else notices when a rename leaves a redirect pointing
   at a page that is gone, and a CSP that drifts between hosts is a security
   difference no page would reveal. */
function repoText(relative) {
  const full = resolve(repo, relative);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

const netlify = repoText('netlify.toml');
const vercelRaw = repoText('vercel.json');
const headersFile = repoText('public/_headers') || '';

if (netlify === null) fail('netlify.toml', 'is missing, so that host would deploy with no redirects or headers');
if (vercelRaw === null) fail('vercel.json', 'is missing, so that host would deploy with no redirects or headers');

for (const [, to] of allMatches(netlify || '', /\bto\s*=\s*"([^"]+)"/g)) {
  const path = to.replace(/^\//, '');
  if (path && !existsSync(resolve(site, path))) {
    fail('netlify.toml', `redirects to ${to}, which does not exist in public/`);
  }
}

let vercel = null;
if (vercelRaw !== null) {
  try {
    vercel = JSON.parse(vercelRaw);
  } catch (error) {
    fail('vercel.json', `is not valid JSON, so the deploy would ignore it: ${error.message}`);
  }
}

if (vercel) {
  const sources = new Set((vercel.redirects || []).map((rule) => rule.source));

  /* Netlify's list is the contract; its catch-all 404 rule is Netlify-only on
     purpose, because Vercel and Pages serve 404.html for misses by themselves. */
  for (const [, from] of allMatches(netlify || '', /\bfrom\s*=\s*"([^"]+)"/g)) {
    if (from.includes('*')) continue;
    if (!sources.has(from)) fail('vercel.json', `netlify.toml redirects ${from} but this config does not`);
  }

  for (const rule of vercel.redirects || []) {
    const path = String(rule.destination || '').replace(/^\//, '');
    if (path && !existsSync(resolve(site, path))) {
      fail('vercel.json', `redirects to ${rule.destination}, which does not exist in public/`);
    }
  }

  const flat = [].concat(...(vercel.headers || []).map((entry) => entry.headers || []));
  const vercelCsp = (flat.find((header) => header.key === 'Content-Security-Policy') || {}).value;
  const netlifyCsp = (/Content-Security-Policy:\s*([^\n]+)/.exec(headersFile) || [])[1];

  if (!vercelCsp) fail('vercel.json', 'sets no Content-Security-Policy');
  else if (!netlifyCsp) fail('public/_headers', 'sets no Content-Security-Policy');
  else if (vercelCsp.trim() !== netlifyCsp.trim()) {
    fail('vercel.json', 'its Content-Security-Policy differs from the one in public/_headers');
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(
  `OK - ${stats.pages} pages, ${stats.links} local links, ` +
  `${stats.ids} ids, ${stats.images} image references, all resolved.`
);
