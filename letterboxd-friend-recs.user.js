// ==UserScript==
// @name         Letterboxd — Friend recommendations
// @namespace    yofardev.letterboxd-friend-recs
// @version      2.0.1
// @description  Recommends films you haven't watched, scored from the ratings of the people you follow, how many of them watched it, and the global Letterboxd average. Data is cached in IndexedDB and synced incrementally.
// @homepageURL  https://github.com/YofarDev/letterboxd-friend-recs
// @supportURL   https://github.com/YofarDev/letterboxd-friend-recs/issues
// @updateURL    https://raw.githubusercontent.com/YofarDev/letterboxd-friend-recs/main/letterboxd-friend-recs.user.js
// @downloadURL  https://raw.githubusercontent.com/YofarDev/letterboxd-friend-recs/main/letterboxd-friend-recs.user.js
// @license      MIT
// @match        https://letterboxd.com/*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window) return;

  // ---------- Config ----------
  const CFG = {
    concurrency: 2,          // parallel requests to letterboxd.com
    minGapMs: 350,           // minimum delay between request starts (be gentle)
    maxRetries: 4,
    deltaEveryHours: 6,      // re-check a friend's latest ratings at most this often if their watched count is unchanged
    fullRefreshDays: 30,     // full re-crawl of a friend after this many days (catches deleted ratings)
    fullRefreshPerRun: 2,    // at most this many full re-crawls per sync (rotation)
    globalTtlDays: 30,       // refresh a shown film's global average after this long (genre/year/etc. never change)
    detailsVersion: 3,       // bump when the stored film details change shape, to refetch them
    scanBatch: 20,           // genre/country/language filters: film pages checked per round…
    scanPerRun: 300,         // …and at most this many per filter change (then a "Check more" button)
    pageSize: 50,            // posters per page (5 per row)
    shortMinutes: 60,        // "Hide shorts" hides anything shorter than this
    autoSyncHours: 12,       // opening the page syncs in the background if the last sync is older than this
    dbName: 'lbxFriendRecs',
    prefsKey: 'lbxFriendRecs:prefs',
  };
  const DEFAULT_WEIGHTS = {
    k: 2,            // pull toward the global average (in "friend ratings" worth)
    beta: 0.15,      // bonus per ln(1 + friends who watched)
    taste: 1,        // how much friends whose taste matches yours count extra
    likeBonus: 0.25, // stars added to a friend's rating when they also liked the film
    minFriends: 2,   // hide films watched by fewer friends than this
    watchlist: 'all',// 'all' | 'only' | 'hide'
    hideShorts: true,// hide anything shorter than CFG.shortMinutes
    kind: 'movie',   // 'movie' | 'tv' | 'all'  (series = TMDB TV entries, e.g. miniseries)
    sort: 'score',   // 'score' | 'watched' (most follows watched it) | 'friends' (friends' average rating)
    decade: '',      // '' | '2020' | '2010' | … | 'earlier' (before 1930)
    genres: [],      // must have all of these
    exGenres: [],    // must have none of these
    country: '',     // any production country matches (e.g. "France")
    language: '',    // any listed language matches (ISO code, e.g. "ja")
  };
  const TUNING_KEYS = ['k', 'beta', 'taste', 'likeBonus'];
  const FILTER_KEYS = ['decade', 'genres', 'exGenres', 'country', 'language'];
  const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History',
    'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller', 'TV Movie', 'War', 'Western'];
  const COMMON_COUNTRIES = ['USA', 'UK', 'France', 'Japan', 'South Korea', 'Italy', 'Germany', 'Spain', 'Canada', 'India', 'China',
    'Hong Kong', 'Taiwan', 'Mexico', 'Brazil', 'Argentina', 'Sweden', 'Denmark', 'Norway', 'Iran', 'Russia', 'Australia', 'Ireland', 'Belgium', 'Poland'];
  const COMMON_LANGS = ['en', 'fr', 'ja', 'ko', 'it', 'de', 'es', 'zh', 'cn', 'hi', 'pt', 'ru', 'sv', 'da', 'no', 'fa', 'pl', 'ar', 'tr'];
  const langNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
  // TMDB uses "cn" for Cantonese, which isn't an ISO code.
  const langName = (code) => (code === 'cn' ? 'Cantonese' : (() => { try { return langNames?.of(code) || code; } catch { return code; } })());
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- IndexedDB ----------
  const dbP = new Promise((resolve, reject) => {
    const r = indexedDB.open(CFG.dbName, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'username' });
      if (!db.objectStoreNames.contains('films')) db.createObjectStore('films', { keyPath: 'slug' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const os = async (name, mode = 'readonly') => (await dbP).transaction(name, mode).objectStore(name);
  const idb = {
    get: async (s, k) => done((await os(s)).get(k)),
    all: async (s) => done((await os(s)).getAll()),
    put: async (s, v) => done((await os(s, 'readwrite')).put(v)),
    del: async (s, k) => done((await os(s, 'readwrite')).delete(k)),
    putMany: async (s, vs) => {
      if (!vs.length) return;
      const st = await os(s, 'readwrite');
      await Promise.all(vs.map((v) => done(st.put(v))));
    },
  };

  // ---------- Polite fetch queue ----------
  // Two lanes: results-page requests (posters, global ratings) jump ahead of a running sync.
  let active = 0, nextStart = 0, fetchedPages = 0;
  const waiters = { high: [], low: [] };
  async function acquire(priority) {
    while (active >= CFG.concurrency) await new Promise((r) => waiters[priority ? 'high' : 'low'].push(r));
    active++;
    const now = Date.now();
    nextStart = Math.max(now, nextStart + CFG.minGapMs);
    if (nextStart > now) await sleep(nextStart - now);
  }
  function release() { active--; (waiters.high.shift() || waiters.low.shift())?.(); }

  async function fetchText(path, priority = false) {
    for (let attempt = 0; ; attempt++) {
      await acquire(priority);
      let res = null;
      try { res = await fetch(path, { credentials: 'same-origin' }); } catch { /* network error: retry */ }
      finally { release(); }
      if (res?.ok) { fetchedPages++; return res.text(); }
      if (res && (res.status === 404 || res.status === 403)) return null;
      if (attempt >= CFG.maxRetries) throw new Error(`HTTP ${res?.status ?? 'network'} for ${path}`);
      await sleep(2000 * 2 ** attempt); // 429 / 5xx: back off
    }
  }

  // ---------- Parsing ----------
  const parseHtml = (t) => new DOMParser().parseFromString(t, 'text/html');
  const lastPage = (doc) => Math.max(1, ...[...doc.querySelectorAll('.paginate-page')]
    .map((e) => parseInt(e.textContent.replace(/\D/g, ''), 10)).filter(Number.isFinite));

  function parseGrid(doc) {
    return [...doc.querySelectorAll('li.griditem, li.poster-container')].map((li) => {
      const d = li.querySelector('[data-item-slug]');
      if (!d) return null;
      const viewing = li.querySelector('.poster-viewingdata');
      const m = viewing?.querySelector('[class*="rated-"]')?.className.match(/rated-(\d+)/);
      return {
        slug: d.dataset.itemSlug,
        name: d.dataset.itemFullDisplayName || d.dataset.itemName || d.dataset.itemSlug,
        rating: m ? +m[1] : 0,                       // half-stars 1..10, 0 = not rated
        liked: viewing?.querySelector('.icon-liked, .like') ? 1 : 0,
      };
    }).filter(Boolean);
  }

  function parseFollowing(doc) {
    return [...doc.querySelectorAll('tr')].filter((r) => r.querySelector('a.name')).map((r) => ({
      username: r.querySelector('a.name').getAttribute('href').replace(/\//g, '').toLowerCase(),
      watched: parseInt(r.querySelector('.icon-watched')?.textContent.replace(/\D/g, '') || '0', 10),
    }));
  }

  // Crawl every page of a grid (page 1 first to learn the page count, the rest through the queue).
  async function crawlAll(base) {
    const t = await fetchText(base);
    if (t == null) return null;
    const first = parseHtml(t);
    const n = lastPage(first);
    const rest = await Promise.all(Array.from({ length: n - 1 }, async (_, i) => {
      const tt = await fetchText(`${base}page/${i + 2}/`);
      return tt ? parseGrid(parseHtml(tt)) : [];
    }));
    return parseGrid(first).concat(...rest);
  }

  // Crawl a newest-first grid until we reach an entry we already have (everything after is older).
  async function crawlUntilKnown(base, isKnown, maxPages = 40) {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const t = await fetchText(p === 1 ? base : `${base}page/${p}/`);
      if (t == null) break;
      const doc = parseHtml(t);
      const items = parseGrid(doc);
      out.push(...items.filter((it) => !isKnown(it)));
      if (!items.length || items.some(isKnown) || p >= lastPage(doc)) break;
    }
    return out;
  }

  // ---------- Sync ----------
  // Letterboxd fills in the signed-in user with JavaScript after the page loads
  // (the server HTML is the same for everyone), so this may return null at first.
  function detectMe() {
    const fromGlobal = window.person?.loggedIn && window.person.username;
    if (fromGlobal) return String(fromGlobal).toLowerCase();
    const href = [...document.querySelectorAll('header a[href], nav a[href]')]
      .map((a) => a.getAttribute('href'))
      .find((h) => /^\/[^/]+\/watchlist\/$/.test(h));
    return href ? href.split('/')[1].toLowerCase() : null;
  }

  const filmEntry = (it) => [it.rating, it.liked];

  async function syncUser(username, watchedCount, ctx) {
    const now = Date.now();
    let rec = await idb.get('users', username);
    const base = `/${username}/films/`;
    const full = !rec || (now - rec.lastFull > CFG.fullRefreshDays * DAY && ctx.fullBudget-- > 0);
    let seen;
    if (full) {
      seen = await crawlAll(base);
      if (seen == null) return; // private / missing profile
      rec = { username, films: {}, lastFull: now, lastDelta: now };
      for (const it of seen) rec.films[it.slug] = filmEntry(it);
    } else {
      const known = (it) => { const f = rec.films[it.slug]; return !!f && f[0] === it.rating && f[1] === it.liked; };
      const countChanged = watchedCount == null || watchedCount !== rec.watchedCount;
      seen = [];
      if (countChanged) seen.push(...await crawlUntilKnown(`${base}by/date/`, known));
      if (countChanged || now - rec.lastDelta > CFG.deltaEveryHours * HOUR) {
        seen.push(...await crawlUntilKnown(`${base}by/rated-date/`, known));
        rec.lastDelta = now;
      }
      for (const it of seen) rec.films[it.slug] = filmEntry(it);
    }
    rec.watchedCount = watchedCount ?? Object.keys(rec.films).length;
    await idb.put('users', rec);
    // Store names of films we haven't seen before (for display).
    const stubs = [];
    for (const it of seen) {
      if (!ctx.films.has(it.slug)) { const f = { slug: it.slug, name: it.name }; ctx.films.set(it.slug, f); stubs.push(f); }
    }
    await idb.putMany('films', stubs);
  }

  let syncing = false;
  async function syncAll(me, onStatus) {
    if (syncing) return;
    syncing = true;
    const startPages = fetchedPages;
    const status = (msg) => onStatus(`${msg} · ${fetchedPages - startPages} pages fetched`);
    try {
      const ctx = { fullBudget: CFG.fullRefreshPerRun, films: new Map((await idb.all('films')).map((f) => [f.slug, f])) };

      status('Reading who you follow…');
      // The following pages only have a "Next" link (no page numbers), so walk until it disappears.
      const following = [];
      for (let p = 1; p <= 100; p++) {
        const t = await fetchText(p === 1 ? `/${me}/following/` : `/${me}/following/page/${p}/`);
        if (t == null) break;
        const doc = parseHtml(t);
        const rows = parseFollowing(doc);
        following.push(...rows);
        if (!rows.length || !doc.querySelector('.paginate-nextprev a.next, a.next')) break;
      }

      status('Syncing your films…');
      await syncUser(me, null, ctx);

      status('Syncing your watchlist…');
      const wl = await crawlAll(`/${me}/watchlist/`) || [];
      await idb.put('meta', { key: 'watchlist', slugs: wl.map((it) => it.slug), at: Date.now() });
      const wlStubs = wl.filter((it) => !ctx.films.has(it.slug)).map((it) => ({ slug: it.slug, name: it.name }));
      wlStubs.forEach((f) => ctx.films.set(f.slug, f));
      await idb.putMany('films', wlStubs);

      // Forget people you unfollowed.
      const keep = new Set([me, ...following.map((f) => f.username)]);
      for (const u of await idb.all('users')) if (!keep.has(u.username)) await idb.del('users', u.username);

      // Small accounts first, so partial results arrive early.
      following.sort((a, b) => a.watched - b.watched);
      for (let i = 0; i < following.length; i++) {
        const f = following[i];
        status(`Syncing @${f.username} (${i + 1}/${following.length}, ${f.watched.toLocaleString()} films)`);
        try { await syncUser(f.username, f.watched, ctx); }
        catch (err) { console.warn('[friend-recs] sync failed for', f.username, err); }
      }
      await idb.put('meta', { key: 'lastSync', at: Date.now(), me });
      status('Sync complete');
    } finally {
      syncing = false;
    }
  }

  // ---------- Global averages + details (top candidates only) ----------
  // One request per film: the film page has structured data (JSON-LD) with the weighted
  // Letterboxd average, poster and directors; the footer has the runtime; the TMDB link
  // says whether it's a film (/movie/) or a series (/tv/).
  function parseFilmPage(t) {
    const doc = parseHtml(t);
    let ld = null;
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { ld = JSON.parse(s.textContent.replace(/\/\*[\s\S]*?\*\//g, '')); break; } catch { /* try the next one */ }
    }
    const footer = doc.querySelector('p.text-link, .text-footer')?.textContent || '';
    const mins = footer.match(/([\d,]+)\s*min/);
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.content || '';
    const year = ogTitle.match(/\((\d{4})\)\s*$/);
    return {
      name: ld?.name || null,
      year: year ? +year[1] : null,
      runtime: mins ? parseInt(mins[1].replace(/,/g, ''), 10) : null,
      kind: doc.querySelector('a[href*="themoviedb.org/tv/"]') ? 'tv' : 'movie',
      directors: [].concat(ld?.director || []).map((d) => d?.name).filter(Boolean),
      genres: [].concat(ld?.genre || []).filter(Boolean),
      countries: [].concat(ld?.countryOfOrigin || []).map((c) => c?.name || c).filter((c) => typeof c === 'string'),
      languages: [].concat(ld?.inLanguage || []).filter((l) => typeof l === 'string'),
      image: ld?.image || null,
      avg: ld?.aggregateRating?.ratingValue ?? null,
      ratingCount: ld?.aggregateRating?.ratingCount ?? 0,
    };
  }

  const hasDetails = (f) => !!f?.globalAt && f.detailsV === CFG.detailsVersion;
  const staleRating = (f) => hasDetails(f) && Date.now() - f.globalAt > CFG.globalTtlDays * DAY;
  const needsDetails = (f) => !hasDetails(f) || staleRating(f);

  async function ensureGlobals(films, slugs, onOne) {
    const now = Date.now();
    const todo = slugs.map((s) => films.get(s) || { slug: s, name: s }).filter(needsDetails);
    await Promise.all(todo.map(async (f) => {
      try {
        const t = await fetchText(`/film/${f.slug}/`, true);
        if (t) {
          const d = parseFilmPage(t);
          Object.assign(f, d, { name: d.name || f.name });
        }
        f.detailsV = CFG.detailsVersion;
        f.globalAt = now;
        films.set(f.slug, f);
      } catch (err) { console.warn('[friend-recs] details failed', f.slug, err); }
      onOne?.();
    }));
    await idb.putMany('films', todo);
    return todo.length;
  }

  // ---------- Scoring ----------
  function meanSd(xs) {
    if (!xs.length) return [0, 0];
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return [m, Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)];
  }

  function pearson(pairs) {
    if (pairs.length < 3) return 0;
    const [mx, sx] = meanSd(pairs.map((p) => p[0]));
    const [my, sy] = meanSd(pairs.map((p) => p[1]));
    if (!sx || !sy) return 0;
    return pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / (pairs.length * sx * sy);
  }

  // Heavy part: depends only on the synced data, computed once per open.
  function prepare(users, me) {
    const meRec = users.find((u) => u.username === me);
    const friends = users.filter((u) => u.username !== me);
    const all = [];
    for (const u of friends) for (const [r] of Object.values(u.films)) if (r) all.push(r / 2);
    const [muAll, sdAll] = meanSd(all);
    const prepared = friends.map((u) => {
      const rs = Object.values(u.films).map(([r]) => r).filter(Boolean).map((r) => r / 2);
      let [mu, sd] = meanSd(rs);
      if (rs.length < 5) { mu = muAll; sd = sdAll; }
      sd = Math.max(sd, 0.5);
      const pairs = [];
      if (meRec) for (const [slug, [r]] of Object.entries(u.films)) {
        const mine = meRec.films[slug];
        if (r && mine && mine[0]) pairs.push([mine[0] / 2, r / 2]);
      }
      const rho = pearson(pairs);
      return { u, mu, sd, rhoShrunk: rho * pairs.length / (pairs.length + 10), common: pairs.length };
    });
    return { meRec, friends: prepared, muAll, sdAll: sdAll || 1 };
  }

  function rank(prep, films, watchlist, w) {
    const mine = prep.meRec?.films || {};
    const acc = new Map();
    for (const f of prep.friends) {
      const weight = clamp(1 + w.taste * f.rhoShrunk, 0.1, 2);
      for (const [slug, [r, liked]] of Object.entries(f.u.films)) {
        if (mine[slug]) continue; // already watched
        let a = acc.get(slug);
        if (!a) acc.set(slug, (a = { slug, n: 0, nRated: 0, nLiked: 0, sumW: 0, sumWR: 0, rawSum: 0, raters: [] }));
        a.n++;
        if (liked) a.nLiked++;
        if (r) {
          const stars = r / 2;
          const common = prep.muAll + ((stars - f.mu) / f.sd) * prep.sdAll + (liked ? w.likeBonus : 0);
          a.sumW += weight; a.sumWR += weight * common; a.rawSum += stars; a.nRated++;
        }
        a.raters.push({ user: f.u.username, stars: r / 2, liked });
      }
    }
    const out = [];
    for (const a of acc.values()) {
      if (a.n < w.minFriends) continue;
      const inWl = watchlist.has(a.slug);
      if (w.watchlist === 'only' && !inWl) continue;
      if (w.watchlist === 'hide' && inWl) continue;
      const film = films.get(a.slug);
      const G = film?.avg ?? prep.muAll;
      const friendScore = (a.sumWR + w.k * G) / (a.sumW + w.k);
      out.push({ ...a, inWl, film, hasGlobal: film?.avg != null, friendAvg: a.nRated ? a.rawSum / a.nRated : null,
        score: friendScore + w.beta * Math.log(1 + a.n) });
    }
    const byName = (x, y) => (x.film?.name || x.slug).localeCompare(y.film?.name || y.slug);
    const sorts = {
      score: (x, y) => y.score - x.score,
      watched: (x, y) => y.n - x.n || byName(x, y),
      friends: (x, y) => (y.friendAvg ?? -1) - (x.friendAvg ?? -1) || y.nRated - x.nRated || byName(x, y),
    };
    return out.sort(sorts[w.sort] || sorts.score);
  }

  // ---------- Filters ----------
  // Year is known for every film (it's in the synced film name). Everything else needs the film's
  // details, which are fetched for the top results only.
  const yearOf = (f) => f?.year ?? (+((f?.name || '').match(/\((\d{4})\)\s*$/)?.[1]) || null);
  // Genre/country/language are "strict": a film whose details we don't have yet can't be shown.
  // Length/type are lenient: those films are shown until their details arrive (most films pass anyway).
  const strictActive = (w) => !!(w.genres.length || w.exGenres.length || w.country || w.language);
  const filtersActive = (w) => !!(w.decade || strictActive(w));
  const norm = (s) => String(s || '').trim().toLowerCase();

  function passesYear(r, w) {
    if (!w.decade) return true;
    const y = yearOf(r.film);
    if (y == null) return !hasDetails(r.film); // unknown year: wait for details
    if (w.decade === 'earlier') return y < 1930;
    return y >= +w.decade && y < +w.decade + 10;
  }

  function passesFilters(r, w) {
    if (!passesYear(r, w)) return false;
    const f = r.film;
    if (!hasDetails(f)) return !strictActive(w);
    if (w.hideShorts && f.runtime != null && f.runtime < CFG.shortMinutes) return false;
    if (w.kind !== 'all' && f.kind && f.kind !== w.kind) return false;
    const genres = (f.genres || []).map(norm);
    if (!w.genres.every((g) => genres.includes(norm(g)))) return false;
    if (w.exGenres.some((g) => genres.includes(norm(g)))) return false;
    if (w.country && !(f.countries || []).some((c) => norm(c) === norm(w.country))) return false;
    if (w.language && !(f.languages || []).some((l) => norm(l) === norm(w.language))) return false;
    return true;
  }

  // ---------- UI ----------
  // The page lives at /<you>/watchlist/#friend-recs: the watchlist page has the profile tabs, a main
  // column and a sidebar, so we hide its content and show ours in the same layout, built from
  // Letterboxd's own classes (section-heading, sorting-selects/smenu, poster-grid, pagination,
  // actions-panel) so it picks up the site's styles.
  const ROUTE_HASH = '#friend-recs';
  const routeHref = (me) => `/${me}/watchlist/${ROUTE_HASH}`;
  const isRoute = (me) => location.pathname.toLowerCase() === `/${me}/watchlist/` && location.hash === ROUTE_HASH;

  const SORT_LABELS = { score: 'Recommended', watched: 'Most watched by friends', friends: 'Friends’ rating' };
  const DECADES = ['2020', '2010', '2000', '1990', '1980', '1970', '1960', '1950', '1940', '1930'];

  const STYLE = `
    .lfr-hidden{display:none!important}
    .lfr-page .poster-grid .griditem{position:relative}
    .lfr-page .lfr-ph{display:block;width:100%;aspect-ratio:2/3;background:#2c3440;border-radius:4px}
    .lfr-page .lfr-vd{display:flex;gap:6px;align-items:center;margin:4px 0 0;font-size:11px;line-height:16px;color:#678;white-space:nowrap;overflow:hidden}
    .lfr-page .lfr-vd .lfr-stars{color:#89a;font-size:12px;letter-spacing:-.05em}
    .lfr-page .lfr-vd .lfr-wl{width:6px;height:6px;border-radius:50%;background:#40bcf4;flex:none}
    .lfr-page .lfr-note{margin:18px 0;color:#9ab;font-size:13px;line-height:1.6}
    .lfr-page .lfr-note:empty{display:none}
    .lfr-page .lfr-link{background:none;border:0;padding:0;font:inherit;color:#40bcf4;cursor:pointer}
    .lfr-page .lfr-link:hover{color:#fff}
    .lfr-page .lfr-empty{padding:48px 0;text-align:center;color:#9ab;font-size:15px;line-height:1.6}
    .lfr-page .lfr-empty .button{margin-top:16px}
    .lfr-page .lfr-tune label{display:flex;justify-content:space-between;margin:12px 0 2px;font-size:12px;color:#9ab}
    .lfr-page .lfr-tune label b{color:#def;font-weight:400}
    .lfr-page .lfr-tune input[type=range]{width:100%;accent-color:#00e054}
    .lfr-page .lfr-tune p{margin:2px 0 0;font-size:11px;color:#678;line-height:1.4}
    .lfr-menu .lfr-menu-heading{display:block;padding:8px 12px 2px;font-size:10px;letter-spacing:.075em;text-transform:uppercase;color:#2c3440}
    .lfr-menu li.lfr-on > a.item, .lfr-menu li.lfr-ex > a.item{font-weight:600}
    .lfr-menu li.lfr-on > a.item::after{content:' ✓'}
    .lfr-menu li.lfr-ex > a.item{text-decoration:line-through}
    .lfr-menu li.lfr-ex > a.item::after{content:' ✕';display:inline-block;text-decoration:none}
    .lfr-menu .lfr-menu-hint{display:block;padding:6px 12px 8px;font-size:11px;color:#2c3440}
  `;

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null && c !== false) n.append(c);
    return n;
  }

  const readPrefs = () => {
    try { return { ...DEFAULT_WEIGHTS, ...JSON.parse(localStorage.getItem(CFG.prefsKey) || '{}') }; }
    catch { return { ...DEFAULT_WEIGHTS }; }
  };
  const savePrefs = (w) => { try { localStorage.setItem(CFG.prefsKey, JSON.stringify(w)); } catch { /* ignore */ } };
  const ago = (t) => {
    if (!t) return 'never';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
  };
  // 4.3 → "★★★★½" (rounded to the nearest half star, like Letterboxd ratings)
  const stars = (s) => { const h = Math.round(s * 2); return '★'.repeat(Math.floor(h / 2)) + (h % 2 ? '½' : ''); };
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  // A Letterboxd-style dropdown: "LABEL ▾" in the sorting bar, opening a ul.smenu-menu (styled by
  // the site) on hover or click. build() returns groups of items; onPick() returns true to keep it open.
  let closeOpenMenu = null;
  function makeMenu({ id, prefix, label, build, onPick }) {
    const labelText = document.createTextNode(label());
    const labelEl = el('label', {}, [labelText, el('i', { class: 'ir s icon' })]);
    const wrapper = el('section', { class: 'smenu-wrapper', 'data-lfr-menu': id }, [
      prefix ? el('strong', { class: 'smenu-label', text: prefix }) : null,
      el('div', { class: 'smenu' }, [labelEl]),
    ]);
    let menu = null, closeTimer = null;
    const close = () => { clearTimeout(closeTimer); menu?.remove(); menu = null; if (closeOpenMenu === close) closeOpenMenu = null; };
    const closeSoon = () => { clearTimeout(closeTimer); closeTimer = setTimeout(close, 250); };
    const fill = () => {
      menu.replaceChildren(
        el('li', { class: 'smenu-selected' }, [label(), el('i', { class: 'ir s icon' })]),
        ...build().map((g) => el('li', { class: 'divider-line' }, [
          g.heading ? el('span', { class: 'lfr-menu-heading', text: g.heading }) : null,
          el('ul', {}, g.items.map((it) => el('li', { class: it.state ? `lfr-${it.state}` : null }, [
            el('a', {
              href: '#', class: 'item', 'data-value': it.value,
              onclick: (e) => {
                e.preventDefault();
                const keep = onPick(it.value);
                labelText.textContent = label();
                if (keep && menu) fill(); else close();
              },
            }, [el('i', { class: 'ir s icon' }), it.text]),
          ]))),
          g.hint ? el('span', { class: 'lfr-menu-hint', text: g.hint }) : null,
        ])),
      );
    };
    const open = () => {
      clearTimeout(closeTimer);
      if (menu) return;
      closeOpenMenu?.(); // only one dropdown open at a time
      closeOpenMenu = close;
      menu = el('ul', { class: 'smenu-menu lfr-menu', 'data-lfr-menu': id });
      fill();
      const r = labelEl.getBoundingClientRect();
      Object.assign(menu.style, { display: 'block', position: 'absolute', zIndex: 1000,
        top: `${r.top + window.scrollY - 10}px`, left: `${r.left + window.scrollX - 8}px` });
      menu.addEventListener('mouseenter', () => clearTimeout(closeTimer));
      menu.addEventListener('mouseleave', closeSoon);
      document.body.append(menu);
    };
    wrapper.addEventListener('mouseenter', open);
    wrapper.addEventListener('mouseleave', (e) => { if (!menu?.contains(e.relatedTarget)) closeSoon(); });
    labelEl.addEventListener('click', (e) => { e.preventDefault(); if (menu) close(); else open(); });
    return { wrapper, close, refreshLabel: () => { labelText.textContent = label(); } };
  }

  // ---------- The page ----------
  function createPage(me) {
    const w = readPrefs();
    const P = CFG.pageSize;
    let prep = null, films = new Map(), watchlist = new Set(), ranked = [], page = 1, token = 0;
    // Films on pages you've already paged past keep their place, so moving between pages never repeats
    // or skips films while details (and global ratings) arriving for later pages re-rank the rest.
    let placed = [];
    const resetPaging = () => { page = 1; placed = []; };
    let scanPaused = false, busyNote = '', lastSync = null, friendCount = 0;
    const emptyPoster = document.querySelector('[data-empty-poster-src]')?.dataset.emptyPosterSrc || null;

    // --- main column
    const heading = el('h1', { class: 'section-heading' });
    const grid = el('ul', { class: 'grid -p125 -constrained' });
    const note = el('div', { class: 'lfr-note' });
    const pager = el('div', { class: 'pagination' });
    const setFilter = (key, value) => { w[key] = value; savePrefs(w); resetPaging(); refresh(); return false; };
    const toggleIn = (key, value) => { const s = new Set(w[key]); if (s.has(value)) s.delete(value); else s.add(value); return [...s]; };

    const knownValues = (pick) => {
      const counts = new Map();
      for (const r of ranked) for (const v of (hasDetails(r.film) ? pick(r.film) : [])) counts.set(v, (counts.get(v) || 0) + 1);
      return counts;
    };
    const topValues = (counts, common, n = 30) => [...new Set([...[...counts].sort((a, b) => b[1] - a[1]).map(([v]) => v), ...common])].slice(0, n);

    const menus = [
      makeMenu({
        id: 'sort', prefix: 'Sort by', label: () => SORT_LABELS[w.sort] || SORT_LABELS.score,
        build: () => [{ items: Object.entries(SORT_LABELS).map(([v, t]) => ({ value: v, text: t, state: w.sort === v && 'on' })) }],
        onPick: (v) => setFilter('sort', v),
      }),
      makeMenu({
        id: 'other', label: () => 'Other',
        build: () => [
          { heading: 'Show', items: [['movie', 'Films'], ['tv', 'Series'], ['all', 'Films and series']].map(([v, t]) => ({ value: `kind:${v}`, text: t, state: w.kind === v && 'on' })) },
          { items: [{ value: 'shorts', text: `Hide shorts (under ${CFG.shortMinutes} min)`, state: w.hideShorts && 'on' }] },
          { heading: 'Watchlist', items: [['all', 'Include my watchlist'], ['hide', 'Hide my watchlist'], ['only', 'Only my watchlist']].map(([v, t]) => ({ value: `wl:${v}`, text: t, state: w.watchlist === v && 'on' })) },
          { heading: 'Watched by at least', items: [1, 2, 3, 5].map((n) => ({ value: `min:${n}`, text: plural(n, 'friend'), state: w.minFriends === n && 'on' })) },
        ],
        onPick: (v) => {
          const [k, x] = v.split(':');
          if (k === 'kind') setFilter('kind', x);
          else if (k === 'wl') setFilter('watchlist', x);
          else if (k === 'min') setFilter('minFriends', +x);
          else if (v === 'shorts') setFilter('hideShorts', !w.hideShorts);
          return true;
        },
      }),
      makeMenu({
        id: 'language', label: () => (w.language ? langName(w.language) : 'Language'),
        build: () => [{
          items: [{ value: '', text: 'Any language', state: !w.language && 'on' },
            ...topValues(knownValues((f) => f.languages || []), COMMON_LANGS)
              .map((c) => ({ value: c, text: langName(c), state: w.language === c && 'on' }))
              .sort((a, b) => a.text.localeCompare(b.text))],
        }],
        onPick: (v) => setFilter('language', v),
      }),
      makeMenu({
        id: 'country', label: () => w.country || 'Country',
        build: () => [{
          items: [{ value: '', text: 'Any country', state: !w.country && 'on' },
            ...topValues(knownValues((f) => f.countries || []), COMMON_COUNTRIES).sort()
              .map((c) => ({ value: c, text: c, state: w.country === c && 'on' }))],
        }],
        onPick: (v) => setFilter('country', v),
      }),
      makeMenu({
        id: 'genre',
        label: () => {
          const n = w.genres.length + w.exGenres.length;
          return n === 0 ? 'Genre' : n === 1 ? (w.genres[0] || `Not ${w.exGenres[0]}`) : `Genre (${n})`;
        },
        build: () => [{
          items: [{ value: '', text: 'Any genre', state: !w.genres.length && !w.exGenres.length && 'on' },
            ...GENRES.map((g) => ({ value: g, text: g, state: w.genres.includes(g) ? 'on' : w.exGenres.includes(g) ? 'ex' : null }))],
          hint: 'Click once to include, twice to exclude.',
        }],
        onPick: (g) => {
          if (!g) { w.genres = []; w.exGenres = []; }
          else if (w.genres.includes(g)) { w.genres = toggleIn('genres', g); w.exGenres = toggleIn('exGenres', g); }
          else if (w.exGenres.includes(g)) w.exGenres = toggleIn('exGenres', g);
          else w.genres = toggleIn('genres', g);
          setFilter('genres', w.genres);
          return true;
        },
      }),
      makeMenu({
        id: 'decade', label: () => (w.decade === 'earlier' ? 'Before 1930' : w.decade ? `${w.decade}s` : 'Decade'),
        build: () => [{
          items: [{ value: '', text: 'Any decade', state: !w.decade && 'on' },
            ...DECADES.map((d) => ({ value: d, text: `${d}s`, state: w.decade === d && 'on' })),
            { value: 'earlier', text: 'Before 1930', state: w.decade === 'earlier' && 'on' }],
        }],
        onPick: (v) => setFilter('decade', v),
      }),
    ];
    // Letterboxd floats these right, so DOM order is the reverse of the on-screen order.
    const sortBar = el('div', { id: 'content-nav', class: 'basic' }, [el('div', { class: 'sorting-selects' }, menus.map((m) => m.wrapper))]);
    const main = el('section', { class: 'section col-17 col-main' }, [heading, sortBar, el('div', { class: 'poster-grid' }, [grid]), note, pager]);

    // --- sidebar
    const syncLink = el('a', { href: '#', text: 'Sync friends’ films' });
    const clearItem = el('li', {}, [el('a', { href: '#', text: 'Clear filters', onclick: (e) => { e.preventDefault(); clearFilters(); } })]);
    const tuneLink = el('a', { href: '#', text: 'Tune recommendations' });
    const about = el('div', { class: 'body-text -small -reset' });
    const slider = (key, label, min, max, step, help) => {
      const val = el('b', { text: String(w[key]) });
      const input = el('input', { type: 'range', min, max, step, value: w[key] });
      input.addEventListener('input', () => { w[key] = +input.value; val.textContent = String(w[key]); savePrefs(w); scheduleRefresh(); });
      return [el('label', {}, [label, val]), input, el('p', { text: help })];
    };
    const tune = el('section', { class: 'section panel-text lfr-tune lfr-hidden' }, [
      el('h3', { class: 'section-heading', text: 'Tune recommendations' }),
      ...slider('taste', 'Taste matching', 0, 2, 0.1, 'Friends whose ratings agree with yours count more.'),
      ...slider('k', 'Letterboxd average', 0, 10, 0.5, 'How much the global rating weighs against your friends’.'),
      ...slider('beta', 'Popular with friends', 0, 0.6, 0.05, 'Bonus for films many friends watched.'),
      ...slider('likeBonus', 'Likes', 0, 1, 0.05, 'Extra weight when a friend also liked the film.'),
      el('p', {}, [el('button', { class: 'lfr-link', text: 'Reset to defaults', onclick: () => {
        TUNING_KEYS.forEach((k) => { w[k] = DEFAULT_WEIGHTS[k]; });
        savePrefs(w);
        rebuild();
      } })]),
    ]);
    tuneLink.addEventListener('click', (e) => { e.preventDefault(); tune.classList.toggle('lfr-hidden'); });
    const sidebar = el('aside', { class: 'sidebar' }, [
      el('section', { class: 'actions-panel', 'data-theme': 'panel' }, [el('ul', {}, [el('li', {}, [syncLink]), clearItem, el('li', {}, [tuneLink])])]),
      tune,
      el('section', { class: 'section panel-text' }, [el('h3', { class: 'section-heading', text: 'How it works' }), about]),
    ]);

    const root = el('div', { class: 'cols-2 lfr-page' }, [main, sidebar]);

    // --- data
    const visible = () => {
      const list = ranked.filter((r) => passesFilters(r, w));
      if (!placed.length) return list;
      const bySlug = new Map(list.map((r) => [r.slug, r]));
      const frozen = new Set(placed);
      return placed.map((s) => bySlug.get(s)).filter(Boolean).concat(list.filter((r) => !frozen.has(r.slug)));
    };
    const unchecked = () => ranked.filter((r) => passesYear(r, w) && !hasDetails(r.film));
    // data-busy is set while fetching/syncing (also used by the tests to know when the page is idle).
    let refreshing = false, syncing = false;
    const updateBusy = () => { if (refreshing || syncing) root.dataset.busy = '1'; else delete root.dataset.busy; };
    const syncStatus = el('p', { class: 'lfr-sync-status' });

    async function load() {
      const [users, filmList, wl, last] = await Promise.all([idb.all('users'), idb.all('films'), idb.get('meta', 'watchlist'), idb.get('meta', 'lastSync')]);
      films = new Map(filmList.map((f) => [f.slug, f]));
      watchlist = new Set(wl?.slugs || []);
      lastSync = last?.at || null;
      prep = users.some((u) => u.username !== me) ? prepare(users, me) : null;
      friendCount = prep?.friends.length || 0;
    }

    let refreshTimer = null;
    const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { resetPaging(); refresh(); }, 200); };

    // Rank, then fetch details for the films on the current page (and, with genre/country/language
    // filters, check the next candidates until the page is full), re-ranking as details arrive.
    async function refresh() {
      if (!prep) { render(); return; }
      const t = ++token;
      let scanned = 0, checked = 0;
      scanPaused = false;
      refreshing = true;
      updateBusy();
      ranked = rank(prep, films, watchlist, w);
      render();
      try {
        for (let round = 0; round < 80 && t === token; round++) {
          const list = visible();
          const end = page * P;
          let need = list.slice(end - P, end).filter((r) => needsDetails(r.film)).map((r) => r.slug);
          let scanning = false;
          if (!need.length && strictActive(w) && list.length < end) {
            const rest = unchecked();
            if (!rest.length) break;
            if (scanned >= CFG.scanPerRun) { scanPaused = true; break; }
            need = rest.slice(0, CFG.scanBatch).map((r) => r.slug);
            scanned += need.length;
            scanning = true;
          }
          if (!need.length) break;
          // Show progress for every film checked: requests are deliberately slow (~3 per second).
          const showProgress = () => {
            busyNote = scanning
              ? `Checking your friends’ films against these filters… ${checked.toLocaleString()} checked, ${visible().length.toLocaleString()} match so far`
              : 'Loading posters and details…';
            note.textContent = busyNote;
          };
          render();
          showProgress();
          await ensureGlobals(films, need, () => { if (t !== token) return; if (scanning) checked++; showProgress(); });
          if (t !== token) return;
          ranked = rank(prep, films, watchlist, w);
          render();
        }
      } finally {
        if (t === token) { busyNote = ''; refreshing = false; updateBusy(); render(); }
      }
    }

    function card(r) {
      const f = r.film || {};
      const y = yearOf(f);
      const name = f.name || r.slug;
      const title = y && !/\(\d{4}\)\s*$/.test(name) ? `${name} (${y})` : name;
      const raters = [...r.raters].sort((a, b) => b.stars - a.stars)
        .map((x) => `${x.user} ${x.stars ? stars(x.stars) : '(watched)'}${x.liked ? ' ♥' : ''}`);
      const tip = [
        title,
        `Watched by ${plural(r.n, 'friend')}${r.friendAvg != null ? ` · friends’ average ${r.friendAvg.toFixed(1)}` : ''}${f.avg != null ? ` · Letterboxd ${f.avg.toFixed(1)}` : ''}`,
        r.inWl ? 'In your watchlist' : null,
        '',
        ...raters.slice(0, 12),
        raters.length > 12 ? `+${raters.length - 12} more` : null,
      ].filter((x) => x != null).join('\n');
      const img = f.image || emptyPoster;
      return el('li', { class: 'griditem', 'data-slug': r.slug }, [
        el('div', { class: 'poster film-poster' }, [
          img ? el('img', { class: 'image', src: img, width: 125, height: 187, alt: `Poster for ${title}`, loading: 'lazy' }) : el('span', { class: 'lfr-ph' }),
          el('a', { class: 'frame', href: `/film/${r.slug}/`, title: tip }, [el('span', { class: 'frame-title', text: title }), el('span', { class: 'overlay' })]),
        ]),
        el('p', { class: 'poster-viewingdata lfr-vd', title: tip }, [
          r.friendAvg != null ? el('span', { class: 'lfr-stars', text: stars(r.friendAvg) }) : null,
          el('span', { text: plural(r.n, 'friend') }),
          r.inWl ? el('span', { class: 'lfr-wl', title: 'In your watchlist' }) : null,
        ]),
      ]);
    }

    function renderPager(total, more) {
      const pages = Math.max(1, Math.ceil(total / P));
      if (pages <= 1) { pager.replaceChildren(); return; }
      const go = (p) => (e) => {
        e.preventDefault();
        if (p > page) placed = visible().slice(0, page * P).map((r) => r.slug); // lock what you've seen
        page = p;
        refresh();
        main.scrollIntoView({ behavior: 'smooth' });
      };
      const link = (p, text, cls) => el('a', { href: '#', class: cls, text, onclick: go(p) });
      const nums = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
      const items = [];
      nums.forEach((p, i) => {
        if (i && p - nums[i - 1] > 1) items.push(el('li', { class: 'paginate-page unseen-pages', text: '…' }));
        items.push(el('li', { class: `paginate-page${p === page ? ' paginate-current' : ''}` }, [p === page ? el('span', { text: String(p) }) : link(p, String(p))]));
      });
      pager.replaceChildren(
        el('div', { class: `paginate-nextprev${page <= 1 ? ' paginate-disabled' : ''}` }, [page <= 1 ? el('span', { class: 'previous', text: 'Previous' }) : link(page - 1, 'Previous', 'previous')]),
        el('div', { class: `paginate-nextprev${page >= pages && !more ? ' paginate-disabled' : ''}` }, [page >= pages ? el('span', { class: 'next', text: 'Next' }) : link(page + 1, 'Next', 'next')]),
        el('div', { class: 'paginate-pages' }, [el('ul', {}, items)]),
      );
    }

    function render() {
      menus.forEach((m) => m.refreshLabel());
      clearItem.classList.toggle('lfr-hidden', !filtersActive(w));
      about.replaceChildren(
        el('p', { text: `Films watched by the ${friendCount.toLocaleString()} ${friendCount === 1 ? 'person' : 'people'} you follow that you haven’t seen yet, ranked by their ratings (adjusted for how generous each person is and how close their taste is to yours), how many of them watched it, and the Letterboxd average.` }),
        el('p', { text: `Last synced ${ago(lastSync)}. Each sync only fetches what changed.` }),
      );
      if (!prep) {
        heading.textContent = 'Recommended by friends';
        sortBar.classList.add('lfr-hidden');
        grid.replaceChildren();
        pager.replaceChildren();
        note.replaceChildren(el('div', { class: 'lfr-empty' }, [
          el('p', { text: 'Get film recommendations from the people you follow.' }),
          el('p', { text: 'The first sync reads every film they’ve watched, once. It takes a few minutes; after that, only new activity is fetched.' }),
          el('a', { href: '#', class: 'button -action button-green', 'data-lfr': 'first-sync', text: 'Sync now', onclick: (e) => { e.preventDefault(); sync(); } }),
          syncStatus,
        ]));
        return;
      }
      sortBar.classList.remove('lfr-hidden');
      const list = visible();
      const left = strictActive(w) ? unchecked().length : 0;
      const n = list.length;
      heading.textContent = `Your friends recommend ${n.toLocaleString()}${left ? '+' : ''} ${n === 1 && !left ? 'film' : 'films'}`;
      const end = page * P;
      grid.replaceChildren(...list.slice(end - P, end).map(card));
      renderPager(n, scanPaused && left > 0);
      if (busyNote) note.replaceChildren(busyNote);
      else if (scanPaused && left && n < end) {
        note.replaceChildren(
          `${left.toLocaleString()} of your friends’ films haven’t been checked against these filters yet. `,
          el('button', { class: 'lfr-link', 'data-lfr': 'check-more', text: 'Check more films', onclick: () => refresh() }),
        );
      } else if (!n) {
        note.replaceChildren(
          el('div', { class: 'lfr-empty' }, ['No films match these filters. ', el('button', { class: 'lfr-link', text: 'Clear filters', onclick: clearFilters })]),
        );
      } else note.replaceChildren();
    }

    function clearFilters() {
      FILTER_KEYS.forEach((k) => { w[k] = Array.isArray(DEFAULT_WEIGHTS[k]) ? [] : DEFAULT_WEIGHTS[k]; });
      savePrefs(w);
      resetPaging();
      refresh();
    }

    async function sync() {
      if (syncing) return;
      syncing = true;
      updateBusy();
      const show = (s) => { syncLink.textContent = s; syncStatus.textContent = s; };
      try {
        await syncAll(me, (s) => show(s.split(' · ')[0]));
        await load();
        show('Sync friends’ films');
        syncStatus.textContent = '';
        await refresh();
      } catch (err) {
        console.error('[friend-recs]', err);
        show('Sync stopped. Try again');
      } finally { syncing = false; updateBusy(); }
    }
    syncLink.addEventListener('click', (e) => { e.preventDefault(); sync(); });

    // Rebuild the whole page (used by "Reset to defaults" so sliders show the new values).
    const rebuild = () => { root.dispatchEvent(new CustomEvent('lfr-rebuild')); };

    const start = async () => {
      await load();
      await refresh();
      if (prep && (!lastSync || Date.now() - lastSync > CFG.autoSyncHours * HOUR)) sync();
    };
    return { root, start, destroy: () => { token++; menus.forEach((m) => m.close()); root.remove(); } };
  }

  // ---------- Routing + entry points ----------
  function addNavEntries(me) {
    const href = routeHref(me);
    // Account menu in the header: after "Watchlist".
    if (!document.querySelector('.lfr-subnav')) {
      const wl = [...document.querySelectorAll('header ul.subnav a, .main-nav ul.subnav a')]
        .find((a) => (a.getAttribute('href') || '').toLowerCase() === `/${me}/watchlist/`);
      wl?.parentElement.after(el('li', { class: 'lfr-subnav' }, [el('a', { href, text: 'Friend recs' })]));
    }
    // Profile tabs, on your own profile only: after "Watchlist".
    if (!document.querySelector('.lfr-navitem')) {
      const tab = document.querySelector('.profile-navigation .navlist li.js-page-watchlist');
      if (tab && (tab.dataset.owner || '').toLowerCase() === me) {
        tab.after(el('li', { class: 'navitem lfr-navitem', 'data-owner': tab.dataset.owner }, [el('a', { class: 'navlink', href, text: 'Recs' })]));
      }
    }
  }

  let current = null, hostEl = null, prevTitle = '';
  function setActiveTab(on) {
    const ours = document.querySelector('.lfr-navitem');
    const wl = document.querySelector('.profile-navigation .navlist li.js-page-watchlist');
    ours?.classList.toggle('-active', on);
    wl?.classList.toggle('-active', !on);
  }
  function enterRoute(me) {
    if (current) return;
    hostEl = document.querySelector('#content .cols-2') || null;
    const mountPoint = hostEl?.parentElement || document.querySelector('#content .content-wrap') || document.querySelector('#content') || document.body;
    const make = () => {
      current = createPage(me);
      current.root.addEventListener('lfr-rebuild', () => { current.destroy(); current = null; make(); });
      if (hostEl) hostEl.after(current.root); else mountPoint.append(current.root);
      current.start();
    };
    hostEl?.classList.add('lfr-hidden');
    prevTitle = document.title;
    document.title = 'Recommended by friends • Letterboxd';
    setActiveTab(true);
    make();
  }
  function leaveRoute() {
    if (!current) return;
    current.destroy();
    current = null;
    hostEl?.classList.remove('lfr-hidden');
    document.title = prevTitle;
    setActiveTab(false);
  }

  let mountedFor = null;
  function mount() {
    const me = detectMe();
    if (!me) return false;
    if (mountedFor) return true;
    mountedFor = me;
    document.head.append(el('style', { text: STYLE }));
    addNavEntries(me);
    // The header and profile tabs can be rendered after us; keep trying for a while.
    const navTimer = setInterval(() => addNavEntries(me), 1000);
    setTimeout(() => clearInterval(navTimer), 30000);
    window.addEventListener('hashchange', () => { if (isRoute(me)) { addNavEntries(me); enterRoute(me); } else leaveRoute(); });
    if (isRoute(me)) enterRoute(me);
    return true;
  }
  // Retry until the page has finished filling in the signed-in user (up to 30 s; nothing happens when signed out).
  if (!mount()) {
    const timer = setInterval(() => { if (mount()) clearInterval(timer); }, 500);
    setTimeout(() => clearInterval(timer), 30000);
  }
})();
