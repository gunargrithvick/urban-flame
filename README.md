# Urban Flame

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An eight-page site for a flame-grill restaurant in Indiranagar, Bengaluru: hand-written
HTML, CSS and one file of vanilla JavaScript, plus an optional Postgres-backed API for
accounts, table bookings and enquiries. There is no build step on either side — `public/`
is the site, served exactly as it sits in the repo, and `api/` is seven plain Node
functions.

It runs both ways on purpose. Give it a database and bookings, accounts and enquiries
become real shared records, with the server holding the last table. Give it none — or open
`public/index.html` straight off disk — and the same pages fall back to `localStorage`,
where every feature still works for one browser. Nothing is stubbed out and no page
changes shape; only the wording does, so a page never claims a table was held when it was
not.

## Two modes, one site

`main.js` asks `GET /api/health` once per tab and caches the verdict in `sessionStorage`:

```json
{ "ok": true, "db": true, "schema": true, "timezone": "Asia/Kolkata", "time": "..." }
```

Server mode needs `ok`, `db` and `schema` together. Anything else is local mode: a 404
because no functions are deployed, `db: false` because no `DATABASE_URL` is set,
`schema: false` because `npm run db:init` has not been run yet, or a `file://` page where
the request cannot be made at all. `/api/health` never fails for its own reasons — an
unreachable database is a `200` with `db: false`, because the caller is asking a question
and "no" is an answer.

| | Server mode | Local mode |
| --- | --- | --- |
| Accounts | A `users` row; the password hashed with scrypt on the server | `uf_accounts`, hashed in the browser through `crypto.subtle` |
| Sessions | `HttpOnly` cookie; only a SHA-256 hash of the token is stored | The signed-in email in `uf_session` |
| Bookings | A `bookings` row plus per-slot counters, so two guests cannot take one table | `uf_bookings`, with the page saying so |
| Enquiries | An `enquiries` row staff can mark handled | `uf_messages`, capped at the most recent 50 |
| Staff view | `admin.html` lists real bookings and enquiries, for `ADMIN_EMAILS` only | The gate says there is no server to ask |

Pages carry both wordings in the markup — the local one as the element's text, the other
in `data-server-text` — and the copy is swapped once the mode is known. The local default
is the pessimistic one, so a page that never gets an answer still reads truthfully.

## Pages

All eight live in `public/`, which is the directory every host publishes.

| Page | What is on it |
| --- | --- |
| `index.html` | Hero, log-in / account card, how-we-cook cards, photo gallery |
| `menu.html` | 33 dishes across 6 courses, filter chips, live search, empty state |
| `book.html` | Date picker, the times still open for a given party, and a reference lookup |
| `aboutus.html` | The story, what the kitchen actually does, an at-a-glance panel |
| `contact.html` | Enquiry form, address, phone, opening hours, directions |
| `signup.html` | Account creation with a password-strength meter |
| `admin.html` | Staff view: today's bookings and the enquiry queue |
| `404.html` | Not-found page with the site header and a legal-only footer |

`contact.html` is the only page that states closing times, because they differ by
day. Everywhere else says "open from 11:00", which is true of all seven.

`admin.html` is linked from nothing, disallowed in `robots.txt`, and sent with
`X-Robots-Tag: noindex, nofollow` by both header configs. It draws nothing until the API
confirms the signed-in address is staff, and the page itself never learns the list: staff
are the addresses in `ADMIN_EMAILS`, which is empty until someone with deploy credentials
fills it in, and every staff route re-checks it server-side. So the page is a convenience
view over data the server is guarding, not the thing doing the guarding.

## Screenshots

### Home
![Home](docs/screenshots/home.jpg)

### Menu
![Menu](docs/screenshots/menu.jpg)

### Book a table
![Book a table](docs/screenshots/book.jpg)

### About
![About](docs/screenshots/about.jpg)

### Contact
![Contact](docs/screenshots/contact.jpg)

### Sign up
![Sign up](docs/screenshots/signup.jpg)

All six are full-page captures at 1280px wide, taken in local mode, and they live in
`docs/` rather than `public/` so the deploy does not carry 1.6 MB of readme illustrations.
With the site served locally, `npm run screenshots` regenerates them — it drives headless
Chrome over the DevTools protocol, so there is nothing to install beyond a Chrome or Edge
already on the machine. `admin.html` is not among them: it is a staff view whose whole
content is behind a sign-in, so a capture of it would only ever show the gate.

## Features

- **Bookings that cannot oversell the room.** Thirty-two covers, 30-minute slots, a
  90-minute turn, and a last seating one turn before close — 21:00 on Sunday, 21:30
  midweek, 23:00 on Friday and Saturday. A reservation writes a row and increments a
  counter for each slot it occupies, and the guarantee is a `CHECK (covers <= 32)` in SQL
  rather than a count in application code: when two requests race for the last table, both
  read the same free space, and the second one's write violates the constraint and rolls
  back. No account is needed — a booking made while signed out is found afterwards by its
  `UF-XXXXXX` reference and the email address it was made with, and is adopted if that
  address later signs up.
- **Menu filtering that survives a reload.** The course chips are generated from each
  section's `data-label`, so adding a course to the HTML adds its chip. The active
  course and search term are mirrored into the URL
  (`menu.html?q=paneer&category=mains`), which makes a filtered view shareable, and the
  running count — "7 dishes in Mains" — is announced through a `role="status"` region.
- **Search degrades safely without JavaScript.** The header search is a real
  `<form action="menu.html" method="get">`, so it can still navigate to the complete,
  crawlable menu. The live search and course filters require JavaScript and the menu says so
  when scripting is unavailable.
- **Passwords are expensive to attack in both modes, by different means.** With a server,
  the browser sends the password over HTTPS once and the hash is scrypt (RFC 7914) at
  N=2^15, r=8, p=1 — memory-hard, so a stolen `users` table cannot be attacked by throwing
  parallel silicon at it. Without one, `crypto.subtle` derives PBKDF2-HMAC-SHA-256 at
  210,000 iterations in the page, which is the best a static site can do. Either way the
  salt is 16 random bytes per account and the plaintext is never stored. The server digest
  carries its own cost parameters, so raising them re-hashes each account on its next
  successful login instead of locking anybody out; the browser's record carries its
  algorithm name and upgrades the same way. Account creation is refused outright where Web
  Crypto is unavailable, rather than silently downgraded to something crackable.
- **Logging in cannot be used to enumerate addresses.** Every failure — unknown address,
  wrong password, a stored record that will not parse — answers with the same status, the
  same code and the same sentence. An address with no account still pays for a full scrypt
  derivation against a throwaway salt, so the fast path that would otherwise reveal
  "nobody here" does not exist.
- **The forms remember who you are.** Signed-in visitors get name and email prefilled on
  the booking and enquiry forms, including after "Send another", and every field is
  validated in the browser and then again on the server, against the same rules — there
  are tests asserting the two agree byte for byte.
- **Accessible by default.** Skip link, visible `:focus-visible` rings,
  `aria-current="page"`, an `aria-expanded` nav toggle, inline field errors wired up with
  `aria-describedby` and `aria-invalid`, and a `prefers-reduced-motion` branch on every
  transition. The nav toggle and the search button are 44px square, the search field 47px
  tall, full-size buttons 49px, and the stacked mobile nav rows 46px. The footer link
  lists are the one place under the 24px of WCAG 2.2 target size: those links are 16px
  tall and clear the rule through its spacing exception instead, with 29px between the
  centres of any two.
- **Nothing loaded from a third party.** Icons are CSS masks over inline SVG data URIs
  instead of an icon CDN, so the site has no external requests and no inline `style=""`
  or `innerHTML` anywhere — which is what lets the deployed CSP stay at
  `script-src 'self'; style-src 'self'`.
- **Responsive from 320px up**, with the nav collapsing to a toggle, the hero, menu
  toolbar and booking grid restacking, and the gallery reflowing.

## Running it

```bash
npm install && npm start
```

`tools/dev-server.mjs` serves `public/` and routes `/api/*` to the matching file in `api/`
the same way Vercel does, so a local run exercises the deployed code rather than a mock. It
starts with or without a database: with none, `/api/health` answers `db: false` and every
page falls back to `localStorage`. Then open <http://localhost:8080>.

To run it with a real backend, put a connection string in `.env` and create the schema:

```bash
cp .env.example .env
npm run db:init
npm start
```

`npm run db:init` applies `lib/schema.sql`. It is idempotent — every statement is
`IF NOT EXISTS` — so running it against an existing database is a no-op rather than a
mistake, which is what makes it safe to run on a deploy you are not sure about.

For the static half on its own, with no functions at all:

```bash
npm run serve
```

Opening `public/index.html` straight off disk works too, and is a supported mode rather
than a degraded one — but account creation needs a secure context (`https:` or
`http://localhost`) because it uses Web Crypto, and `file://` pages cannot reach the API
even if one is running.

## The API

Seven functions in `api/`, in Vercel's zero-config layout: the file path is the route, so
`api/auth/login.mjs` serves `POST /api/auth/login`. That is under the Hobby plan's cap of
twelve, and `npm run check` fails if a route is ever added past it, or if `main.js` calls a
path with no file behind it, or if a file exists that nothing calls.

| Route | Methods | What it does |
| --- | --- | --- |
| `/api/health` | `GET` `HEAD` | Is there a working backend here? Answers `200` either way |
| `/api/availability?date=` | `GET` | The slot grid for one service, plus the booking horizon, so the page takes its `min` and `max` from the server's rules instead of guessing them |
| `/api/bookings` | `POST` `GET` `DELETE` | Take a table; list your own, or look one up by `?reference=&email=`, or list a service with `?date=` as staff; cancel, given the reference and either the address it was booked with or the account that owns it |
| `/api/enquiries` | `POST` `GET` `PATCH` | Save an enquiry; read the last hundred and mark one handled, as staff |
| `/api/auth/signup` | `POST` | Create an account and sign in, `201` |
| `/api/auth/login` | `POST` | Sign in, or refuse with one sentence for every kind of failure |
| `/api/auth/session` | `GET` `DELETE` | Who is signed in; log out |

Shared across all of them, in `lib/`: JSON bodies with a size cap, `Cache-Control:
no-store` on every response, an `Origin` check on everything that writes, per-IP rate
limits in the database rather than in memory (a serverless function does not keep memory
between invocations), and one error shape — `{ error: { code, message } }` — so the client
has a single thing to read. Anything unexpected is logged server-side and answered as a
generic `500`; database errors never reach the browser.

## The database

Six tables in `lib/schema.sql`, applied by `npm run db:init` and never automatically:
serverless functions cold-start concurrently, and half a dozen of them racing to run DDL
is a good way to deadlock a fresh deploy. A missing schema is answered with a `503` that
names the fix instead.

| Table | What is in it |
| --- | --- |
| `users` | One row per account. Addresses are stored lowercased, and a `CHECK` asserts it, so a code path that forgets to normalise fails loudly instead of quietly creating a second account for the same person |
| `sessions` | SHA-256 digests of opaque random tokens, with an expiry. A leaked backup cannot be replayed as live sessions, and revoking one is a `DELETE` rather than a key rotation that logs everybody out |
| `enquiries` | Contact-form messages, `handled` once staff have dealt with one. `user_id` is `ON DELETE SET NULL`: closing an account should not delete a question the restaurant already answered |
| `bookings` | Reservations, `confirmed` or `cancelled`. The `UF-XXXXXX` reference is unique and is what a guest quotes — but on its own it is an identifier, not a credential, so finding or cancelling one also needs the address it was booked with, or the account that owns it |
| `slot_load` | Covers taken per 30-minute slot, with `CHECK (covers >= 0 AND covers <= 32)` |
| `rate_limits` | Windowed hit counters. In-process counters are useless here, because every cold start gets its own memory |

The ceiling in `slot_load` is `COVERS_TOTAL` from `lib/config.mjs`, and SQL cannot read a
JavaScript constant — so a test asserts the two still agree. The party range in `bookings`
is checked against the validator the same way.

Every environment variable is optional; `.env.example` is the annotated template.

| Variable | Effect |
| --- | --- |
| `DATABASE_URL` or `POSTGRES_URL` | The connection string. Both are read, because Vercel's Neon and Supabase integrations set the second one and a plain Postgres anywhere else sets the first. Unset means local mode |
| `ADMIN_EMAILS` | Comma-separated addresses that may read the staff routes. Empty by default, so nobody is staff until someone with deploy credentials says who is. Deliberately not a column: a promoted flag living in the database is one SQL mistake away from being self-assignable |
| `UF_INSECURE_COOKIES` | `1` drops `Secure` from the session cookie, which plain-`http://localhost` cannot honour. `npm start` sets it; the test suite pins it to `0` on purpose, so it can assert the flag is really there. Never set it on a deployed site |

## Checking it

```bash
npm run check
```

`tools/check.mjs` has no dependencies of its own and runs first inside `npm test`, which is
what gates the deploy workflow. It reads every
`.html` file in `public/` and fails on dead local links and `srcset` candidates,
`#fragments` that do not exist in the page they point at, duplicate or empty `id`s,
`<label for>` / `aria-controls` / `aria-describedby` / `aria-labelledby` pointing at
nothing, `<img>` without `alt`, inline `style=` attributes the deployed CSP would block,
an `<a>` nested inside a `<button>`, `target="_blank"` without `rel="noopener"`, missing
per-page metadata, a page added at the repo root where no host would publish it, and a file
the deploy configs promise gone missing from `public/`.

Then it checks the seams, which is where a rename actually hurts: every `'#id'`
`assets/js/main.js` queries must exist on some page, every `/api/...` path it calls must
have a file behind it in `api/`, every file in `api/` must be called by something, and
there must be no more than twelve of them. It finishes outside `public/` with the two host
configs — they must redirect the same paths at targets that exist, and the CSP in
`vercel.json` must match the one in `public/_headers` byte for byte. Because everything
resolves against `public/`, a path that passes here is a path that works on the deployed
site.

```
OK - 8 pages, 148 local links, 158 ids, 24 image references, all resolved.
```

```bash
npm test
```

That runs the check above and then 76 `node:test` cases. `test/api.test.mjs` drives the
real handlers over [PGlite](https://www.npmjs.com/package/@electric-sql/pglite) — Postgres
compiled to WebAssembly, in memory — so the HTTP tests exercise the same SQL a deploy runs,
with no database to install and no server to point at. It covers the routes end to end:
signing up and back in, why a
wrong password and an unknown address are refused identically, a session that has aged out,
a forged cookie, a cross-origin write, the rate limiter and what clears it, a booking
refused field by field, a date the restaurant cannot serve, a slot that has already gone,
SQL in a text field staying data, why a booking reference is an identifier and not a
credential, why the staff routes do not appear to exist for anybody else, and the last table
being taken twice, where the second attempt has to be refused and has to leave nothing
behind. That last one has a caveat the harness states out loud: PGlite has a single
connection, so two "concurrent" transactions there are really sequential. It proves the
`CHECK` constraint rejects the second write, which is the actual guarantee, but it cannot
reproduce two serverless instances racing.

`test/unit.test.mjs` is mostly contract tests, which are the ones that catch drift a
passing feature test would not: the covers ceiling in SQL against `lib/config.mjs`, the
email pattern in the browser against the server's byte for byte, the `<option>`s in the
party select against the range the API accepts, the reference alphabet in `main.js` against
the generator's, the service rules `book.html` draws its grid from against the ones
bookings are made with, and every `*.html` the client names against what is on disk.

The last check needs the site running, because it drives a real browser:

```bash
npm run responsive
```

`tools/responsive.mjs` loads all eight pages at 25 viewport widths from 320px to 1920px, in
both the signed-out and signed-in states, and fails on two things a screenshot at one
width never shows. The first is a page wider than its viewport — it names the offending
elements by tag and first class. The second is the desktop header spilling onto a second
row, which means the breakpoint that swaps in the nav toggle is set too low. That one
needs its own assertion: every child of the header is `flex-shrink: 0` and the header may
wrap, so a header that no longer fits takes a second row instead of scrolling the
document sideways, and the overflow check stays silent.

The signed-in half is the half that matters, because that header is the wide one — an
avatar, a name and a Log out button instead of two short links — so the sweep seeds an
account whose first name is long enough to hit the `max-width` on the name, and then
asserts the header actually rendered signed in. Without that assertion a seed that no
longer matches `main.js` turns the pass into a second signed-out sweep that reports clean.
It also stubs `/api/` to refuse, which pins every run to local mode: otherwise the same
command would measure different pages on a machine that happens to have `DATABASE_URL` set,
and the localStorage seed would be ignored in favour of a session cookie that is not there.

It keeps the browser's real scrollbar, which matters more than it sounds. A classic
scrollbar takes 15px off the layout viewport without taking it off what a media query
measures, so a header sized against the media-query width alone wraps in that gap — which
is exactly the bug this found, twice: once at the toggle breakpoint, and again when a fifth
nav item was added and the compact header stopped fitting under 1160px.

```
OK - no overflow and no wrapped header in 400 combinations (8 pages x 25 widths x 2 sign-in states).
```

`responsive.mjs` and `screenshots.mjs` share `tools/cdp.mjs`, a small DevTools-protocol
client over Node's built-in `WebSocket` — so neither needs a package installed, but both
need a supported Node.js release (currently Node 22 through before Node 25, as declared in
`package.json`). (`npm run check` uses nothing beyond `node:fs` and runs on any supported
version.) They find Chrome or Edge themselves on Windows, macOS, and Linux; set `CHROME_PATH`
to override, and `BASE_URL` if the site is not on `http://localhost:8080`.

## Deploying

`public/` is the published site on every host. `api/` and `lib/` are the backend, and only
one of the three hosts can run them — which is the whole reason the fallback exists.
Nothing else in the repo (`tools/`, `docs/`, `media/`, `test/`, this readme) is deployed
anywhere.

| Host | Config in the repo | Steps | Backend |
| --- | --- | --- | --- |
| Vercel | `vercel.json` | Import the repo, framework preset "Other", no build command. `outputDirectory` is already `public` | Yes — `api/**.mjs` becomes seven functions. Add `DATABASE_URL` (or use the Neon / Supabase integration, which sets `POSTGRES_URL`), then run `npm run db:init` against it once |
| Netlify | `netlify.toml`, `public/_headers` | Connect the repo. The build command is a no-op and the publish directory is `public` | No — the functions are Vercel-shaped, so `/api/health` returns the 404 page and every feature runs on `localStorage` |
| GitHub Pages | `.github/workflows/deploy.yml`, `public/.nojekyll` | Push to `main`, then Settings → Pages → Source: GitHub Actions | No, and no response headers either |

Vercel and Netlify both apply the security headers — CSP, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`,
`Strict-Transport-Security` — plus cache rules that keep HTML revalidating on every request
while images are `immutable` for a year, and `X-Robots-Tag: noindex` on the staff page. HSTS
is one year on the serving host only: it leaves out `includeSubDomains` and `preload` on
purpose, because those options can affect sibling services and are not easily reversible.
Those two configs also 301 the short `/book` path and the legacy `/about`, `/reservations`
and `/register` ones at their current pages. The API responses set their own
`Cache-Control: no-store` in code, because a host's static cache rules do not reach a
function.

**GitHub Pages can do none of that**: it cannot set response headers and it cannot
redirect, so there the CSP, the cache policy and the four short paths are simply absent. The
site behaves the same; it is just not header-hardened, and an old bookmark 404s instead of
forwarding. The workflow runs `npm test` before publishing, so a broken link, a broken
contract or a failing API test stops the deploy.

`robots.txt` allows crawling without claiming a domain-specific sitemap, and disallows
`/admin.html` and `/api/`; add a sitemap after choosing the final public domain. No check in
this repo can validate real business details, so the pages use clearly fictional sample
contact details until there are real ones to put there.

## Structure

Three groups, and the split is one decision each time: `public/` is the artifact, `api/` and
`lib/` are the backend, everything else is how it gets checked. That is why the tooling can
never be served by accident, and why the deploy config for all three hosts is a single
directory name.

```
urban-flame/
├── public/                      Everything the site serves - and nothing else
│   ├── index.html  menu.html  book.html  aboutus.html
│   ├── contact.html  signup.html  admin.html  404.html
│   ├── assets/
│   │   ├── css/
│   │   │   ├── site.css         Design tokens and everything shared
│   │   │   ├── index.css        One stylesheet per page, loaded after site.css
│   │   │   ├── menu.css  book.css  aboutus.css
│   │   │   └── contact.css  signup.css  admin.css
│   │   ├── js/main.js           Nav, search, menu filter, accounts, bookings,
│   │   │                        forms, toasts - and the localStorage fallback
│   │   └── img/                 JPEG + WebP twin for each photo
│   ├── favicon.svg  robots.txt
│   ├── _headers                 Netlify and Cloudflare response headers
│   └── .nojekyll
├── api/                         One file per route, Vercel's zero-config layout
│   ├── health.mjs  availability.mjs  bookings.mjs  enquiries.mjs
│   └── auth/signup.mjs  auth/login.mjs  auth/session.mjs
├── lib/                         What the functions share, and nothing HTTP-shaped
│   ├── schema.sql               The whole database, idempotent
│   ├── config.mjs               Every env var and service rule, in one place
│   ├── db.mjs                   Pooled Postgres, one query helper set
│   ├── http.mjs                 Bodies, errors, cookies, origin checks
│   ├── validate.mjs             The rules the browser also enforces
│   ├── passwords.mjs  sessions.mjs  users.mjs
│   └── bookings.mjs  slots.mjs  ratelimit.mjs
├── test/
│   ├── api.test.mjs             The routes over PGlite, in memory
│   ├── unit.test.mjs            Units, and the browser/server contracts
│   └── helpers.mjs              Harness: temp database, request, cookie jar
├── tools/
│   ├── dev-server.mjs           Static files + api/ routing - npm start
│   ├── db-init.mjs              Applies lib/schema.sql - npm run db:init
│   ├── env.mjs                  Reads .env for the two scripts above
│   ├── check.mjs                Links, ids, metadata, contracts - npm run check
│   ├── responsive.mjs           Overflow and header-wrap sweep - npm run responsive
│   ├── screenshots.mjs          Recaptures docs/screenshots/ - npm run screenshots
│   ├── cdp.mjs                  DevTools client those last two share
│   └── optimize_images.py       Builds public/assets/img/ from media/originals/
├── media/originals/             Camera-resolution sources, gitignored, never served
├── docs/screenshots/            Preview images used in this readme
├── .github/workflows/deploy.yml Test, then publish public/ to Pages
├── netlify.toml  vercel.json    Host configuration
├── .env.example                 Annotated template for the three env vars
└── package.json  package-lock.json  .editorconfig  .gitignore  LICENSE  README.md
```

`assets/css/site.css` holds the custom-property tokens and every shared piece — reset,
layout shell, header, footer, buttons, form controls, toasts, utilities. Each page loads
exactly one page-specific stylesheet after it, and nothing outside `site.css` styles a bare
element selector. That split is what stops one page's rules leaking into another.

The CSS and JS in `public/` stay as one shared file each rather than being split by concern,
and that is deliberate: with no build step and `file://` support to keep, ES modules are off
the table (a module fetch from `file://` is blocked as cross-origin), so splitting would mean
a growing list of order-dependent `<script>` and `<link>` tags repeated across eight pages.
One file with explicit section dividers is the cleaner trade at this size. `api/` and `lib/`
are under no such constraint — they run in Node, never in a browser — so they are ordinary
ES modules, one concern per file.

Every file under `public/` and `tools/` is pure ASCII with LF endings, so an em dash is
`&#8212;` in markup and a numeric `\u` escape in JavaScript. The site is served with no
build step and has to render from `file://`, where there is no charset header to fall back
on; ASCII source removes the guess. This readme is the exception, because it is never
served.

## Storage in local mode

With no server, everything lives in the browser under six keys:

| Key | Where | Contents |
| --- | --- | --- |
| `uf_accounts` | localStorage | One record per account, keyed by lowercased email: name, phone, salt, hash, algorithm, `createdAt` |
| `uf_session` | localStorage | The email of whoever is signed in, as a bare JSON string |
| `uf_bookings` | localStorage | Table requests made in this browser, with their references |
| `uf_messages` | localStorage | Enquiries submitted from the contact page, capped at the most recent 50 |
| `uf_flash` | sessionStorage | A one-shot toast handed across a redirect, deleted as it is read |
| `uf_mode` | sessionStorage | The cached answer to "is there a backend", so the question is asked once per tab |

A session whose email no longer has an account clears itself on the next page load, so
deleting an account cannot leave the header signed in to nothing. In server mode all of this
is bypassed: `uf_mode` still caches the verdict, `uf_flash` still carries toasts, and the
rest is the database's job.

An earlier version of this project kept accounts under `uf_users` **with passwords in
plaintext**. `public/assets/js/main.js` deletes that key on load, so opening the current
build once is enough to clear it. Those old accounts do not migrate — sign up again.

Local mode is not authentication. There is no server to check anything, and anyone with
devtools can read or rewrite localStorage. Use a throwaway password.

## Images

`media/originals/` keeps the camera-resolution sources — around 47 MB — and is gitignored.
It sits outside `public/`, so there is no arrangement of deploy settings under which those
files could be served. `npm run images` runs `tools/optimize_images.py` (needs
[Pillow](https://pypi.org/project/pillow/)) and regenerates everything the site actually
serves into `public/assets/img/`: a cropped, resized, progressive JPEG plus a WebP twin,
1200px wide for photos and 1920px for the background. That comes to 1.8 MB for all seven
images. Pages reach for the WebP first through `<picture>` on content images and
`image-set()` on the background, falling back to the JPEG where it is not supported.

Every `<img>` carries `width` and `height` so the layout does not shift while images
load. Those attributes become low-specificity CSS, which is why `site.css` sets
`img { height: auto }` globally — without it any rule that touches only `width` leaves
the intrinsic pixel height in place and the photo stretches.

## Limitations

- **The content is sample copy.** The dishes, prices, hours, address, phone and email are
  fictional details for this project, and the pages say so rather than pretending otherwise.
- **Nothing is emailed.** A confirmed booking shows its reference on screen and is in the
  database; there is no mail provider wired up, so nobody receives anything. The copy is
  written to match.
- **Local mode is one browser, and is not authentication.** Clear the site data and the
  accounts, bookings and enquiries in it are gone. Anyone with devtools can rewrite them.
- **`admin.html` is a convenience, not a boundary.** The gate in the page is cosmetic; what
  actually protects the data is that every staff route re-checks `ADMIN_EMAILS` server-side.
- **Payments, deposits and no-show handling are out of scope**, as is any table-by-table
  floor plan: the room is modelled as 32 covers, not as individual tables.
- **GitHub Pages and Netlify get no backend**, by construction. That is a supported mode
  rather than a broken deploy, but it is worth knowing which URL is which.

## Author

Guna Rithvick

## License

MIT — see [LICENSE](LICENSE).
