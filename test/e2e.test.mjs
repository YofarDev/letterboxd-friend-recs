// End-to-end test: loads the real userscript into jsdom with a fake Letterboxd
// (pre-synced IndexedDB + fake film pages) and drives the results page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const SCRIPT_PATH = fileURLToPath(new URL('../letterboxd-friend-recs.user.js', import.meta.url));
// No politeness delay in tests.
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8').replace(/minGapMs:\s*\d+/, 'minGapMs: 0');

// ---- Fake data: 5 follows who all watched films 0..399; "me" watched films 0..9.
const N_FILMS = 400;
const N_FRIENDS = 5;
const film = (i) => ({
  name: `Film ${i}`,
  year: 1950 + (i % 70),
  genres: i % 8 === 0 ? ['Horror'] : ['Drama'],
  runtime: i % 10 === 1 ? 20 : 100, // shorts
  tv: i % 17 === 0,                 // series
  countries: i % 5 === 0 ? ['France'] : ['USA'],
  langs: i % 5 === 0 ? ['fr'] : ['en'],
});
const candidates = Array.from({ length: N_FILMS }, (_, i) => i).filter((i) => i >= 10); // not watched by me
const isFeature = (i) => film(i).runtime >= 60 && !film(i).tv;

function filmPage(i) {
  const m = film(i);
  const ld = {
    '@type': 'Movie', name: m.name, genre: m.genres,
    countryOfOrigin: m.countries.map((name) => ({ '@type': 'Country', name })),
    inLanguage: m.langs, director: [{ name: 'Someone' }], image: `https://a.ltrbxd.com/p${i}.jpg`,
    aggregateRating: { ratingValue: 3 + (i % 20) / 10, ratingCount: 1000 },
  };
  return `<html><head><meta property="og:title" content="${m.name} (${m.year})"></head><body>
    <script type="application/ld+json">/* <![CDATA[ */${JSON.stringify(ld)}/* ]]> */</script>
    <p class="text-link">${m.runtime} mins More at <a href="https://www.themoviedb.org/${m.tv ? 'tv' : 'movie'}/${i}/">TMDB</a></p>
  </body></html>`;
}

async function seed(idb) {
  await new Promise((resolve, reject) => {
    const r = idb.open('lbxFriendRecs', 1);
    r.onupgradeneeded = () => {
      for (const [name, keyPath] of [['users', 'username'], ['films', 'slug'], ['meta', 'key']]) r.result.createObjectStore(name, { keyPath });
    };
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(['users', 'films', 'meta'], 'readwrite');
      const now = Date.now();
      const mine = {};
      for (let i = 0; i < 10; i++) mine[`s${i}`] = [8, 0];
      tx.objectStore('users').put({ username: 'me', films: mine, lastFull: now, lastDelta: now, watchedCount: 10 });
      for (let u = 0; u < N_FRIENDS; u++) {
        const films = {};
        for (let i = 0; i < N_FILMS; i++) films[`s${i}`] = [1 + ((i * 7 + u * 3) % 10), i % 9 === 0 ? 1 : 0];
        tx.objectStore('users').put({ username: `f${u}`, films, lastFull: now, lastDelta: now, watchedCount: N_FILMS });
      }
      for (let i = 0; i < N_FILMS; i++) tx.objectStore('films').put({ slug: `s${i}`, name: `Film ${i} (${film(i).year})` });
      tx.objectStore('meta').put({ key: 'lastSync', at: now, me: 'me' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  });
}

// A minimal copy of the watchlist page the recs page is hosted on: header account menu,
// profile tabs, and the watchlist content (which the script hides).
const PAGE_HTML = `<!doctype html><html><head></head><body>
  <header><nav class="main-nav"><ul class="subnav">
    <li><a href="/me/">Profile</a></li><li><a href="/me/watchlist/">Watchlist</a></li><li><a href="/me/lists/">Lists</a></li>
  </ul></nav></header>
  <div id="content"><div class="content-wrap">
    <section class="profile-header"><nav class="profile-navigation"><ul class="navlist">
      <li class="navitem js-page-films" data-owner="Me"><a class="navlink" href="/me/films/">Films</a></li>
      <li class="navitem js-page-watchlist -active" data-owner="Me"><a class="navlink" href="/me/watchlist/">Watchlist</a></li>
      <li class="navitem js-page-lists" data-owner="Me"><a class="navlink" href="/me/lists/">Lists</a></li>
    </ul></nav></section>
    <div class="cols-2 js-watchlist-content"><section class="col-main"><div class="poster-grid"><ul class="grid">
      <li class="griditem"><div data-empty-poster-src="https://s.ltrbxd.com/empty.png"></div></li>
    </ul></div></section></div>
  </div></div>
</body></html>`;

async function setup() {
  const idb = new IDBFactory();
  await seed(idb);
  const dom = new JSDOM(PAGE_HTML, { url: 'https://letterboxd.com/me/watchlist/#friend-recs', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const stats = { filmFetches: 0 };
  window.indexedDB = idb;
  window.IDBKeyRange = IDBKeyRange;
  window.person = { loggedIn: true, username: 'Me' };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (path) => {
    const m = String(path).match(/^\/film\/s(\d+)\/$/);
    if (m) { stats.filmFetches++; return new Response(filmPage(+m[1]), { status: 200 }); }
    return new Response('', { status: 404 });
  };
  window.eval(SCRIPT);

  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ui = {
    window, stats, $, $$,
    // Wait until the page isn't fetching or syncing and the grid has stopped changing.
    async settle() {
      let last = '', stable = 0;
      for (let i = 0; i < 600; i++) {
        await sleep(50);
        const root = $('.lfr-page');
        const snapshot = root ? `${root.dataset.busy || ''}|${ui.slugs().join(',')}|${$('.lfr-page h1').textContent}` : '';
        if (root && !root.dataset.busy && snapshot === last) { if (++stable >= 6) return; } else stable = 0;
        last = snapshot;
      }
      throw new Error('recs page never settled');
    },
    // Film indexes shown on the current page (slugs are "s<index>").
    slugs: () => $$('.lfr-page .poster-grid li.griditem').map((li) => +li.dataset.slug.slice(1)),
    // Every film across all pages (walks the pagination, then goes back to page 1).
    async all() {
      const out = [...ui.slugs()];
      for (let i = 0; i < 50; i++) {
        const next = $('.lfr-page .pagination a.next');
        if (!next) break;
        next.click();
        await ui.settle();
        out.push(...ui.slugs());
      }
      const first = $$('.lfr-page .pagination .paginate-page a').find((a) => a.textContent === '1');
      if (first) { first.click(); await ui.settle(); }
      return out;
    },
    // Pick an item in one of the Letterboxd-style dropdowns.
    async pick(menuId, value) {
      if (!$(`ul.lfr-menu[data-lfr-menu="${menuId}"]`)) $(`.lfr-page [data-lfr-menu="${menuId}"] .smenu label`).click();
      const item = $(`ul.lfr-menu[data-lfr-menu="${menuId}"] a[data-value="${value}"]`);
      assert.ok(item, `menu "${menuId}" has item "${value}"`);
      item.click();
      await ui.settle();
    },
    menuLabel: (menuId) => $(`.lfr-page [data-lfr-menu="${menuId}"] .smenu label`).textContent.trim(),
  };
  return ui;
}

test('recs page end to end', async (t) => {
  const ui = await setup();
  await ui.settle();

  await t.test('opens as a native page on the watchlist route', () => {
    assert.ok(ui.$('.lfr-page'), 'page is rendered');
    assert.ok(ui.$('.js-watchlist-content').classList.contains('lfr-hidden'), 'watchlist content is hidden');
    assert.ok(ui.$('.lfr-navitem.-active'), '"Recs" profile tab is added and active');
    assert.ok(!ui.$('.js-page-watchlist').classList.contains('-active'), 'watchlist tab is no longer active');
    assert.equal(ui.$('.lfr-subnav a').getAttribute('href'), '/me/watchlist/#friend-recs', 'account menu entry');
    assert.match(ui.$('.lfr-page h1.section-heading').textContent, /^Your friends recommend \d+ films$/);
  });

  await t.test('default: films only, no shorts, no watched films, paginated', async () => {
    assert.equal(ui.slugs().length, 50, 'first page is full');
    const all = await ui.all();
    assert.equal(all.length, candidates.filter(isFeature).length);
    assert.equal(new Set(all).size, all.length, 'no duplicates across pages');
    assert.ok(all.every((i) => isFeature(i) && i >= 10));
  });

  await t.test('genre filter checks candidates, then offers "Check more films"', async () => {
    await ui.pick('genre', 'Horror');
    assert.equal(ui.menuLabel('genre'), 'Horror');
    const more = ui.$('[data-lfr="check-more"]');
    if (more) { more.click(); await ui.settle(); }
    const all = await ui.all();
    assert.equal(all.length, candidates.filter((i) => isFeature(i) && film(i).genres.includes('Horror')).length);
    assert.ok(all.every((i) => film(i).genres.includes('Horror')));
    assert.equal(ui.stats.filmFetches, candidates.length, 'every candidate fetched exactly once');
  });

  await t.test('genre + language', async () => {
    await ui.pick('language', 'fr');
    const all = await ui.all();
    assert.equal(all.length, candidates.filter((i) => isFeature(i) && film(i).genres.includes('Horror') && film(i).langs.includes('fr')).length);
  });

  await t.test('language + decade', async () => {
    await ui.pick('genre', ''); // "Any genre"
    await ui.pick('decade', '2000');
    assert.equal(ui.menuLabel('decade'), '2000s');
    const all = await ui.all();
    const expected = candidates.filter((i) => isFeature(i) && film(i).langs.includes('fr') && film(i).year >= 2000 && film(i).year <= 2009);
    assert.deepEqual([...all].sort((a, b) => a - b), expected);
  });

  await t.test('clicking a genre twice excludes it', async () => {
    await ui.pick('genre', 'Drama');
    await ui.pick('genre', 'Drama');
    assert.equal(ui.menuLabel('genre'), 'Not Drama');
    const all = await ui.all();
    assert.ok(all.length > 0);
    assert.ok(all.every((i) => !film(i).genres.includes('Drama')));
  });

  await t.test('"Other" menu: include series and shorts', async () => {
    await ui.pick('genre', '');
    await ui.pick('decade', '');
    await ui.pick('language', '');
    await ui.pick('other', 'kind:all');
    await ui.pick('other', 'shorts');
    const all = await ui.all();
    assert.equal(all.length, candidates.length);
  });

  await t.test('sort menu', async () => {
    await ui.pick('sort', 'watched');
    assert.equal(ui.menuLabel('sort'), 'Most watched by friends');
    assert.equal(ui.slugs().length, 50);
  });

  await t.test('clear filters resets filters but keeps view options', async () => {
    await ui.pick('other', 'kind:movie');
    await ui.pick('other', 'shorts');
    await ui.pick('genre', 'Horror');
    const clear = ui.$$('.lfr-page aside a').find((a) => a.textContent === 'Clear filters');
    assert.ok(!clear.parentElement.classList.contains('lfr-hidden'), '"Clear filters" shows when filters are set');
    clear.click();
    await ui.settle();
    assert.equal(ui.menuLabel('genre'), 'Genre');
    assert.ok(clear.parentElement.classList.contains('lfr-hidden'));
    assert.equal((await ui.all()).length, candidates.filter(isFeature).length);
  });

  await t.test('leaving the route restores the watchlist', async () => {
    ui.window.location.hash = '';
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ui.$('.lfr-page'), null);
    assert.ok(!ui.$('.js-watchlist-content').classList.contains('lfr-hidden'));
    assert.ok(ui.$('.js-page-watchlist').classList.contains('-active'));
  });
});
