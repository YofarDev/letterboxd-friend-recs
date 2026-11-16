// ==UserScript==
// @name         Letterboxd — Friend recommendations
// @namespace    yofardev.letterboxd-friend-recs
// @version      1.4.0
// @description  Recommends films you haven't watched, scored from the ratings of the people you follow, how many of them watched it, and the global Letterboxd average. Data is cached in IndexedDB and synced incrementally.
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
    scanBatch: 60,           // genre/country/language filters: film pages checked per round…
    scanPerRun: 300,         // …and at most this many per filter change (then a "Check more" button)
    pageSize: 60,            // cards shown per "Show more"
    dbName: 'lbxFriendRecs',
    prefsKey: 'lbxFriendRecs:weights',
  };
  const DEFAULT_WEIGHTS = {
    k: 2,            // pull toward the global average (in "friend ratings" worth)
    beta: 0.15,      // bonus per ln(1 + friends who watched)
    taste: 1,        // how much friends whose taste matches yours count extra
    likeBonus: 0.25, // stars added to a friend's rating when they also liked the film
    minFriends: 2,   // hide films watched by fewer friends than this
    watchlist: 'all',// 'all' | 'only' | 'hide'
    minRuntime: 60,  // hide anything shorter than this many minutes (0 = keep shorts)
    kind: 'movie',   // 'movie' | 'tv' | 'all'  (series = TMDB TV entries, e.g. miniseries)
    sort: 'score',   // 'score' (recommendation score) | 'watched' (most follows watched it, ratings ignored)
    yearFrom: null,  // release year range (null = open)
    yearTo: null,
    genre: '',       // only this genre ('' = any)
    exGenre: '',     // never this genre
    country: '',     // any production country matches (e.g. "France")
    language: '',    // any listed language matches, by name or code (e.g. "Japanese" or "ja")
  };
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

  async function ensureGlobals(films, slugs) {
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
    const byWatched = (x, y) => y.n - x.n || (x.film?.name || x.slug).localeCompare(y.film?.name || y.slug);
    return out.sort(w.sort === 'watched' ? byWatched : (x, y) => y.score - x.score);
  }

  // ---------- Filters ----------
  // Year is known for every film (it's in the synced film name). Everything else needs the film's
  // details, which are fetched for the top results only.
  const yearOf = (f) => f?.year ?? (+((f?.name || '').match(/\((\d{4})\)\s*$/)?.[1]) || null);
  // Genre/country/language are "strict": a film whose details we don't have yet can't be shown.
  // Length/type are lenient: those films are shown until their details arrive (most films pass anyway).
  const strictActive = (w) => !!(w.genre || w.exGenre || w.country || w.language);
  const norm = (s) => String(s || '').trim().toLowerCase();

  function passesYear(r, w) {
    if (w.yearFrom == null && w.yearTo == null) return true;
    const y = yearOf(r.film);
    if (y == null) return !hasDetails(r.film); // unknown year: wait for details
    return (w.yearFrom == null || y >= w.yearFrom) && (w.yearTo == null || y <= w.yearTo);
  }

  function passesFilters(r, w) {
    if (!passesYear(r, w)) return false;
    const f = r.film;
    if (!hasDetails(f)) return !strictActive(w);
    if (w.minRuntime && f.runtime != null && f.runtime < w.minRuntime) return false;
    if (w.kind !== 'all' && f.kind && f.kind !== w.kind) return false;
    const genres = (f.genres || []).map(norm);
    if (w.genre && !genres.includes(norm(w.genre))) return false;
    if (w.exGenre && genres.includes(norm(w.exGenre))) return false;
    if (w.country && !(f.countries || []).some((c) => norm(c) === norm(w.country))) return false;
    if (w.language && !(f.languages || []).some((l) => norm(l) === norm(w.language) || norm(langName(l)) === norm(w.language))) return false;
    return true;
  }

  // ---------- UI ----------
  const STYLE = `
    .lfr-btn{position:fixed;left:20px;bottom:20px;z-index:9999;padding:10px 16px;border:0;border-radius:999px;background:#00b020;color:#fff;
      font:600 13px/1 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer}
    .lfr{position:fixed;inset:0;z-index:10000;background:#14181c;color:#def;font:14px/1.4 system-ui,sans-serif;display:flex;flex-direction:column}
    .lfr header{padding:14px 20px;border-bottom:1px solid #2c3440;display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center}
    .lfr h2{margin:0 auto 0 0;font-size:18px;color:#fff}
    .lfr button{padding:8px 14px;border-radius:6px;border:1px solid #456;background:#2c3440;color:#fff;cursor:pointer;font:600 13px system-ui,sans-serif}
    .lfr button.primary{background:#00b020;border-color:#00b020}
    .lfr button:disabled{opacity:.5;cursor:progress}
    .lfr .ctrls{padding:10px 20px;border-bottom:1px solid #2c3440;display:flex;flex-wrap:wrap;gap:10px 22px;align-items:flex-end}
    .lfr label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:#89a;text-transform:uppercase;letter-spacing:.04em}
    .lfr label b{color:#fff;font-weight:600;text-transform:none;letter-spacing:0}
    .lfr label.off{opacity:.35;pointer-events:none}
    .lfr input[type=range]{width:140px;accent-color:#00b020}
    .lfr select,.lfr input[type=text],.lfr input[type=number]{background:#2c3440;color:#fff;border:1px solid #456;border-radius:6px;padding:5px 8px;font:13px system-ui,sans-serif}
    .lfr input[type=text]{width:130px}
    .lfr input[type=number]{width:80px}
    .lfr .status{padding:8px 20px;color:#89a;font-size:12px;min-height:16px}
    .lfr .grid{flex:1;overflow:auto;padding:12px 20px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-content:start}
    .lfr .card{display:flex;gap:12px;background:#1c2228;border-radius:8px;padding:10px;min-width:0}
    .lfr .card img{width:70px;height:105px;object-fit:cover;border-radius:4px;background:#2c3440;flex:none}
    .lfr .card .ph{width:70px;height:105px;border-radius:4px;background:#2c3440;flex:none}
    .lfr .card .body{min-width:0;display:flex;flex-direction:column;gap:4px}
    .lfr .card a.t{color:#fff;font-weight:700;text-decoration:none;font-size:15px}
    .lfr .card a.t:hover{text-decoration:underline}
    .lfr .card .meta{color:#89a;font-size:12px}
    .lfr .card .stats{font-size:12px;color:#cde}
    .lfr .card .score{color:#00e054;font-weight:700}
    .lfr .card .wl{color:#40bcf4;font-size:11px;font-weight:600}
    .lfr .card details{font-size:12px;color:#9ab}
    .lfr .card details summary{cursor:pointer}
    .lfr .more{grid-column:1/-1;justify-self:center}
    .lfr .empty{grid-column:1/-1;padding:40px;text-align:center;color:#89a}
  `;

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null) n.append(c);
    return n;
  }

  const readWeights = () => { try { return { ...DEFAULT_WEIGHTS, ...JSON.parse(localStorage.getItem(CFG.prefsKey) || '{}') }; } catch { return { ...DEFAULT_WEIGHTS }; } };
  const saveWeights = (w) => { try { localStorage.setItem(CFG.prefsKey, JSON.stringify(w)); } catch { /* ignore */ } };
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const starStr = (s) => (s == null ? '–' : s.toFixed(1));

  async function openApp(me) {
    document.querySelector('.lfr')?.remove();
    const w = readWeights();
    let prep = null, films = new Map(), watchlist = new Set(), ranked = [], shown = CFG.pageSize, renderToken = 0;

    const statusEl = el('div', { class: 'status' });
    const grid = el('div', { class: 'grid' });
    const lastSyncEl = el('span', { class: 'meta' });
    const syncBtn = el('button', { class: 'primary', text: 'Sync now' });
    const setStatus = (s) => (statusEl.textContent = s);

    const slider = (key, label, min, max, step, fmt = (v) => v) => {
      const val = el('b', { text: fmt(w[key]) });
      const input = el('input', { type: 'range', min, max, step, value: w[key] });
      input.addEventListener('input', () => { w[key] = +input.value; val.textContent = fmt(w[key]); saveWeights(w); scheduleRank(); });
      return el('label', {}, [label, val, input]);
    };
    const wlSel = el('select', {}, [['all', 'All films'], ['only', 'Only my watchlist'], ['hide', 'Hide my watchlist']]
      .map(([v, t]) => el('option', { value: v, text: t })));
    wlSel.value = w.watchlist;
    wlSel.addEventListener('change', () => { w.watchlist = wlSel.value; saveWeights(w); scheduleRank(); });
    const kindSel = el('select', {}, [['movie', 'Films only'], ['tv', 'Series only'], ['all', 'Films + series']]
      .map(([v, t]) => el('option', { value: v, text: t })));
    kindSel.value = w.kind;
    kindSel.addEventListener('change', () => { w.kind = kindSel.value; saveWeights(w); scheduleRank(); });
    // Score sliders do nothing in "most watched" mode, so they are dimmed there.
    const scoreCtrls = [
      slider('k', 'Pull to global avg', 0, 10, 0.5),
      slider('beta', 'Bonus: # friends watched', 0, 0.6, 0.05),
      slider('taste', 'Taste matching', 0, 2, 0.1),
      slider('likeBonus', 'Like bonus (★)', 0, 1, 0.05),
    ];
    const syncScoreCtrls = () => scoreCtrls.forEach((c) => c.classList.toggle('off', w.sort === 'watched'));
    const sortSel = el('select', {}, [['score', 'Recommended (score)'], ['watched', 'Most watched by follows']]
      .map(([v, t]) => el('option', { value: v, text: t })));
    sortSel.value = w.sort;
    sortSel.addEventListener('change', () => { w.sort = sortSel.value; saveWeights(w); syncScoreCtrls(); scheduleRank(); });
    syncScoreCtrls();

    // Letterboxd-style filters (second row).
    const setFilter = (key, value) => { w[key] = value; saveWeights(w); scheduleRank(); };
    const yearInput = (key, label) => {
      const input = el('input', { type: 'number', min: 1870, max: 2100, placeholder: 'any', value: w[key] ?? '' });
      input.addEventListener('change', () => setFilter(key, input.value === '' ? null : +input.value));
      return el('label', {}, [label, input]);
    };
    const genreSelect = (key, label, anyText) => {
      const s = el('select', {}, [el('option', { value: '', text: anyText }), ...GENRES.map((g) => el('option', { value: g, text: g }))]);
      s.value = w[key] || '';
      s.addEventListener('change', () => setFilter(key, s.value));
      return el('label', {}, [label, s]);
    };
    const countryList = el('datalist', { id: 'lfr-countries' });
    const langList = el('datalist', { id: 'lfr-langs' });
    const textFilter = (key, label, listId, placeholder) => {
      const input = el('input', { type: 'text', list: listId, placeholder, value: w[key] || '' });
      input.addEventListener('change', () => setFilter(key, input.value.trim()));
      return el('label', {}, [label, input]);
    };
    function refreshDatalists() {
      const cs = new Set(COMMON_COUNTRIES), ls = new Set(COMMON_LANGS);
      for (const f of films.values()) { (f.countries || []).forEach((c) => cs.add(c)); (f.languages || []).forEach((l) => ls.add(l)); }
      countryList.replaceChildren(...[...cs].sort().map((c) => el('option', { value: c })));
      langList.replaceChildren(...[...new Set([...ls].map(langName))].sort().map((n) => el('option', { value: n })));
    }
    const clearFilters = () => {
      Object.assign(w, { yearFrom: null, yearTo: null, genre: '', exGenre: '', country: '', language: '' });
      saveWeights(w);
      openApp(me); // rebuild the controls with empty values
    };

    const app = el('div', { class: 'lfr' }, [
      el('header', {}, [
        el('h2', { text: 'Recommended by people you follow' }),
        lastSyncEl, syncBtn,
        el('button', { text: 'Close', onclick: () => app.remove() }),
      ]),
      el('div', { class: 'ctrls' }, [
        el('label', {}, ['Sort', sortSel]),
        ...scoreCtrls,
        slider('minFriends', 'Min. friends', 1, 10, 1),
        slider('minRuntime', 'Min. length', 0, 120, 5, (v) => (v ? `${v} min` : 'any')),
        el('label', {}, ['Type', kindSel]),
        el('label', {}, ['Watchlist', wlSel]),
      ]),
      el('div', { class: 'ctrls' }, [
        yearInput('yearFrom', 'Year from'),
        yearInput('yearTo', 'Year to'),
        genreSelect('genre', 'Genre', 'Any genre'),
        genreSelect('exGenre', 'Exclude genre', 'None'),
        textFilter('country', 'Country', 'lfr-countries', 'any'),
        textFilter('language', 'Language', 'lfr-langs', 'any'),
        el('button', { text: 'Clear filters', onclick: clearFilters }),
        countryList, langList,
      ]),
      statusEl, grid,
    ]);
    document.body.append(app);

    async function load() {
      const [users, filmList, wl, last] = await Promise.all([idb.all('users'), idb.all('films'), idb.get('meta', 'watchlist'), idb.get('meta', 'lastSync')]);
      films = new Map(filmList.map((f) => [f.slug, f]));
      watchlist = new Set(wl?.slugs || []);
      lastSyncEl.textContent = `Last sync: ${ago(last?.at)}`;
      prep = users.some((u) => u.username !== me) ? prepare(users, me) : null;
      return { users, last };
    }

    let rankTimer = null;
    const scheduleRank = () => { clearTimeout(rankTimer); rankTimer = setTimeout(() => { shown = CFG.pageSize; rerank(); }, 150); };

    const visible = () => ranked.filter((r) => passesFilters(r, w));
    const unchecked = () => ranked.filter((r) => passesYear(r, w) && !hasDetails(r.film));
    let scanPaused = false;

    async function rerank() {
      if (!prep) return;
      const token = ++renderToken;
      let scanned = 0;
      scanPaused = false;
      ranked = rank(prep, films, watchlist, w);
      render();
      // Fetch details for the shown films, then re-rank and re-filter (the global rating can move films;
      // shorts/series drop out). With genre/country/language filters and a page that isn't full yet,
      // check the next unchecked candidates in rank order, up to scanPerRun films.
      for (let round = 0; round < 40 && token === renderToken; round++) {
        const list = visible();
        let need = list.slice(0, shown).filter((r) => needsDetails(r.film)).map((r) => r.slug);
        let label = `Fetching details for ${need.length} films…`;
        if (!need.length && strictActive(w) && list.length < shown) {
          const rest = unchecked();
          if (!rest.length) break;
          if (scanned >= CFG.scanPerRun) { scanPaused = true; render(); break; }
          need = rest.slice(0, CFG.scanBatch).map((r) => r.slug);
          scanned += need.length;
          label = `Checking films against your filters… ${scanned} checked, ${list.length} match so far`;
        }
        if (!need.length) break;
        setStatus(label);
        await ensureGlobals(films, need);
        if (token !== renderToken) return;
        ranked = rank(prep, films, watchlist, w);
        render();
      }
      if (token !== renderToken) return;
      refreshDatalists();
      const left = strictActive(w) ? unchecked().length : 0;
      setStatus(`${visible().length.toLocaleString()} shown of ${ranked.length.toLocaleString()} candidates watched by your follows and not by you · ${prep.friends.length} follows`
        + (left ? ` · ${left.toLocaleString()} candidates not checked against genre/country/language yet` : ''));
    }

    function card(r) {
      const f = r.film || { name: r.slug };
      const raters = [...r.raters].sort((a, b) => b.stars - a.stars);
      return el('div', { class: 'card' }, [
        f.image ? el('img', { src: f.image, alt: '', loading: 'lazy' }) : el('div', { class: 'ph' }),
        el('div', { class: 'body' }, [
          el('a', { class: 't', href: `/film/${r.slug}/`, target: '_blank', text: f.name }),
          el('div', { class: 'meta', text: [f.kind === 'tv' && 'Series', yearOf(f), f.runtime && `${f.runtime} min`, f.directors?.length && f.directors.slice(0, 2).join(', ')].filter(Boolean).join(' · ') }),
          f.genres?.length || f.countries?.length
            ? el('div', { class: 'meta', text: [f.genres?.slice(0, 3).join(', '), f.countries?.slice(0, 2).join(', ')].filter(Boolean).join(' · ') })
            : null,
          el('div', { class: 'stats' }, [
            ...(w.sort === 'watched'
              ? [el('span', { class: 'score', text: `👥 ${r.n} watched` }), ` · Score ${r.score.toFixed(2)}`]
              : [el('span', { class: 'score', text: `Score ${r.score.toFixed(2)}` }), ` · 👥 ${r.n} watched`]),
            ` · ★ ${starStr(r.friendAvg)} friends (${r.nRated}) · 🌍 ${starStr(r.film?.avg)}`,
            r.nLiked ? ` · ♥ ${r.nLiked}` : '',
          ]),
          r.inWl ? el('div', { class: 'wl', text: 'On your watchlist' }) : null,
          el('details', {}, [
            el('summary', { text: 'Who watched it' }),
            el('div', { text: raters.map((x) => `${x.user} ${x.stars ? `★${x.stars}` : '✓'}${x.liked ? ' ♥' : ''}`).join(' · ') }),
          ]),
        ]),
      ]);
    }

    function render() {
      if (!prep) {
        grid.replaceChildren(el('div', { class: 'empty', text: 'No data yet. Click "Sync now" — the first sync reads every film your follows have watched, which can take several minutes. Later syncs only fetch what changed.' }));
        return;
      }
      const list = visible();
      const cards = list.slice(0, shown).map(card);
      const left = strictActive(w) ? unchecked().length : 0;
      if (!cards.length) cards.push(el('div', { class: 'empty', text: left ? 'No matches among the films checked so far…' : 'Nothing matches these filters.' }));
      if (list.length > shown) cards.push(el('button', { class: 'more', text: 'Show more', onclick: () => { shown += CFG.pageSize; rerank(); } }));
      else if (scanPaused && left) {
        cards.push(el('button', { class: 'more', text: `Check ${Math.min(CFG.scanPerRun, left)} more films (${left.toLocaleString()} not checked yet)`, onclick: () => rerank() }));
      }
      grid.replaceChildren(...cards);
    }

    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      try {
        await syncAll(me, setStatus);
        await load();
        await rerank();
      } catch (err) {
        console.error('[friend-recs]', err);
        setStatus(`Sync stopped: ${err.message}. Synced follows are kept; run it again to continue.`);
      } finally { syncBtn.disabled = false; }
    });

    await load();
    render();
    if (prep) await rerank();
    else setStatus('Not synced yet.');
  }

  function mount() {
    const me = detectMe();
    if (!me) return false;
    if (document.querySelector('.lfr-btn')) return true;
    document.head.append(el('style', { text: STYLE }));
    document.body.append(el('button', { class: 'lfr-btn', type: 'button', text: '🎯 Friend recs', onclick: () => openApp(me) }));
    return true;
  }
  // Retry until the page has finished filling in the signed-in user (up to 30 s; never appears when signed out).
  if (!mount()) {
    const timer = setInterval(() => { if (mount()) clearInterval(timer); }, 500);
    setTimeout(() => clearInterval(timer), 30000);
  }
})();
