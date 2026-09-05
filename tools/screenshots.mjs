/*
 * tools/screenshots.mjs - regenerate docs/screenshots/*.jpg from the running site.
 *
 *   npm start                       (or: python -m http.server 8080 -d public)
 *   npm run screenshots
 *
 * Each page is captured at a viewport as tall as the document rather than with
 * captureBeyondViewport, because body uses background-attachment: fixed - a
 * beyond-viewport capture paints the photo once at the top and leaves the rest
 * of the shot flat.
 *
 * The output lives in docs/, not public/: these are readme illustrations, and
 * shipping 1.4 MB of them to the CDN on every deploy would be waste.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(repo, 'docs', 'screenshots');
const base = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const width = 1280;
const quality = 80;

const shots = [
  ['home.jpg', 'index.html'],
  ['menu.jpg', 'menu.html'],
  ['book.jpg', 'book.html'],
  ['about.jpg', 'aboutus.html'],
  ['contact.jpg', 'contact.html'],
  ['signup.jpg', 'signup.html'],
];

try {
  const probe = await fetch(`${base}/index.html`);
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (error) {
  console.error(`Nothing serving ${base} (${error.message}). Start the server first.`);
  process.exit(1);
}

const page = await launch({ port: Number(process.env.CDP_PORT || 9222) });
let failure;

try {
  for (const [file, path] of shots) {
    await page.viewport(width, 900);
    await page.goto(`${base}/${path}`);

    /* A full-page capture never scrolls, so the gallery's loading="lazy" photos
       stay deferred and paint as empty tiles. Promote every image to eager
       before measuring and settle() waits for the bytes and the decode. */
    await page.evaluate("[...document.images].forEach((i) => { i.loading = 'eager'; });");
    await page.settle();

    /* Measure, resize, measure again: a taller window can reflow the page. */
    await page.viewport(width, Math.ceil(await page.settle()));
    const height = Math.ceil(await page.settle());
    await page.viewport(width, height);
    await page.settle();

    writeFileSync(resolve(outDir, file), await page.screenshot('jpeg', quality));
    console.log(`  ${file.padEnd(12)} ${width}x${height}`);
  }
} catch (error) {
  failure = error;
} finally {
  await page.close();
}

if (failure) {
  console.error(`\nScreenshots failed: ${failure.message}`);
  process.exit(1);
}

console.log(`\nWrote ${shots.length} screenshots at ${width}px wide.`);
