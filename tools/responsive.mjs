/*
 * tools/responsive.mjs - fail on horizontal overflow or a wrapped header.
 *
 *   npm start                       (or: python -m http.server 8080 -d public)
 *   npm run responsive
 *
 * Two failures a screenshot at one width never shows:
 *
 *   1. A page wider than its viewport, which gives the whole document a
 *      horizontal scrollbar. Offenders are named by tag and first class.
 *   2. A desktop header spilling onto a second row. Everything in the header is
 *      flex-shrink: 0, so it wraps rather than overflowing - correct, but it
 *      means the breakpoint that swaps in the nav toggle is set too low.
 *
 * The browser keeps its real scrollbar here: a classic scrollbar takes 15px off
 * the layout viewport without taking it off what a media query measures, and a
 * header sized against the media-query width alone wraps in that gap.
 *
 * Every page is swept in local mode - see FORCE_LOCAL below - so the run does
 * not depend on whether the machine has a database configured.
 */

import { launch } from './cdp.mjs';

const base = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

/* 940/941 is the toggle breakpoint and 1159/1160 the edge between the compact
   and full-width desktop headers, both in public/assets/css/site.css. A
   breakpoint that is off by a pixel only shows up if the sweep lands on both
   sides of it. */
const widths = [320, 360, 390, 414, 480, 560, 640, 720, 768, 820, 900, 940, 941, 960, 995, 1024, 1080, 1099, 1100, 1130, 1159, 1160, 1280, 1440, 1920];

const pages = ['index.html', 'menu.html', 'book.html', 'aboutus.html', 'contact.html', 'signup.html', 'admin.html', '404.html'];

/*
 * The sweep measures layout, and it has to measure the same layout every time.
 *
 * main.js asks GET /api/health which mode it is in, so on a machine with
 * DATABASE_URL set the same command would sweep the server-mode pages instead -
 * and the localStorage seed below would be ignored, because in server mode the
 * signed-in header comes from a session cookie. Refusing the probe pins the run
 * to local mode on any host, with or without a database behind it.
 *
 * apiUsable() only checks that fetch is a function, so a rejecting stub reads
 * as "asked, nothing there" rather than "cannot ask".
 */
const FORCE_LOCAL = `(() => {
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = String((input && input.url) || input || '');
    if (url.indexOf('/api/') !== -1) return Promise.reject(new Error('offline for the sweep'));
    return real.apply(this, arguments);
  };
})()`;

/* Long enough in the first name alone to hit the max-width on .session-user:
   renderSession() shows only the first name, so a long surname would prove
   nothing. This is the widest the header can ever get - past the cap the name
   ellipsises instead of growing - which is exactly the case worth sweeping. */
const LONG_NAME = 'Priyadarshinidevi Venkataraghavan';
const EMAIL = 'longname@example.com';

/* uf_session holds the bare email, not a wrapper object: currentUser() in
   main.js bails on anything that is not a string. Getting that wrong seeds a
   session the site ignores, and the signed-in sweep below silently becomes a
   second signed-out sweep - so PROBE reports what actually rendered and the
   run asserts on it. */
const SIGN_IN = `(() => {
  localStorage.setItem('uf_accounts', JSON.stringify({${JSON.stringify(EMAIL)}:
    {name: ${JSON.stringify(LONG_NAME)}, email: ${JSON.stringify(EMAIL)}, phone: '',
     salt: '00', hash: '00', algo: 'sha-256', createdAt: '2026-01-01T00:00:00.000Z'}}));
  localStorage.setItem('uf_session', JSON.stringify(${JSON.stringify(EMAIL)}));
  return true;
})()`;

/* Row detection uses vertical centres, not tops: .header-inner is
   align-items: center, so items on one row share a centre while their tops
   differ by however much their heights differ. */
const PROBE = `(() => {
  const root = document.documentElement;
  const inner = document.querySelector('.header-inner');
  const shown = [...inner.children].filter((el) => el.offsetParent !== null);
  const centres = [];
  for (const el of shown) {
    const box = el.getBoundingClientRect();
    const centre = (box.top + box.bottom) / 2;
    if (!centres.some((c) => Math.abs(c - centre) <= 3)) centres.push(centre);
  }
  return JSON.stringify({
    over: root.scrollWidth - root.clientWidth,
    wide: [...new Set([...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1)
      .map((el) => el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0]))].slice(0, 4),
    collapsed: getComputedStyle(document.querySelector('.nav-toggle')).display !== 'none',
    rows: centres.length,
    layout: root.clientWidth,
    /* Existence, not visibility: in the collapsed header the session slot is
       inside the closed nav panel. */
    signedIn: document.querySelector('.session-user') !== null,
  });
})()`;

try {
  const probe = await fetch(`${base}/index.html`);
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (error) {
  console.error(`Nothing serving ${base} (${error.message}). Start the server first.`);
  process.exit(1);
}

const page = await launch({ port: Number(process.env.CDP_PORT || 9223), scrollbars: true });
const problems = [];
let checks = 0;
let failure;

try {
  await page.viewport(1280, 900);
  await page.onNewDocument(FORCE_LOCAL);
  await page.goto(`${base}/index.html`);
  await page.evaluate(SIGN_IN);

  for (const state of ['signed in', 'signed out']) {
    if (state === 'signed out') {
      await page.evaluate("(() => { localStorage.removeItem('uf_session'); return true; })()");
    }

    for (const name of pages) {
      for (const width of widths) {
        await page.viewport(width, 900, width < 768);
        await page.goto(`${base}/${name}`);
        await page.settle();

        const result = JSON.parse(await page.evaluate(PROBE));
        const where = `${state.padEnd(10)} ${name.padEnd(13)} ${String(width).padStart(4)}px`;
        checks += 1;

        /* The point of the signed-in pass is that the header is wider there -
           a name and a Log out button instead of two short links. If the seed
           stops taking, this pass would quietly re-test the signed-out header. */
        if (result.signedIn !== (state === 'signed in')) {
          throw new Error(
            `${where}: expected the header to be ${state}, but .session-user was ` +
              `${result.signedIn ? 'present' : 'absent'}. The localStorage seed no longer matches main.js.`,
          );
        }

        if (result.over > 0) {
          problems.push(`${where}  overflows by ${result.over}px  ${result.wide.join(', ')}`);
        }

        if (!result.collapsed && result.rows > 1) {
          problems.push(
            `${where}  header wrapped onto ${result.rows} rows ` +
              `(layout viewport ${result.layout}px)`,
          );
        }
      }
    }
  }
} catch (error) {
  failure = error;
} finally {
  await page.close();
}

if (failure) {
  console.error(`\nResponsive check failed to run: ${failure.message}`);
  process.exit(1);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} layout problem${problems.length === 1 ? '' : 's'} in ${checks} combinations:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(
  `OK - no overflow and no wrapped header in ${checks} combinations ` +
    `(${pages.length} pages x ${widths.length} widths x 2 sign-in states).`,
);
