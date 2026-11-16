# Letterboxd Friend Recs

A userscript that recommends films you haven't seen, based on what **the people you follow on Letterboxd** have watched and rated.

It runs entirely in your browser, on letterboxd.com, while you're signed in. There's no server, no API key and no account to create: it reads the same pages you would, stores what it learns in your browser (IndexedDB), and only re-reads what changed on later syncs.

> Unofficial. Not affiliated with or endorsed by Letterboxd. See [Be gentle](#be-gentle) below.

## Features

- A **Recs** tab in your profile, next to Watchlist, that looks and works like a regular Letterboxd page. "Friend recs" also appears in the account menu.
- Sort by **Recommended** (films your follows rated well, weighted by how closely their taste matches yours, how many of them watched it, and the Letterboxd average), **Most watched by friends**, or **Friends' rating**.
- Letterboxd-style filters: **Decade**, **Genre** (include or exclude several), **Country**, **Language**, and **Other** (films / series, hide shorts, include / hide / only your watchlist, minimum number of friends who watched it).
- Films you've already watched are always excluded. Films on your watchlist are marked with a blue dot.
- Under each poster: your friends' average rating and how many of them watched it. Hover a poster for who watched it and what they rated it.
- Optional **Tune recommendations** panel in the sidebar, with sliders for the scoring weights. All settings are remembered.

## Install

1. Install a userscript manager:
   - Chrome / Edge / Brave: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/). In Chrome, Tampermonkey also needs **Allow User Scripts** turned on in `chrome://extensions` → Tampermonkey → Details (or **Developer mode** on older Chrome).
   - Firefox and forks (Zen, LibreWolf…): Tampermonkey or Violentmonkey.
2. **[Install the script](https://raw.githubusercontent.com/YofarDev/letterboxd-friend-recs/main/letterboxd-friend-recs.user.js)**: your userscript manager opens an install page. Updates are picked up automatically. (Or create a new script and paste [the file](letterboxd-friend-recs.user.js) in.)
3. Sign in to [letterboxd.com](https://letterboxd.com) and open your profile. A **Recs** tab appears after Watchlist (the page lives at `letterboxd.com/<you>/watchlist/#friend-recs`).
4. Click **Sync now** once. The first sync takes a few minutes. After that, the page syncs in the background whenever the last sync is more than 12 hours old, or when you click **Sync friends' films** in the sidebar.

## How it works

### Syncing

| Data | Page read |
|---|---|
| People you follow, and how many films each has watched | `/<you>/following/` |
| Your films, ratings and likes | `/<you>/films/` |
| Your watchlist | `/<you>/watchlist/` |
| Each follow's films, ratings and likes | `/<user>/films/` (72 films per page) |
| Global rating, length, genres, countries, languages, film or series | `/film/<slug>/` (only for films about to be shown) |

**First sync** reads every film page of everyone you follow. About 750 pages for 50,000 films, a few minutes.

**Later syncs** only fetch what changed:

- If a follow's watched count hasn't changed, only their most recently rated films are checked, at most every 6 hours.
- Reading newest-first lists (`by/date/`, `by/rated-date/`) stops at the first film already stored.
- Each follow is fully re-read every 30 days (at most 2 per sync), to catch deleted ratings.
- People you unfollowed are dropped.

A typical re-sync is a few dozen requests.

**Film details** (global rating, length, genres…) are fetched one page per film, only for films on screen or being checked against a filter. Genre, year, country and language never change, so they're kept for good. The global rating is refreshed after 30 days. Requests made by the results page skip ahead of a running sync.

### Scoring

For each film you haven't watched:

1. **Adjust for how each friend rates.** Some people give everything 4★, others are harsh. Each rating is re-expressed relative to that friend's own average and spread, then mapped back onto the common star scale:
   `r' = μ_all + (r − μ_friend) / σ_friend × σ_all`
   If the friend also liked the film, a small **like bonus** is added.
2. **Taste matching.** Each friend's weight depends on how well their ratings correlate with yours on films you both rated (Pearson correlation, shrunk toward 0 when you share few films):
   `w = clamp(1 + taste × ρ × n/(n+10), 0.1, 2)`
3. **Blend with the global rating** (Bayesian average). With one friend's rating the result stays close to the global Letterboxd rating; with many, friends dominate:
   `friendScore = (Σ w·r' + k·G) / (Σ w + k)`
4. **Bonus for how many follows watched it**, rated or not:
   `score = friendScore + β·ln(1 + n_watched)`

`taste`, `k`, `β` and the like bonus are the sliders under **Tune recommendations**.

### Filters

Decade is known for every film from the synced data, so that filter is instant. Length, film/series, genre, country and language come from each film's page:

- **Length / type**: films whose details aren't loaded yet are shown until their details arrive. Most films pass, so this stays fast.
- **Genre / country / language**: only films already checked are shown. When the page isn't full, the script checks the next best-ranked candidates (about 3 per second, with a live count), up to 300 per filter change, and then offers **Check more films**. Checked films are remembered, so the same filter is fast next time.

Pages you've already paged past keep their order, so moving between pages never repeats or skips a film while new details re-rank the rest.

## Privacy

- Everything stays in your browser: IndexedDB (`lbxFriendRecs`) and `localStorage` for your filters and settings.
- The script only talks to `letterboxd.com`, and posters load from Letterboxd's own image CDN. Nothing is sent anywhere else.
- To delete everything: browser devtools → Application/Storage → IndexedDB → `lbxFriendRecs` → Delete.

## Be gentle

This reads Letterboxd's pages the way your browser does, with your session. Letterboxd's terms don't allow automated scraping, so keep it low-volume:

- Requests go one or two at a time, with a pause between them (`minGapMs`).
- Requests back off and retry on errors and rate limits (HTTP 429).
- After the first sync, it only fetches what changed.

Please don't lower the delays or run it in loops. Use it at your own risk.

## Development

```bash
npm install
npm test        # end-to-end test in jsdom against a fake Letterboxd
npm run lint
```

The test loads the real userscript into a simulated Letterboxd watchlist page with fake follows and films. It checks the Recs tab and account-menu entry, pagination with no repeats, the dropdown filters (genre include/exclude, language, decade, other), the "Check more films" scan, sorting, Clear filters, and leaving the page.

The page is built from Letterboxd's own CSS classes (`section-heading`, `sorting-selects` / `smenu-menu`, `poster-grid`, `pagination`, `actions-panel`), so it follows the site's styles. Settings that aren't on the page live in the `CFG` object at the top of the script.

### Known limits

- Ratings are read from the poster grids. A rating removed without any other change is only noticed at that follow's next 30-day full refresh.
- Letterboxd only has miniseries and limited series, which TMDB lists as TV, not regular TV shows. "Series" means those.
- No "where to watch" filter yet. It would need one more request per film.

## License

[MIT](LICENSE)
