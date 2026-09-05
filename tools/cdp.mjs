/*
 * tools/cdp.mjs - the small slice of the DevTools protocol that tools/ needs.
 *
 * Launches headless Chrome (or Edge), attaches to its first page target, and
 * returns a session with the four operations the other scripts use. Node's
 * global WebSocket does the talking, so there is nothing to npm install.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function findBrowser() {
  return process.env.CHROME_PATH || CANDIDATES.find(existsSync) || null;
}

/* Request/response by id, plus one-shot event waits. Only one page target is
   ever attached, so events can match on method alone. */
function connect(url) {
  return new Promise((ready, failed) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const waiters = new Map();
    let counter = 0;

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);

      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }

      const waiting = waiters.get(message.method);
      if (waiting) {
        waiters.delete(message.method);
        waiting(message.params);
      }
    });

    socket.addEventListener('error', () => failed(new Error('DevTools socket failed')));

    socket.addEventListener('open', () =>
      ready({
        send(method, params) {
          const id = (counter += 1);
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        once(method, timeout) {
          return new Promise((resolve) => {
            waiters.set(method, resolve);
            setTimeout(() => {
              waiters.delete(method);
              resolve(null);
            }, timeout || 20000);
          });
        },
        close: () => socket.close(),
      }),
    );
  });
}

export async function launch(options) {
  const port = (options && options.port) || 9222;
  const binary = findBrowser();

  /* Node only exposes a global WebSocket client from v21. Without this the
     failure is a bare ReferenceError from inside connect(), after a browser
     has already been spawned. npm run check needs neither and runs anywhere. */
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `Node ${process.versions.node} has no global WebSocket, which this DevTools client needs. ` +
        'Use Node 21 or newer for the browser-driven scripts.',
    );
  }

  if (!binary) {
    throw new Error('No Chrome or Edge found. Set CHROME_PATH to a Chromium binary.');
  }

  const profile = mkdtempSync(join(tmpdir(), 'uf-cdp-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    'about:blank',
  ];

  /* Screenshots want no scrollbar in the frame; layout checks want the real
     one, because a classic scrollbar narrows the layout viewport without
     narrowing what a media query sees, and that gap is a bug source. */
  if (!(options && options.scrollbars)) args.unshift('--hide-scrollbars');

  const browser = spawn(binary, args, { stdio: 'ignore' });

  let target = null;
  for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) target = page.webSocketDebuggerUrl;
    } catch {
      /* still starting */
    }
    if (!target) await sleep(250);
  }

  if (!target) {
    browser.kill();
    throw new Error('Headless browser never exposed a page target.');
  }

  const wire = await connect(target);
  await wire.send('Page.enable');

  return {
    viewport(width, height, mobile) {
      return wire.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: Boolean(mobile),
      });
    },

    async goto(url) {
      const loaded = wire.once('Page.loadEventFired');
      await wire.send('Page.navigate', { url });
      await loaded;
    },

    /* Runs before any of the page's own scripts, on this and every later
       navigation. evaluate() cannot do this: by the time it runs, main.js has
       already read the environment it is being lied to about. */
    onNewDocument(source) {
      return wire.send('Page.addScriptToEvaluateOnNewDocument', { source });
    },

    async evaluate(expression) {
      const res = await wire.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
      return res.result.value;
    },

    /* Fonts and non-lazy images settle after the load event; lazy images below
       the viewport intentionally remain incomplete until the user reaches them.
       Waiting on those would make responsive checks hang forever. Returns the
       page height. */
    settle() {
      return this.evaluate(
        '(async () => {' +
          ' await document.fonts.ready;' +
          ' await Promise.all([...document.images].filter((i) => !i.complete && i.loading !== "lazy")' +
          '   .map((i) => new Promise((r) => { i.onload = i.onerror = r; })));' +
          /* Loaded is not painted. decode() resolves once the bitmap is ready,
             which closes the gap between the load event and the first paint.
             Only images that have pixels are asked: a deferred lazy image or a
             broken one has naturalWidth 0 and would leave decode() pending. */
          ' await Promise.all([...document.images].filter((i) => i.naturalWidth > 0)' +
          '   .map((i) => i.decode().catch(() => {})));' +
          ' return document.documentElement.scrollHeight;' +
          '})()',
      );
    },

    async screenshot(format, quality) {
      const shot = await wire.send('Page.captureScreenshot', { format, quality });
      return Buffer.from(shot.data, 'base64');
    },

    async close() {
      wire.close();
      browser.kill();
      await sleep(400);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* Windows can hold the profile open a moment longer; harmless. */
      }
    },
  };
}
