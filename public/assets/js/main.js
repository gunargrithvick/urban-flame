/* ==========================================================================
   Urban Flame - shared front-end behaviour.

   Runs two ways from one file. When /api/health answers, accounts, enquiries
   and bookings are the server's; when it does not - a file:// preview, a static
   host, a deploy with no database - the same features fall back to this
   browser's localStorage and the copy on the page says so. See README.

   Written in ES5 syntax on purpose: no build step, no modules, and the pages
   load it with a plain <script src>.
   ========================================================================== */

(function () {
  'use strict';

  var ACCOUNTS_KEY = 'uf_accounts';
  var SESSION_KEY = 'uf_session';
  var MESSAGES_KEY = 'uf_messages';
  var BOOKINGS_KEY = 'uf_bookings';
  var FLASH_KEY = 'uf_flash';
  var MODE_KEY = 'uf_mode';
  /* v1 kept every password in plain text under this key, and handed every
     account the same hardcoded password. Purged on load. */
  var LEGACY_KEYS = ['uf_users'];

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

  /*
   * The service rules, mirrored from lib/config.mjs.
   *
   * Only used when there is no server to ask: the slot grid still has to draw
   * the right times on a file:// copy. test/unit.test.mjs reads these numbers
   * out of this file and compares them with the module, so the mirror cannot
   * quietly drift - and the server remains the only thing that decides whether
   * a table is actually free.
   */
  var SERVICE = {
    coversTotal: 32,
    openMinutes: 660,
    closeMinutes: [1350, 1380, 1380, 1380, 1380, 1470, 1470],
    slotMinutes: 30,
    turnMinutes: 90,
    partyMin: 1,
    partyMax: 12,
    horizonDays: 60,
    tzOffset: '+05:30'
  };

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /* ----------------------------------------------------------------------
     Storage. localStorage throws in some privacy modes and can hold
     corrupted JSON, so every access is guarded - a broken store must
     degrade the feature, not the page.
     ---------------------------------------------------------------------- */

  var store = {
    read: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },
    write: function (key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) {
        return false;
      }
    },
    remove: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (err) {
        /* nothing to clean up */
      }
    }
  };

  /* ----------------------------------------------------------------------
     Backend or browser.

     Which of the two the page is running against is decided once per tab by
     asking /api/health, and remembered in sessionStorage so a visitor moving
     between pages does not watch the header change its mind on every load.
     Nothing security-relevant is cached: the session cookie is HttpOnly and
     the server re-reads it on every request. The cached user is for the first
     paint only, and is replaced by whatever /api/auth/session says.
     ---------------------------------------------------------------------- */

  var mode = 'local';
  var serverUser = null;
  var modeSettled = false;
  var modeWatchers = [];

  function cachedMode() {
    try {
      var raw = window.sessionStorage.getItem(MODE_KEY);
      var data = raw ? JSON.parse(raw) : null;
      if (!data || (data.mode !== 'server' && data.mode !== 'local')) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function cacheMode() {
    try {
      window.sessionStorage.setItem(MODE_KEY, JSON.stringify({ mode: mode, user: serverUser }));
    } catch (err) {
      /* An extra round trip on the next page is the whole cost. */
    }
  }

  function serving() {
    return mode === 'server';
  }

  /*
   * One request, one shape: { status, body }.
   *
   * A rejected promise means there is no server to talk to, which is a normal
   * state for this site rather than an error, so callers get status 0 and no
   * body instead of having to catch. credentials is same-origin already for a
   * relative URL; naming it keeps the intent obvious next to the CSRF headers
   * the browser adds by itself (Sec-Fetch-Site, which lib/http.mjs reads).
   */
  function apiSend(method, path, body) {
    if (!apiUsable()) return Promise.resolve({ status: 0, body: null });

    var options = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    return window.fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        var parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (err) {
          parsed = null;
        }
        return { status: res.status, body: parsed };
      });
    }).catch(function () {
      return { status: 0, body: null };
    });
  }

  /* file:// is the one origin where a relative /api/ path cannot resolve to
     anything, so the probe is skipped rather than made and failed - it would
     only add a console error to every page of a local preview. */
  function apiUsable() {
    return typeof window.fetch === 'function' && window.location.protocol !== 'file:';
  }

  function probe() {
    return apiSend('GET', '/api/health').then(function (res) {
      var body = res.body || {};
      return res.status === 200 && body.ok === true && body.db === true && body.schema === true;
    });
  }

  function refreshServerUser() {
    return apiSend('GET', '/api/auth/session').then(function (res) {
      serverUser = (res.status === 200 && res.body && res.body.user) || null;
      cacheMode();
      return serverUser;
    });
  }

  /* Registered by whatever on the page cannot draw itself until the verdict is
     in - the slot grid, the staff gate. Fired once, then dropped: a later
     login is a session change, not a mode change. */
  function onMode(fn) {
    if (modeSettled) run(fn);
    else modeWatchers.push(fn);
  }

  /* Each of these renders one independent widget from state that is already in
     hand. One of them throwing is a bug in that widget; letting it take the
     rest of the page down with it turns a small bug into a blank screen. */
  function run(fn) {
    try {
      fn();
    } catch (err) {
      /* deliberately swallowed - see above */
    }
  }

  function settleMode(next) {
    mode = next;
    if (!serving()) serverUser = null;
    modeSettled = true;
    cacheMode();
    applyModeCopy();
    sessionChanged();
    var pending = modeWatchers;
    modeWatchers = [];
    pending.forEach(run);
  }

  function resolveMode() {
    if (!apiUsable()) {
      settleMode('local');
      return;
    }
    probe().then(function (up) {
      if (!up) {
        settleMode('local');
        return null;
      }
      mode = 'server';
      return refreshServerUser().then(function () {
        settleMode('server');
      });
    });
  }

  /*
   * Copy that is only true in one of the two modes.
   *
   * data-server-text holds the server wording and the element's own text is the
   * browser-only wording, so a page with JavaScript off shows the honest "this
   * is not going anywhere" version. data-when hides a whole block. Both are
   * declarative on purpose: the alternative is forty sentences spelled out in
   * here, drifting from the pages they belong to.
   */
  function applyModeCopy() {
    var wanted = serving() ? 'server' : 'local';

    $$('[data-server-text]').forEach(function (node) {
      if (typeof node.dataset.localText !== 'string') node.dataset.localText = node.textContent;
      node.textContent = serving() ? node.dataset.serverText : node.dataset.localText;
    });

    $$('[data-when]').forEach(function (node) {
      node.hidden = node.dataset.when !== wanted;
    });
  }

  /* Called after anything that changes who is signed in, in either mode. */
  function sessionChanged() {
    renderSession();
    renderAccountCard();
    run(renderMyBookings);
    run(renderAdmin);
  }

  /* ----------------------------------------------------------------------
     Toasts and cross-page flash messages (replace blocking alert() calls)
     ---------------------------------------------------------------------- */

  var toastStack = null;

  function toast(message, kind) {
    if (!message) return;
    if (!toastStack) {
      toastStack = document.createElement('div');
      toastStack.className = 'toast-stack';
      toastStack.setAttribute('role', 'status');
      toastStack.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastStack);
    }
    var note = document.createElement('p');
    note.className = 'toast toast--' + (kind || 'info');
    note.textContent = message;
    toastStack.appendChild(note);
    window.setTimeout(function () {
      note.classList.add('is-leaving');
      window.setTimeout(function () {
        if (note.parentNode) note.parentNode.removeChild(note);
      }, 240);
    }, 4800);
  }

  function setFlash(message, kind) {
    try {
      window.sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message: message, kind: kind }));
    } catch (err) {
      /* the toast is a nicety, not a requirement */
    }
  }

  function showFlash() {
    var data = null;
    try {
      var raw = window.sessionStorage.getItem(FLASH_KEY);
      if (raw) {
        data = JSON.parse(raw);
        window.sessionStorage.removeItem(FLASH_KEY);
      }
    } catch (err) {
      data = null;
    }
    if (data && data.message) toast(data.message, data.kind);
  }

  /* ----------------------------------------------------------------------
     Text helpers
     ---------------------------------------------------------------------- */

  function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0] || 'there';
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (!parts.length) return '?';
    return parts.map(function (part) {
      return part.charAt(0).toUpperCase();
    }).join('');
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return 'Recently';
    try {
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (err) {
      return date.toDateString();
    }
  }

  function setText(selector, value) {
    var node = $(selector);
    if (node) node.textContent = value;
  }

  /* ----------------------------------------------------------------------
     Passwords. Still a browser-only demo, but nothing readable is stored:
     each account gets a random salt and a deliberately slow PBKDF2 digest.
     There is no insecure fallback: account creation requires Web Crypto.
     ---------------------------------------------------------------------- */

  var PBKDF2_ITERATIONS = 210000;

  function randomSalt() {
    var bytes = new Uint8Array(16);
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return null;
    try {
      window.crypto.getRandomValues(bytes);
    } catch (err) {
      return null;
    }
    return toHex(bytes);
  }

  function toHex(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return out;
  }

  function fromHex(value) {
    var bytes = new Uint8Array(value.length / 2);
    for (var i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function derive(password, salt) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof subtle.importKey !== 'function' ||
        typeof subtle.deriveBits !== 'function' || typeof TextEncoder !== 'function') {
      return Promise.reject(new Error('Secure password storage is unavailable in this browser.'));
    }

    var encoder = new TextEncoder();
    return subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    ).then(function (key) {
      return subtle.deriveBits({
        name: 'PBKDF2',
        salt: fromHex(salt),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      }, key, 256);
    }).then(function (bits) {
      return { algo: 'pbkdf2-sha-256', hash: toHex(bits) };
    });
  }

  function deriveLegacySha256(password, salt) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function' || typeof TextEncoder !== 'function') {
      return Promise.reject(new Error('Legacy password verification is unavailable.'));
    }
    var payload = 'urban-flame:' + salt + ':' + password;
    return subtle.digest('SHA-256', new TextEncoder().encode(payload)).then(function (digest) {
      return toHex(digest);
    });
  }

  function verify(account, password) {
    if (!account || !account.salt || !account.hash) {
      return Promise.resolve(false);
    }
    if (account.algo === 'sha-256') {
      return deriveLegacySha256(password, account.salt).then(function (hash) {
        return hash === account.hash;
      }).catch(function () {
        return false;
      });
    }
    if (account.algo !== 'pbkdf2-sha-256') return Promise.resolve(false);
    return derive(password, account.salt).then(function (result) {
      return result.algo === account.algo && result.hash === account.hash;
    }).catch(function () {
      return false;
    });
  }

  /* ----------------------------------------------------------------------
     Accounts and session
     ---------------------------------------------------------------------- */

  function normalizeEmail(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function readAccounts() {
    /* Reparented, because a lookup on a plain object also finds what it
       inherits: a uf_session of "constructor" or "toString" would resolve to an
       Object.prototype member, read as a real record, and leave the header
       signed in to a name no account has - the one case where the
       clears-itself-on-next-load guarantee below would not hold. Both exits
       reparent, since no accounts at all is the case that hole is widest in. */
    var accounts = Object.create(null);
    var data = store.read(ACCOUNTS_KEY, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return accounts;
    Object.keys(data).forEach(function (key) {
      accounts[key] = data[key];
    });
    return accounts;
  }

  /* Whoever is signed in, whichever half of the site is answering. In server
     mode this is the last thing /api/auth/session said - the cookie behind it
     is HttpOnly, so there is nothing here to read directly - which is why every
     path that changes it ends in sessionChanged(). */
  function currentUser() {
    if (serving()) return serverUser;

    var email = store.read(SESSION_KEY, null);
    if (typeof email !== 'string' || !email) return null;
    var account = readAccounts()[email];
    if (!account) {
      /* Session pointed at an account that no longer exists. */
      store.remove(SESSION_KEY);
      return null;
    }
    return {
      email: email,
      name: account.name || email,
      phone: account.phone || '',
      createdAt: account.createdAt || '',
      isAdmin: false
    };
  }

  function logout() {
    if (serving()) {
      apiSend('DELETE', '/api/auth/session').then(function (res) {
        if (res.status !== 200) {
          toast('Could not sign you out. Please try again.', 'error');
          return;
        }
        serverUser = null;
        cacheMode();
        sessionChanged();
        toast('You have been logged out.', 'ok');
      });
      return;
    }
    store.remove(SESSION_KEY);
    sessionChanged();
    toast('You have been logged out.', 'ok');
  }

  function upgradeLegacyAccount(email, password) {
    var accounts = readAccounts();
    var account = accounts[email];
    if (!account || account.algo !== 'sha-256') return;
    derive(password, account.salt).then(function (result) {
      var latest = readAccounts();
      if (!latest[email] || latest[email].algo !== 'sha-256') return;
      latest[email].algo = result.algo;
      latest[email].hash = result.hash;
      store.write(ACCOUNTS_KEY, latest);
    }).catch(function () {
      /* A successful legacy login remains valid; upgrade can retry next time. */
    });
  }

  /* ----------------------------------------------------------------------
     Form validation helpers
     ---------------------------------------------------------------------- */

  function setError(input, message) {
    if (!input) return;
    var holder = input.closest ? input.closest('.field') : null;
    var slot = holder ? $('.field-error', holder) : null;
    if (slot) slot.textContent = message || '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function clearErrors(form) {
    $$('.field-error', form).forEach(function (slot) {
      slot.textContent = '';
    });
    $$('[aria-invalid]', form).forEach(function (input) {
      input.removeAttribute('aria-invalid');
    });
  }

  /* The header is sticky and 73px tall, so the browser counts the strip behind
     it as "already visible": focus() on an element sitting there scrolls
     nowhere and leaves it hidden. Measured after the focus, because focus may
     have scrolled already - and only then scroll, so a field that is plainly in
     view does not jump. CSS scroll-margin-top parks the target clear of the
     header. Not for anything inside the header itself, which is always visible
     but always reads as occluded by this test. */
  function revealBelowHeader(el) {
    if (!el || !el.getBoundingClientRect) return;
    var header = $('.site-header');
    var guard = header ? header.getBoundingClientRect().bottom : 0;
    var box = el.getBoundingClientRect();
    if (box.top < guard || box.bottom > window.innerHeight) el.scrollIntoView();
  }

  function focusFirstError(form) {
    var first = $('[aria-invalid="true"]', form);
    if (!first) return;
    first.focus();
    revealBelowHeader(first);
  }

  function busy(button, isBusy, busyLabel) {
    if (!button) return;
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = busyLabel || 'Working\u2026';
      button.disabled = true;
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
    }
  }

  /* apiSend answers with status 0 when there was nothing there to reply. Once
     the mode has settled on the server that means the deploy has gone away
     mid-visit, and saying so is better than quietly falling back to
     localStorage - which would stop holding tables the page just promised to
     hold, without telling anyone. */
  var OFFLINE_NOTE = 'The reservations service is not answering. Please try again in a moment.';

  /*
   * A refused request, shown where the visitor can act on it.
   *
   * The server replies with { error: { code, message, fields } } and its field
   * names are lib/validate.mjs's, so each form hands over a map from those
   * names to its own inputs. Anything with no field - a 401, a 429, a 503 - is
   * not about one input and goes to a toast instead.
   */
  function showApiError(form, map, res, fallback) {
    var error = (res && res.body && res.body.error) || null;
    var fields = (error && error.fields) || null;
    var placed = false;

    if (fields) {
      Object.keys(fields).forEach(function (key) {
        if (!map[key]) return;
        setError(map[key], fields[key]);
        placed = true;
      });
    }

    if (placed) {
      focusFirstError(form);
      return;
    }
    toast((error && error.message) || (res && res.status === 0 ? OFFLINE_NOTE : fallback), 'error');
  }

  /* ----------------------------------------------------------------------
     Header: mobile nav, session slot, footer year
     ---------------------------------------------------------------------- */

  function renderSession() {
    var slot = $('#session');
    if (!slot) return;
    var user = currentUser();
    slot.textContent = '';

    if (user) {
      var badge = document.createElement('span');
      badge.className = 'session-user';

      var avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = initials(user.name);

      var label = document.createElement('span');
      label.className = 'session-name';
      label.textContent = firstName(user.name);

      badge.appendChild(avatar);
      badge.appendChild(label);

      var out = document.createElement('button');
      out.type = 'button';
      out.className = 'button button--ghost button--small';
      out.textContent = 'Log out';
      out.addEventListener('click', logout);

      slot.appendChild(badge);
      slot.appendChild(out);
    } else {
      var login = document.createElement('a');
      login.className = 'button button--ghost button--small';
      login.href = 'index.html#login';
      login.textContent = 'Log in';

      var join = document.createElement('a');
      join.className = 'button button--primary button--small';
      join.href = 'signup.html';
      join.textContent = 'Sign up';

      slot.appendChild(login);
      slot.appendChild(join);
    }

    slot.hidden = false;
  }

  function initHeader() {
    var toggle = $('#nav-toggle');
    var nav = $('#site-nav');

    if (toggle && nav) {
      toggle.addEventListener('click', function () {
        var open = nav.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });

      /* Leaving the mobile breakpoint with the panel open would strand
         aria-expanded="true" on a nav that is permanently visible. Keep this
         in step with the header breakpoint in css/site.css. */
      var wide = window.matchMedia('(min-width: 941px)');
      var sync = function () {
        if (!wide.matches) return;
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      };
      if (typeof wide.addEventListener === 'function') wide.addEventListener('change', sync);
      else if (typeof wide.addListener === 'function') wide.addListener(sync);
    }

    $$('[data-year]').forEach(function (node) {
      node.textContent = String(new Date().getFullYear());
    });

    renderSession();
  }

  /* ----------------------------------------------------------------------
     Menu: live search + category filters
     ---------------------------------------------------------------------- */

  var menuState = { term: '', category: 'all' };

  function indexMenuItems() {
    $$('.menu-item').forEach(function (item) {
      var name = $('.item-name', item);
      var desc = $('.item-description', item);
      var tags = $$('.tag', item).map(function (tag) {
        return tag.textContent;
      }).join(' ');
      item.dataset.search = [
        name ? name.textContent : '',
        desc ? desc.textContent : '',
        tags
      ].join(' ').toLowerCase();
    });
  }

  function findCategory(value) {
    /* Looked up by scanning rather than by building a selector string: the
       value can come from ?category= and would break querySelector. */
    var match = null;
    $$('.menu-category').forEach(function (section) {
      if (section.dataset.category === value) match = section;
    });
    return match;
  }

  function categoryLabel(value) {
    if (value === 'all') return '';
    var section = findCategory(value);
    return section ? section.dataset.label || value : value;
  }

  function updateMenuStatus(count, term) {
    var noun = count === 1 ? 'dish' : 'dishes';
    var label = categoryLabel(menuState.category);
    var text;

    if (term && label) text = count + ' ' + noun + ' in ' + label + ' matching \u201c' + term + '\u201d';
    else if (term) text = count + ' ' + noun + ' matching \u201c' + term + '\u201d';
    else if (label) text = count + ' ' + noun + ' in ' + label;
    else text = count + ' ' + noun + ' on the menu';

    setText('#menu-status', text);

    var empty = $('#menu-empty');
    if (empty) empty.hidden = count !== 0;
    setText('#menu-empty-term', term ? '\u201c' + term + '\u201d' : 'that filter');
  }

  function applyMenuFilters() {
    var input = $('#site-search');
    var term = (input ? input.value : menuState.term).trim();
    var needle = term.toLowerCase();
    menuState.term = term;
    var total = 0;

    $$('.menu-category').forEach(function (section) {
      var inCategory = menuState.category === 'all' || section.dataset.category === menuState.category;
      var shown = 0;

      $$('.menu-item', section).forEach(function (item) {
        var match = inCategory && (!needle || (item.dataset.search || '').indexOf(needle) !== -1);
        item.hidden = !match;
        if (match) shown += 1;
      });

      section.hidden = shown === 0;
      total += shown;
    });

    updateMenuStatus(total, term);
    syncMenuUrl();
  }

  /* Keeps a filtered view shareable. Blocked on some file:// origins, so it
     is best-effort only. */
  function syncMenuUrl() {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    var params = new URLSearchParams();
    if (menuState.term) params.set('q', menuState.term);
    if (menuState.category !== 'all') params.set('category', menuState.category);
    var query = params.toString();
    try {
      window.history.replaceState(null, '', query ? '?' + query : window.location.pathname);
    } catch (err) {
      /* leave the address bar alone */
    }
  }

  function selectCategory(value) {
    menuState.category = value;
    $$('#menu-chips .chip').forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.dataset.category === value ? 'true' : 'false');
    });
    applyMenuFilters();
  }

  function buildChips() {
    var holder = $('#menu-chips');
    if (!holder) return;

    var options = [{ value: 'all', label: 'All dishes' }];
    $$('.menu-category').forEach(function (section) {
      if (!section.dataset.category) return;
      options.push({ value: section.dataset.category, label: section.dataset.label || section.dataset.category });
    });

    holder.textContent = '';
    options.forEach(function (option) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.category = option.value;
      chip.textContent = option.label;
      chip.setAttribute('aria-pressed', option.value === menuState.category ? 'true' : 'false');
      chip.addEventListener('click', function () {
        selectCategory(option.value);
      });
      holder.appendChild(chip);
    });

    holder.hidden = false;
  }

  function initMenu() {
    var list = $('#menu-list');
    if (!list) return false;

    indexMenuItems();

    var params = new URLSearchParams(window.location.search);
    var query = (params.get('q') || '').trim();
    var category = (params.get('category') || '').trim();
    var input = $('#site-search');

    if (query) {
      menuState.term = query;
      if (input) input.value = query;
    }
    if (category && findCategory(category)) {
      menuState.category = category;
    }

    buildChips();

    if (input) {
      input.addEventListener('input', applyMenuFilters);
    }

    var reset = $('#menu-reset');
    if (reset) {
      reset.addEventListener('click', function () {
        if (input) input.value = '';
        menuState.term = '';
        selectCategory('all');
        if (input) input.focus();
      });
    }

    applyMenuFilters();
    return true;
  }

  /* ----------------------------------------------------------------------
     Search box. The markup is a real GET form pointing at menu.html, so it
     still works without JavaScript; here we intercept it to filter in place
     on the menu page and to navigate reliably from file:// elsewhere.
     ---------------------------------------------------------------------- */

  function initSearch(onMenuPage) {
    var form = $('#search-form');
    var input = $('#site-search');
    if (!form || !input) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var term = input.value.trim();
      if (onMenuPage) {
        applyMenuFilters();
        return;
      }
      window.location.href = term ? 'menu.html?q=' + encodeURIComponent(term) : 'menu.html';
    });
  }

  /* ----------------------------------------------------------------------
     Log in (home page)
     ---------------------------------------------------------------------- */

  function initLogin() {
    var form = $('#login-form');
    if (!form) return;

    var emailInput = $('#login-email');
    var passInput = $('#login-password');
    var submit = $('button[type="submit"]', form);
    if (submit) submit.disabled = false;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearErrors(form);

      var email = normalizeEmail(emailInput.value);
      var password = passInput.value;
      var invalid = false;

      if (!email) {
        setError(emailInput, 'Enter your email address.');
        invalid = true;
      } else if (!EMAIL_RE.test(email)) {
        setError(emailInput, 'That does not look like a valid email address.');
        invalid = true;
      }
      if (!password) {
        setError(passInput, 'Enter your password.');
        invalid = true;
      }
      if (invalid) {
        focusFirstError(form);
        return;
      }

      if (serving()) {
        busy(submit, true, 'Checking\u2026');
        apiSend('POST', '/api/auth/login', { email: email, password: password }).then(function (res) {
          busy(submit, false);

          if (res.status === 200 && res.body && res.body.user) {
            serverUser = res.body.user;
            cacheMode();
            form.reset();
            clearErrors(form);
            sessionChanged();
            toast('Welcome back, ' + firstName(serverUser.name) + '.', 'ok');
            return;
          }

          /* The refusal sentence is the server's, and it says only that the
             pair does not match: naming which half was wrong is the whole
             enumeration attack api/auth/login.mjs is written to avoid. A 429 or
             an unreachable deploy is not about the password, so it goes to a
             toast rather than under a field. */
          if (res.status === 401) {
            setError(passInput, (res.body && res.body.error && res.body.error.message) ||
              'That email address and password do not match an account.');
            passInput.value = '';
            passInput.focus();
            revealBelowHeader(passInput);
            return;
          }

          showApiError(form, {}, res, 'Could not sign you in. Please try again.');
        });
        return;
      }

      var accounts = readAccounts();
      if (!Object.keys(accounts).length) {
        setError(emailInput, 'No account exists in this browser yet \u2014 sign up first.');
        focusFirstError(form);
        return;
      }

      var account = accounts[email];
      busy(submit, true, 'Checking\u2026');

      verify(account, password).then(function (ok) {
        busy(submit, false);
        if (!ok) {
          setError(passInput, 'Email or password is incorrect.');
          passInput.value = '';
          passInput.focus();
          revealBelowHeader(passInput);
          return;
        }
        if (!store.write(SESSION_KEY, email)) {
          toast('This browser is blocking local storage, so the session cannot be kept.', 'error');
          return;
        }
        if (account.algo === 'sha-256') upgradeLegacyAccount(email, password);
        form.reset();
        clearErrors(form);
        sessionChanged();
        toast('Welcome back, ' + firstName(account.name) + '.', 'ok');
      });
    });
  }

  /* ----------------------------------------------------------------------
     Sign up
     ---------------------------------------------------------------------- */

  function scorePassword(value) {
    var score = 0;
    if (value.length >= 8) score += 1;
    if (value.length >= 12) score += 1;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
    if (/\d/.test(value) && /[^\w\s]/.test(value)) score += 1;
    return Math.min(score, 4);
  }

  function initSignup() {
    var form = $('#signup-form');
    if (!form) return;

    var nameInput = $('#signup-name');
    var emailInput = $('#signup-email');
    var phoneInput = $('#signup-phone');
    var passInput = $('#signup-password');
    var confirmInput = $('#signup-confirm');
    var meter = $('#password-meter');
    var submit = $('button[type="submit"]', form);
    if (submit) submit.disabled = false;

    if (meter && passInput) {
      passInput.addEventListener('input', function () {
        meter.dataset.score = String(passInput.value ? scorePassword(passInput.value) : 0);
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearErrors(form);

      var name = nameInput.value.trim();
      var email = normalizeEmail(emailInput.value);
      var phone = phoneInput ? phoneInput.value.trim() : '';
      var password = passInput.value;
      var confirm = confirmInput.value;
      var invalid = false;

      if (name.length < 2) {
        setError(nameInput, 'Enter your full name.');
        invalid = true;
      }
      if (!EMAIL_RE.test(email)) {
        setError(emailInput, 'Enter a valid email address.');
        invalid = true;
      }
      if (phone && phone.replace(/\D/g, '').length < 7) {
        setError(phoneInput, 'Enter at least 7 digits, or leave this blank.');
        invalid = true;
      }
      if (password.length < 8) {
        setError(passInput, 'Use at least 8 characters.');
        invalid = true;
      } else if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) ||
                 !/\d/.test(password) || !/[^\w\s]/.test(password)) {
        setError(passInput, 'Use upper- and lower-case letters, one number and one symbol.');
        invalid = true;
      }
      if (confirm !== password) {
        setError(confirmInput, 'Both passwords must match.');
        invalid = true;
      }

      /* The server owns this question when there is one: it answers 409
         email_taken from a unique index, which is the only answer that cannot
         be raced. Asked locally only when nothing else can be. */
      var accounts = serving() ? null : readAccounts();
      if (accounts && !invalid && accounts[email]) {
        setError(emailInput, 'An account with this email already exists in this browser.');
        invalid = true;
      }

      if (invalid) {
        focusFirstError(form);
        return;
      }

      if (serving()) {
        busy(submit, true, 'Creating account\u2026');
        apiSend('POST', '/api/auth/signup', {
          name: name,
          email: email,
          phone: phone,
          password: password
        }).then(function (res) {
          if (res.status === 201 && res.body && res.body.user) {
            serverUser = res.body.user;
            cacheMode();
            /* Left as a flash rather than a toast because the next thing that
               happens is a page load. */
            setFlash('Welcome to Urban Flame, ' + firstName(name) + '. You are signed in.', 'ok');
            window.location.href = 'index.html';
            return;
          }
          busy(submit, false);
          showApiError(form, {
            name: nameInput,
            email: emailInput,
            phone: phoneInput,
            password: passInput
          }, res, 'Could not create the account. Please try again.');
        });
        return;
      }

      var salt = randomSalt();
      if (!salt) {
        toast('Secure account creation requires a modern browser or a secure local server.', 'error');
        return;
      }
      busy(submit, true, 'Creating account\u2026');

      derive(password, salt).then(function (result) {
        accounts[email] = {
          name: name,
          phone: phone,
          salt: salt,
          algo: result.algo,
          hash: result.hash,
          createdAt: new Date().toISOString()
        };

        if (!store.write(ACCOUNTS_KEY, accounts)) {
          busy(submit, false);
          toast('This browser is blocking local storage, so the account cannot be saved.', 'error');
          return;
        }

        if (!store.write(SESSION_KEY, email)) {
          busy(submit, false);
          toast('Your account was saved, but this browser could not keep you signed in. Log in from the home page.', 'error');
          form.reset();
          return;
        }
        setFlash('Welcome to Urban Flame, ' + firstName(name) + '. You are signed in.', 'ok');
        window.location.href = 'index.html';
      }).catch(function () {
        busy(submit, false);
        toast('Secure account creation is unavailable in this browser. Use a secure local server and try again.', 'error');
      });
    });
  }

  /* ----------------------------------------------------------------------
     Contact / enquiry form
     ---------------------------------------------------------------------- */

  function initContact() {
    var form = $('#enquiry-form');
    if (!form) return;

    var nameInput = $('#contact-name');
    var emailInput = $('#contact-email');
    var topicInput = $('#contact-topic');
    var messageInput = $('#contact-message');
    var success = $('#contact-success');
    var again = $('#contact-again');
    var submit = $('button[type="submit"]', form);
    if (submit) submit.disabled = false;

    /* Signed-in visitors should not retype what we already know - including
       after "Send another", which resets the form fields we just filled. */
    function prefill() {
      var user = currentUser();
      if (!user) return;
      if (!nameInput.value) nameInput.value = user.name;
      if (!emailInput.value) emailInput.value = user.email;
    }

    prefill();
    /* In server mode nobody knows who is signed in until /api/auth/session
       answers, which is after this runs. */
    onMode(prefill);

    if (again && success) {
      again.addEventListener('click', function () {
        success.hidden = true;
        form.hidden = false;
        form.reset();
        clearErrors(form);
        prefill();
        nameInput.focus();
        revealBelowHeader(nameInput);
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearErrors(form);

      var name = nameInput.value.trim();
      var email = normalizeEmail(emailInput.value);
      var message = messageInput.value.trim();
      var invalid = false;

      if (name.length < 2) {
        setError(nameInput, 'Enter your name.');
        invalid = true;
      }
      if (!EMAIL_RE.test(email)) {
        setError(emailInput, 'Enter a valid email address.');
        invalid = true;
      }
      if (message.length < 10) {
        setError(messageInput, 'Tell us a little more \u2014 at least 10 characters.');
        invalid = true;
      }
      if (invalid) {
        focusFirstError(form);
        return;
      }

      function succeed(note) {
        if (success) {
          setText('#contact-success-name', firstName(name));
          form.hidden = true;
          success.hidden = false;
          success.focus();
          revealBelowHeader(success);
        }
        toast(note, 'ok');
      }

      if (serving()) {
        busy(submit, true, 'Sending\u2026');
        apiSend('POST', '/api/enquiries', {
          name: name,
          email: email,
          topic: topicInput ? topicInput.value : '',
          message: message
        }).then(function (res) {
          busy(submit, false);
          if (res.status === 201) {
            succeed('Thank you, ' + firstName(name) + '. Your enquiry is with the restaurant.');
            return;
          }
          showApiError(form, {
            name: nameInput,
            email: emailInput,
            message: messageInput
          }, res, 'Could not send that enquiry. Please try again.');
        });
        return;
      }

      var messages = store.read(MESSAGES_KEY, []);
      if (!Array.isArray(messages)) messages = [];
      messages.push({
        name: name,
        email: email,
        topic: topicInput ? topicInput.value : 'General enquiry',
        message: message,
        sentAt: new Date().toISOString()
      });

      /* Only claim the enquiry was recorded if it actually was: in a privacy
         mode that blocks writes there is nowhere for it to go. */
      if (!store.write(MESSAGES_KEY, messages.slice(-50))) {
        toast('This browser is blocking local storage, so the enquiry cannot be saved.', 'error');
        return;
      }

      succeed('Saved locally for this browser, ' + firstName(name) + '. Nothing was sent.');
    });
  }

  /* ----------------------------------------------------------------------
     Service clock

     The restaurant is one room in one city, so every date and time on the
     booking pages is Bengaluru's, never the visitor's. These mirror
     lib/slots.mjs closely enough to draw the same grid when there is no
     server to ask, and they are the only place a date turns into a string.
     ---------------------------------------------------------------------- */

  var DAY_MS = 24 * 60 * 60 * 1000;

  function tzMinutes() {
    var parts = /^([+-])(\d{2}):(\d{2})$/.exec(SERVICE.tzOffset);
    if (!parts) return 0;
    var size = Number(parts[2]) * 60 + Number(parts[3]);
    return parts[1] === '-' ? -size : size;
  }

  /* The instant a service date begins in the restaurant's timezone. */
  function serviceMidnight(date) {
    return new Date(Date.parse(date + 'T00:00:00Z') - tzMinutes() * 60000);
  }

  /* Which service date an instant falls on, from the restaurant's point of
     view rather than the browser's. */
  function serviceDate(instant) {
    return new Date(instant.getTime() + tzMinutes() * 60000).toISOString().slice(0, 10);
  }

  /* Read at midday so a five-and-a-half hour offset cannot tip the answer
     onto the day either side. lib/slots.mjs does the same. */
  function serviceWeekday(date) {
    return new Date(serviceMidnight(date).getTime() + 12 * 60 * 60 * 1000).getUTCDay();
  }

  function lastSeating(date) {
    return SERVICE.closeMinutes[serviceWeekday(date)] - SERVICE.turnMinutes;
  }

  function clockOf(minutes) {
    var wrapped = ((minutes % 1440) + 1440) % 1440;
    return pad(Math.floor(wrapped / 60)) + ':' + pad(wrapped % 60);
  }

  function pad(number) {
    return (number < 10 ? '0' : '') + number;
  }

  /* How far ahead the form will let anyone book, as two service dates. */
  function bookingWindow() {
    var now = new Date();
    return {
      first: serviceDate(now),
      last: serviceDate(new Date(now.getTime() + SERVICE.horizonDays * DAY_MS))
    };
  }

  /* The times a service seats, for the copy of the site with nothing to ask.
     Seats are left null rather than guessed at: without one shared record of
     who has booked, any number here would be invented. */
  function offlineSlots(date) {
    var opens = serviceMidnight(date).getTime();
    var now = Date.now();
    var slots = [];
    var minutes;

    for (minutes = SERVICE.openMinutes; minutes <= lastSeating(date); minutes += SERVICE.slotMinutes) {
      if (opens + minutes * 60000 <= now) continue;
      slots.push({ time: clockOf(minutes), seats: null, afterMidnight: minutes >= 1440 });
    }
    return { date: date, slots: slots };
  }

  /* A service date is a calendar date, not a moment: handing 2026-09-08 to
     the Date constructor and formatting it is how a visitor in New York gets
     told the 7th. Parsed field by field at midday instead. */
  function formatServiceDate(date) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date == null ? '' : date));
    if (!parts) return String(date == null ? '' : date);

    var at = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12, 0, 0);
    try {
      return at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    } catch (err) {
      return parts[0];
    }
  }

  function guestCount(party) {
    return party === 1 ? '1 guest' : party + ' guests';
  }

  /* ----------------------------------------------------------------------
     Booking page

     With a server the grid shows real seat counts and the reference on the
     confirmation is a table actually held. Without one the same grid shows
     the times the kitchen seats and the reference is a note to self, which
     is what the copy on the page says in that mode.
     ---------------------------------------------------------------------- */

  var REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

  /* Same shape and same missable characters as lib/bookings.mjs, so a local
     reference is not obviously the odd one out. */
  function makeReference() {
    var out = '';
    var i;
    for (i = 0; i < 6; i += 1) {
      out += REFERENCE_ALPHABET.charAt(Math.floor(Math.random() * REFERENCE_ALPHABET.length));
    }
    return 'UF-' + out;
  }

  /* Accepts what people actually type: with or without the prefix, with or
     without the dash, in either case. Mirrors normalizeReference. */
  function tidyReference(value) {
    var cleaned = String(value == null ? '' : value).toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (cleaned.length === 8 && cleaned.indexOf('UF') === 0) return 'UF-' + cleaned.slice(2);
    if (cleaned.length === 6) return 'UF-' + cleaned;
    return '';
  }

  function localBookings() {
    var rows = store.read(BOOKINGS_KEY, []);
    return Array.isArray(rows) ? rows : [];
  }

  function localBookingsFor(email) {
    var wanted = normalizeEmail(email);
    return localBookings().filter(function (row) {
      return normalizeEmail(row.email) === wanted;
    });
  }

  function initBooking() {
    var form = $('#booking-form');
    if (!form) return;

    var nameInput = $('#book-name');
    var emailInput = $('#book-email');
    var phoneInput = $('#book-phone');
    var partyInput = $('#book-party');
    var dateInput = $('#book-date');
    var timeInput = $('#book-time');
    var notesInput = $('#book-notes');
    var grid = $('#slot-grid');
    var success = $('#book-success');
    var again = $('#book-again');
    var submit = $('button[type="submit"]', form);

    var span = bookingWindow();
    var loaded = null;
    var chosen = '';

    dateInput.min = span.first;
    dateInput.max = span.last;
    if (!dateInput.value) dateInput.value = span.first;
    if (submit) submit.disabled = false;

    function party() {
      return Number(partyInput.value) || 2;
    }

    function say(message) {
      setText('#book-status', message);
    }

    /* A slot with no seat count is one nobody is counting, which is every
       slot in local mode. Treat it as open rather than as full. */
    function bookable(slot) {
      return slot.seats === null || slot.seats === undefined || slot.seats >= party();
    }

    function seatNote(slot) {
      if (slot.seats === null || slot.seats === undefined) return '';
      if (slot.seats === 0) return 'full';
      return bookable(slot) ? slot.seats + ' free' : 'only ' + slot.seats;
    }

    function choose(time) {
      chosen = time;
      timeInput.value = time;
      setError(timeInput, '');
      $$('.slot', grid).forEach(function (button) {
        button.setAttribute('aria-pressed', button.getAttribute('data-time') === time ? 'true' : 'false');
      });
    }

    function slotButton(slot) {
      var button = document.createElement('button');
      var note = seatNote(slot);
      var when = document.createElement('span');

      button.type = 'button';
      button.className = 'slot';
      button.setAttribute('data-time', slot.time);
      button.disabled = !bookable(slot);
      button.setAttribute('aria-pressed', slot.time === chosen ? 'true' : 'false');

      when.className = 'slot-time';
      when.textContent = slot.time;
      button.appendChild(when);

      if (note) {
        var seats = document.createElement('span');
        seats.className = 'slot-seats';
        seats.textContent = note;
        button.appendChild(seats);
      }

      button.addEventListener('click', function () {
        choose(slot.time);
      });
      return button;
    }

    /* The grid and the select are two views of one list, so they are built in
       the same pass: a keyboard or screen-reader visitor uses the select, a
       pointer uses the chips, and neither can end up out of step. */
    function paint() {
      var slots = (loaded && loaded.slots) || [];
      var open = 0;
      var placeholder = document.createElement('option');

      grid.textContent = '';
      timeInput.textContent = '';
      placeholder.value = '';
      placeholder.textContent = slots.length ? 'Choose a time' : 'Nothing available';
      timeInput.appendChild(placeholder);

      slots.forEach(function (slot) {
        grid.appendChild(slotButton(slot));
        if (!bookable(slot)) return;

        var option = document.createElement('option');
        open += 1;
        option.value = slot.time;
        option.textContent = slot.time + (slot.afterMidnight ? ' (after midnight)' : '');
        timeInput.appendChild(option);
      });

      grid.hidden = slots.length === 0;

      /* A party of six can undo a time picked for two. Say so rather than
         quietly booking a different table. */
      if (chosen && !$('.slot[data-time="' + chosen + '"]:not([disabled])', grid)) {
        chosen = '';
        timeInput.value = '';
      } else if (chosen) {
        timeInput.value = chosen;
      }

      if (!loaded) return;
      if (!slots.length) {
        say(loaded.date === bookingWindow().first
          ? 'The last seating for today has gone. Pick another date.'
          : 'Nothing to seat on ' + formatServiceDate(loaded.date) + '.');
      } else if (!open) {
        say('Nothing left for ' + guestCount(party()) + ' on ' + formatServiceDate(loaded.date) + '.');
      } else {
        say(open + (open === 1 ? ' time' : ' times') + ' open on ' +
          formatServiceDate(loaded.date) + ' for ' + guestCount(party()) + '.');
      }
    }

    function load() {
      var date = dateInput.value;

      chosen = '';
      timeInput.value = '';
      setError(dateInput, '');

      if (!date) {
        loaded = null;
        paint();
        say('Choose a date to see what is free.');
        return;
      }

      if (!serving()) {
        loaded = offlineSlots(date);
        paint();
        return;
      }

      say('Checking what is free\u2026');
      apiSend('GET', '/api/availability?date=' + encodeURIComponent(date)).then(function (res) {
        var error = (res.body && res.body.error) || null;

        if (res.status === 200 && res.body) {
          loaded = res.body;
          paint();
          return;
        }

        loaded = null;
        paint();
        if (error && error.fields && error.fields.date) {
          setError(dateInput, error.fields.date);
          say('');
          focusFirstError(form);
          return;
        }
        say(res.status === 0 ? OFFLINE_NOTE : (error && error.message) ||
          'Could not load the times for that date.');
      });
    }

    function prefill() {
      var user = currentUser();
      if (!user) return;
      if (!nameInput.value) nameInput.value = user.name;
      if (!emailInput.value) emailInput.value = user.email;
      if (!phoneInput.value && user.phone) phoneInput.value = user.phone;
    }

    function describe(booking) {
      return guestCount(booking.party) + ' on ' + formatServiceDate(booking.date) + ' at ' +
        booking.time + (booking.afterMidnight ? ' (after midnight)' : '') +
        ', for ' + booking.turnMinutes + ' minutes.';
    }

    function confirmed(booking) {
      setText('#book-success-name', firstName(booking.name));
      setText('#book-reference', booking.reference);
      setText('#book-summary', describe(booking));
      form.hidden = true;
      if (!success) return;
      success.hidden = false;
      success.focus();
      revealBelowHeader(success);
    }

    /* Written to this browser rather than sent, which is the whole difference
       between the two modes: the reference is real enough to quote at the
       counter, but nothing is holding a table. */
    function keepLocally(payload) {
      var rows = localBookings();
      var picked = null;
      var booking;

      ((loaded && loaded.slots) || []).forEach(function (slot) {
        if (slot.time === payload.time) picked = slot;
      });

      booking = {
        reference: makeReference(),
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        party: payload.party,
        date: payload.date,
        time: payload.time,
        afterMidnight: Boolean(picked && picked.afterMidnight),
        notes: payload.notes,
        status: 'confirmed',
        createdAt: new Date().toISOString(),
        turnMinutes: SERVICE.turnMinutes
      };

      rows.push(booking);
      if (!store.write(BOOKINGS_KEY, rows.slice(-30))) {
        toast('This browser is blocking local storage, so the booking cannot be kept.', 'error');
        return;
      }
      confirmed(booking);
      run(renderMyBookings);
    }

    form.addEventListener('submit', function (event) {
      var payload = {
        name: nameInput.value.trim(),
        email: normalizeEmail(emailInput.value),
        phone: phoneInput.value.trim(),
        party: party(),
        date: dateInput.value,
        time: timeInput.value,
        notes: notesInput.value.trim()
      };
      var invalid = false;

      event.preventDefault();
      clearErrors(form);

      if (payload.name.length < 2) {
        setError(nameInput, 'Enter your full name.');
        invalid = true;
      }
      if (!EMAIL_RE.test(payload.email)) {
        setError(emailInput, 'Enter a valid email address.');
        invalid = true;
      }
      if (!payload.phone) {
        setError(phoneInput, 'Enter a phone number we can reach you on.');
        invalid = true;
      } else if (payload.phone.replace(/\D/g, '').length < 7) {
        setError(phoneInput, 'Enter at least 7 digits.');
        invalid = true;
      }
      if (!payload.date) {
        setError(dateInput, 'Choose a date.');
        invalid = true;
      }
      if (!payload.time) {
        setError(timeInput, 'Choose a time from the list.');
        invalid = true;
      }
      if (invalid) {
        focusFirstError(form);
        return;
      }

      if (!serving()) {
        keepLocally(payload);
        return;
      }

      busy(submit, true, 'Booking\u2026');
      apiSend('POST', '/api/bookings', payload).then(function (res) {
        busy(submit, false);

        if (res.status === 201 && res.body && res.body.booking) {
          confirmed(res.body.booking);
          run(renderMyBookings);
          return;
        }

        /* The last covers went while this page sat open. Redraw the grid so
           the next attempt is made against what is actually left. */
        if (res.status === 409) load();

        showApiError(form, {
          name: nameInput,
          email: emailInput,
          phone: phoneInput,
          party: partyInput,
          date: dateInput,
          time: timeInput,
          notes: notesInput
        }, res, 'Could not take that booking. Please try again.');
      });
    });

    if (again && success) {
      again.addEventListener('click', function () {
        success.hidden = true;
        form.hidden = false;
        clearErrors(form);
        notesInput.value = '';
        /* The name and number are almost certainly the same person, so only
           the table changes. A cover has just gone, so ask again. */
        load();
        partyInput.focus();
        revealBelowHeader(form);
      });
    }

    dateInput.addEventListener('change', load);
    partyInput.addEventListener('change', paint);
    timeInput.addEventListener('change', function () {
      choose(timeInput.value);
    });

    prefill();
    onMode(prefill);
    say('Checking what is free\u2026');
    onMode(load);
  }

  /* Server mode asks the server, because a booking made on a phone should
     show up on a laptop. Local mode can only report what this browser has
     written down. */
  function renderMyBookings() {
    var panel = $('#my-bookings');
    if (!panel) return;

    var user = currentUser();
    if (!user) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    if (!serving()) {
      paintBookings(localBookingsFor(user.email));
      return;
    }
    apiSend('GET', '/api/bookings').then(function (res) {
      paintBookings((res.status === 200 && res.body && res.body.bookings) || []);
    });
  }

  function paintBookings(bookings) {
    var list = $('#my-bookings-list');
    var empty = $('#my-bookings-empty');
    if (!list) return;

    list.textContent = '';
    if (empty) empty.hidden = bookings.length > 0;

    bookings.forEach(function (booking) {
      var item = document.createElement('li');
      var held = booking.status === 'confirmed';
      var when = document.createElement('p');
      var meta = document.createElement('p');
      var state = document.createElement('p');

      when.className = 'booking-when';
      when.textContent = formatServiceDate(booking.date) + ' at ' + booking.time;
      item.appendChild(when);

      meta.className = 'booking-meta';
      meta.textContent = guestCount(booking.party) + ' \u00b7 ' + booking.reference;
      item.appendChild(meta);

      state.className = 'booking-state booking-state--' + (held ? 'held' : 'gone');
      state.textContent = held ? 'Held' : 'Cancelled';
      item.appendChild(state);

      list.appendChild(item);
    });
  }

  function initLookup() {
    var form = $('#lookup-form');
    if (!form) return;

    var refInput = $('#lookup-reference');
    var emailInput = $('#lookup-email');
    var result = $('#lookup-result');
    var detail = $('#lookup-detail');
    var release = $('#lookup-cancel');
    var submit = $('button[type="submit"]', form);
    var found = null;

    if (submit) submit.disabled = false;

    function rows(booking) {
      return [
        ['Reference', booking.reference],
        ['Name', booking.name],
        ['Date', formatServiceDate(booking.date)],
        ['Time', booking.time + (booking.afterMidnight ? ' (after midnight)' : '')],
        ['Guests', String(booking.party)],
        ['Status', booking.status === 'confirmed' ? 'Held' : 'Cancelled']
      ];
    }

    function show(booking) {
      found = booking;
      detail.textContent = '';

      rows(booking).forEach(function (pair) {
        var line = document.createElement('div');
        var term = document.createElement('dt');
        var value = document.createElement('dd');

        term.textContent = pair[0];
        value.textContent = pair[1];
        line.appendChild(term);
        line.appendChild(value);
        detail.appendChild(line);
      });

      if (release) release.hidden = booking.status !== 'confirmed';
      result.hidden = false;
      result.focus();
      revealBelowHeader(result);
    }

    form.addEventListener('submit', function (event) {
      var reference = tidyReference(refInput.value);
      var email = normalizeEmail(emailInput.value);
      var invalid = false;
      var query;

      event.preventDefault();
      clearErrors(form);

      if (!reference) {
        setError(refInput, 'A reference is six characters, like UF-4K7QMR.');
        invalid = true;
      }
      if (!EMAIL_RE.test(email)) {
        setError(emailInput, 'Enter the email address it was booked with.');
        invalid = true;
      }
      if (invalid) {
        focusFirstError(form);
        return;
      }

      if (!serving()) {
        var match = null;
        localBookings().forEach(function (row) {
          if (row.reference === reference && normalizeEmail(row.email) === email) match = row;
        });
        if (!match) {
          result.hidden = true;
          found = null;
          setError(refInput, 'No booking in this browser matches those details.');
          focusFirstError(form);
          return;
        }
        show(match);
        return;
      }

      query = '/api/bookings?reference=' + encodeURIComponent(reference) +
        '&email=' + encodeURIComponent(email);

      busy(submit, true, 'Looking\u2026');
      apiSend('GET', query).then(function (res) {
        busy(submit, false);

        if (res.status === 200 && res.body && res.body.booking) {
          show(res.body.booking);
          return;
        }

        result.hidden = true;
        found = null;
        if (res.status === 404) {
          setError(refInput, 'No booking matches that reference and email.');
          focusFirstError(form);
          return;
        }
        showApiError(form, {}, res, 'Could not look that up. Please try again.');
      });
    });

    if (release) {
      release.addEventListener('click', function () {
        if (!found) return;

        if (!serving()) {
          var reference = found.reference;
          var kept = localBookings().map(function (row) {
            if (row.reference === reference) row.status = 'cancelled';
            return row;
          });
          store.write(BOOKINGS_KEY, kept);
          found.status = 'cancelled';
          show(found);
          run(renderMyBookings);
          toast('Cancelled in this browser.', 'ok');
          return;
        }

        busy(release, true, 'Cancelling\u2026');
        apiSend('DELETE', '/api/bookings', {
          reference: found.reference,
          email: found.email
        }).then(function (res) {
          busy(release, false);

          if (res.status === 200 && res.body && res.body.booking) {
            show(res.body.booking);
            run(renderMyBookings);
            toast(res.body.already
              ? 'That booking was already cancelled.'
              : 'That table is released. Thank you for telling us.', 'ok');
            return;
          }
          toast(res.status === 0 ? OFFLINE_NOTE : 'Could not cancel that booking.', 'error');
        });
      });
    }
  }

  /* ----------------------------------------------------------------------
     Staff pass

     admin.html is noindex, unlinked, and useless without a server, so the
     gate is the default state and the panel has to be earned. The server
     checks the same thing on every request; this only decides what to draw.
     ---------------------------------------------------------------------- */

  function renderAdmin() {
    var gate = $('#admin-gate');
    var panel = $('#admin-panel');
    if (!gate || !panel) return;

    var user = currentUser();
    var admitted = serving() && Boolean(user) && user.isAdmin === true;

    gate.hidden = admitted;
    panel.hidden = !admitted;

    if (admitted) {
      loadPass();
      loadInbox();
      return;
    }

    /* Three ways to be turned away, and what to do next differs in each. */
    if (!serving()) {
      setText('#admin-gate-title', 'Nothing to show here');
      setText('#admin-gate-text',
        'This page reads the reservations API, and this copy of the site is not talking to one.');
    } else if (!user) {
      setText('#admin-gate-title', 'Staff only');
      setText('#admin-gate-text',
        'Sign in with an address on the staff list and this page will fill itself in.');
    } else {
      setText('#admin-gate-title', 'Staff only');
      setText('#admin-gate-text',
        'The account you are signed in with is not on the staff list.');
    }
  }

  function loadPass() {
    var list = $('#service-list');
    var dateInput = $('#service-date');
    if (!list || !dateInput) return;

    var date = dateInput.value;
    if (!date) {
      list.textContent = '';
      setText('#service-summary', 'Pick a date to load the pass.');
      return;
    }

    setText('#service-summary', 'Loading the pass\u2026');
    apiSend('GET', '/api/bookings?date=' + encodeURIComponent(date)).then(function (res) {
      list.textContent = '';

      if (res.status !== 200 || !res.body) {
        setText('#service-summary', res.status === 0
          ? OFFLINE_NOTE
          : 'Could not load that service. Check the date and try again.');
        return;
      }

      var bookings = res.body.bookings || [];
      var live = bookings.filter(function (row) {
        return row.status === 'confirmed';
      });
      var covers = live.reduce(function (sum, row) {
        return sum + row.party;
      }, 0);
      var when = formatServiceDate(res.body.date || date);

      setText('#service-summary', live.length
        ? live.length + (live.length === 1 ? ' booking, ' : ' bookings, ') +
          covers + (covers === 1 ? ' cover' : ' covers') + ' on ' + when + '.'
        : 'Nothing booked for ' + when + ' yet.');

      bookings.forEach(function (booking) {
        list.appendChild(passRow(booking));
      });
    });
  }

  function passRow(booking) {
    var item = document.createElement('li');
    var held = booking.status === 'confirmed';
    var when = document.createElement('p');
    var who = document.createElement('p');
    var meta = document.createElement('p');

    if (!held) item.className = 'is-handled';

    when.className = 'pass-when';
    when.textContent = booking.time + (booking.afterMidnight ? ' (+1)' : '') + ' \u00b7 ' +
      booking.party + (booking.party === 1 ? ' cover' : ' covers') +
      (held ? '' : ' \u00b7 cancelled');
    item.appendChild(when);

    who.className = 'pass-who';
    who.textContent = booking.name;
    item.appendChild(who);

    /* Everything a host needs to find or chase this table, on one line. */
    meta.className = 'pass-meta';
    meta.textContent = [booking.phone, booking.email, booking.reference]
      .filter(Boolean).join(' \u00b7 ');
    item.appendChild(meta);

    if (booking.notes) {
      var note = document.createElement('p');
      note.className = 'pass-note';
      note.textContent = booking.notes;
      item.appendChild(note);
    }
    return item;
  }

  function loadInbox() {
    var list = $('#inbox-list');
    if (!list) return;

    var openOnly = $('#inbox-open-only');
    var path = '/api/enquiries';
    if (openOnly && openOnly.checked) path += '?handled=false';

    setText('#inbox-summary', 'Loading the inbox\u2026');
    apiSend('GET', path).then(function (res) {
      list.textContent = '';

      if (res.status !== 200 || !res.body) {
        setText('#inbox-summary', res.status === 0 ? OFFLINE_NOTE : 'Could not load the inbox.');
        return;
      }

      var enquiries = res.body.enquiries || [];
      var waiting = enquiries.filter(function (row) {
        return !row.handled;
      }).length;

      setText('#inbox-summary', enquiries.length
        ? enquiries.length + (enquiries.length === 1 ? ' enquiry, ' : ' enquiries, ') +
          waiting + ' still waiting.'
        : 'Nothing in the inbox.');

      enquiries.forEach(function (enquiry) {
        list.appendChild(inboxRow(enquiry));
      });
    });
  }

  function inboxRow(enquiry) {
    var item = document.createElement('li');
    var head = document.createElement('p');
    var topic = document.createElement('span');
    var when = document.createElement('span');
    var who = document.createElement('p');
    var body = document.createElement('p');
    var action = document.createElement('button');

    if (enquiry.handled) item.className = 'is-handled';

    head.className = 'inbox-head';
    topic.className = 'inbox-topic';
    topic.textContent = enquiry.topic;
    when.className = 'inbox-when';
    when.textContent = formatDate(enquiry.sentAt);
    head.appendChild(topic);
    head.appendChild(when);
    item.appendChild(head);

    who.className = 'pass-who';
    who.textContent = enquiry.name;
    item.appendChild(who);

    /* Whether it came from a signed-in account changes how much the address
       can be trusted, so it is on the pass rather than implied. */
    var meta = document.createElement('p');
    meta.className = 'pass-meta';
    meta.textContent = enquiry.email + (enquiry.fromAccount ? ' \u00b7 account holder' : '');
    item.appendChild(meta);

    body.className = 'inbox-message';
    body.textContent = enquiry.message;
    item.appendChild(body);

    action.type = 'button';
    action.className = 'button button--ghost button--small';
    action.textContent = enquiry.handled ? 'Reopen' : 'Mark answered';
    action.addEventListener('click', function () {
      busy(action, true, 'Saving\u2026');
      apiSend('PATCH', '/api/enquiries', {
        id: enquiry.id,
        handled: !enquiry.handled
      }).then(function (res) {
        busy(action, false);
        if (res.status === 200) {
          loadInbox();
          return;
        }
        toast(res.status === 0 ? OFFLINE_NOTE : 'Could not update that enquiry.', 'error');
      });
    });
    item.appendChild(action);
    return item;
  }

  function initAdmin() {
    var form = $('#service-form');
    if (!form) return;

    var dateInput = $('#service-date');
    var submit = $('button[type="submit"]', form);
    var openOnly = $('#inbox-open-only');
    var asked = null;

    /* The form works without JavaScript too: it reloads admin.html with the
       date in the query string, which is also a link one host can send
       another. */
    try {
      asked = new URLSearchParams(window.location.search).get('date');
    } catch (err) {
      asked = null;
    }

    if (dateInput) {
      /* An unparseable date in the query string leaves the control empty
         rather than throwing, so today is the fallback either way. */
      if (asked) dateInput.value = asked;
      if (!dateInput.value) dateInput.value = bookingWindow().first;
    }
    if (submit) submit.disabled = false;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      loadPass();
    });

    if (openOnly) openOnly.addEventListener('change', loadInbox);
    onMode(renderAdmin);
  }

  /* ----------------------------------------------------------------------
     Home page account card
     ---------------------------------------------------------------------- */

  function renderAccountCard() {
    var signedOut = $('#account-signed-out');
    var signedIn = $('#account-signed-in');
    if (!signedOut || !signedIn) return;

    var user = currentUser();
    signedOut.hidden = Boolean(user);
    signedIn.hidden = !user;
    if (!user) return;

    setText('#account-initials', initials(user.name));
    setText('#account-name', user.name);
    setText('#account-email', user.email);
    setText('#account-since', formatDate(user.createdAt));
  }

  function wireAccountCard() {
    var out = $('#account-logout');
    if (out) out.addEventListener('click', logout);
  }

  /* ----------------------------------------------------------------------
     Boot
     ---------------------------------------------------------------------- */

  function init() {
    LEGACY_KEYS.forEach(function (key) {
      store.remove(key);
    });

    /* Last tab's verdict, applied before the first paint so a signed-in
       header and the server wording do not arrive a beat late. resolveMode
       re-checks it and corrects the page if it has changed. */
    var remembered = cachedMode();
    if (remembered) {
      mode = remembered.mode;
      serverUser = remembered.user || null;
    }
    applyModeCopy();

    initHeader();
    initSearch(initMenu());
    initLogin();
    initSignup();
    initContact();
    initBooking();
    initLookup();
    initAdmin();
    wireAccountCard();
    renderAccountCard();
    showFlash();
    resolveMode();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
