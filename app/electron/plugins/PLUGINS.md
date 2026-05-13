# Baru-Manga Plugins

Each site adapter is a single `.cjs` file in this folder. The Electron main
process scans both:

- **Built-in:** `app/electron/plugins/*.cjs` — ships inside the app
- **User:**     `%APPDATA%/Baru-Manga/plugins/*.cjs` — your overrides + custom adapters

User plugins override built-in plugins when their `id` field matches.

Files starting with `_` (e.g. `_template.example.cjs`) and files ending with
`.example.cjs` are **ignored** by the loader — use this pattern for templates
and disabled drafts.

---

## Quick start: add a new site

1. Copy `_template.example.cjs` from this folder to:
   ```
   %APPDATA%/Baru-Manga/plugins/{your-site-id}.cjs
   ```
2. Edit the 5 functions inside (`parseUrl`, `getManga`, `getChapters`,
   `getPages`, `getChapter`).
3. Restart the app. Loader picks it up automatically.

The Studio header has a **📁 Plugins** button that opens the user folder.

---

## When you DON'T need a plugin

The universal scraper handles most VN/EN sites out of the box via two layers:

1. **HTML heuristic** — regex `<a href>` for `chuong-N`, `chapter-N`, `chap-N`,
   `episode-N`, `ep-N` patterns. Works for nettruyen, blogtruyen, mangakakalot,
   manhuaplus, and most WordPress / MangaCMS clones.

2. **AI fallback** — when heuristic returns 0 chapters, the HTML is sent to
   Gemini Flash via 9router and a chapter list is extracted. Costs ~1 AI call
   per "open manga URL" on unknown sites.

A dedicated plugin only beats universal when:

- The site is **SPA / JS-rendered** (chapter list injected client-side; raw
  HTML is empty). Plugin can call the site's hidden JSON API.
- The site has **bot protection** (Cloudflare, recaptcha) that the universal
  fetch can't bypass. Plugin can hit a known-stable API endpoint.
- The site has **unusual URL patterns** that the heuristic misses (e.g. only
  numeric IDs `/123/456` with no chapter word).

---

## Plugin shape

```js
module.exports = {
  id: 'unique-id',           // string — used by user folder to override built-in
  name: 'Friendly name',     // shown in UI
  capabilities: {
    search: false,           // true if search(query) returns useful results
    openLocal: false         // true only for local folder plugin
  },
  parseUrl(url),             // → null | { kind: 'manga' | 'chapter', id: string }
  getManga(id),              // → MangaResult
  getChapters(mangaId, opts),// → Chapter[]
  getPages(chapterId),       // → Page[]
  getChapter(chapterUrl),    // → { chapter: Chapter, mangaId: string | null }
  search(query)              // → MangaResult[]
}
```

Type definitions live in `app/src/types/plugin.ts`. The IPC layer in
`app/electron/main.cjs` is the canonical source for the call contract.

---

## Calling the AI helper

If your plugin wants AI assistance (e.g. parse a tricky page):

```js
const { scrapeChaptersFromHtml } = require('../ai/scrape.cjs')
const list = await scrapeChaptersFromHtml(rawHtml, baseUrl)
```

The router config (`ai/router.cjs`) reads `NINEROUTER_BASE`,
`NINEROUTER_API_KEY` env vars — same as the rest of the app.

---

## Debugging

- Plugin errors print to the Electron main process console. Run via
  `Baru-Manga.bat` to see them.
- Wrap your scraping logic with `try/catch` and `console.error` — a thrown
  error in one plugin doesn't kill the rest.
- Test scraping logic standalone with `node -e "..."` before launching
  Electron. Example:
  ```
  node -e "require('./your-site.cjs').getChapters('https://...').then(console.log)"
  ```

---

## Existing plugins

| File | Site | Notes |
|------|------|-------|
| `mangadex.cjs` | mangadex.org | Uses official API. Multi-language chapter support. |
| `universal.cjs` | Anything else | Heuristic scraper + AI fallback. Most VN/EN sites work. |
| `local.cjs` | Local folder | Disk-based — pick a folder of images as a chapter. |

Built-ins are tried in alphabetical order during `parseUrl` matching; universal
is the last fallback because it accepts almost any URL.
