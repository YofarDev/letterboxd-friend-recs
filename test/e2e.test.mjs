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

async function setup() {
  const idb = new IDBFactory();
  await seed(idb);
  const dom = new JSDOM('<!doctype html><html><head></head><body><header></header></body></html>',
    { url: 'https://letterboxd.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const stats = { filmFetches: 0 };
  window.indexedDB = idb;
  window.IDBKeyRange = IDBKeyRange;
  window.person = { loggedIn: true, username: 'me' };
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
    // Wait until the status line stops saying it's fetching/checking and stays the same.
    async settle() {
      let last = '', stable = 0;
      for (let i = 0; i < 600; i++) {
        await sleep(50);
        const s = $('.lfr .status')?.textContent || '';
        if (!/^(Fetching|Checking)/.test(s) && s === last) { if (++stable >= 6) return s; } else stable = 0;
        last = s;
      }
      throw new Error(`results page never settled; last status: ${last}`);
    },
    // Text of each card's meta lines, e.g. "1968 · 100 min · Someone | Drama · USA".
    cards: () => $$('.lfr .card').map((c) => [...c.querySelectorAll('.meta')].map((m) => m.textContent).join(' | ')),
    gridButtons: () => $$('.lfr .grid button').map((b) => b.textContent),
    setCtrl(label, value) {
      const l = $$('.lfr label').find((x) => x.firstChild?.textContent === label);
      assert.ok(l, `control "${label}" exists`);
      const input = l.querySelector('select, input');
      input.value = value;
      input.dispatchEvent(new window.Event('change'));
    },
    async showAll() {
      for (let i = 0; i < 20; i++) {
        const more = $$('.lfr .grid button').find((b) => b.textContent === 'Show more');
        if (!more) return;
        more.click();
        await ui.settle();
      }
    },
  };
  return ui;
}

test('results page end to end', async (t) => {
  const ui = await setup();
  assert.ok(ui.$('.lfr-btn'), 'button is mounted once the signed-in user is known');
  ui.$('.lfr-btn').click();
  await ui.settle();

  await t.test('default: films only, no shorts, no watched films', async () => {
    assert.equal(ui.cards().length, 60, 'first page is full');
    await ui.showAll();
    const c = ui.cards();
    assert.equal(c.length, candidates.filter(isFeature).length);
    assert.equal(c.filter((m) => /Series|\b20 min/.test(m)).length, 0);
  });

  await t.test('genre filter scans candidates, then offers "Check more"', async () => {
    ui.setCtrl('Genre', 'Horror');
    await ui.settle();
    const expected = candidates.filter((i) => isFeature(i) && film(i).genres.includes('Horror')).length;
    // First run checks at most 300 films, so it may stop short and offer a button.
    const check = ui.$$('.lfr .grid button').find((b) => /^Check \d+ more films/.test(b.textContent));
    if (check) { check.click(); await ui.settle(); }
    const c = ui.cards();
    assert.equal(c.length, expected);
    assert.ok(c.every((m) => /Horror/.test(m)));
    assert.equal(ui.stats.filmFetches, candidates.length, 'every candidate fetched exactly once');
  });

  await t.test('genre + language', async () => {
    ui.setCtrl('Language', 'French');
    await ui.settle();
    const expected = candidates.filter((i) => isFeature(i) && film(i).genres.includes('Horror') && film(i).langs.includes('fr')).length;
    const c = ui.cards();
    assert.equal(c.length, expected);
    assert.ok(c.every((m) => /Horror/.test(m) && /France/.test(m)));
  });

  await t.test('language + year range', async () => {
    ui.setCtrl('Genre', '');
    ui.setCtrl('Year from', '2000');
    ui.setCtrl('Year to', '2009');
    await ui.settle();
    const inRange = (i) => film(i).year >= 2000 && film(i).year <= 2009;
    const expected = candidates.filter((i) => isFeature(i) && film(i).langs.includes('fr') && inRange(i)).length;
    const c = ui.cards();
    assert.equal(c.length, expected);
    const years = c.map((m) => +m.match(/\b(19|20)\d\d\b/)[0]);
    assert.ok(years.every((y) => y >= 2000 && y <= 2009));
  });

  await t.test('exclude genre', async () => {
    ui.setCtrl('Exclude genre', 'Drama');
    await ui.settle();
    const c = ui.cards();
    assert.ok(c.length > 0);
    assert.ok(c.every((m) => !/Drama/.test(m)));
  });

  await t.test('"Most watched" sort keeps all filters', async () => {
    ui.setCtrl('Sort', 'watched');
    await ui.settle();
    assert.ok(ui.cards().every((m) => !/Drama/.test(m)));
    assert.match(ui.$('.lfr .card .score').textContent, /watched/);
  });

  await t.test('clear filters', async () => {
    ui.$$('.lfr button').find((b) => b.textContent === 'Clear filters').click();
    await ui.settle();
    await ui.showAll();
    assert.equal(ui.cards().length, candidates.filter(isFeature).length);
  });
});
