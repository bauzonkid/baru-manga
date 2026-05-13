/**
 * Plugin template — copy this file when adding a new site adapter.
 *
 * SETUP:
 *   1. Copy this file to:
 *        Dev:     app/electron/plugins/{your-site-id}.cjs
 *        Packaged: %APPDATA%/Baru-Manga/plugins/{your-site-id}.cjs
 *   2. Rename the file (lowercase, no spaces). Drop the `_` prefix and the
 *      `.example` segment — only `.cjs` files NOT starting with `_` and NOT
 *      ending with `.example.cjs` are loaded.
 *   3. Replace `id` and `name` below.
 *   4. Implement the 5 functions: parseUrl, getManga, getChapters, getPages,
 *      getChapter. Reference `mangadex.cjs` and `universal.cjs` for working
 *      examples.
 *   5. Restart the app. Plugin loads automatically.
 *
 * IPC FLOW:
 *   - User pastes URL → main.cjs iterates plugins in load order, calling
 *     each plugin's `parseUrl(url)`. First non-null wins.
 *   - For a manga URL: main.cjs calls plugin.getManga(id) + plugin.getChapters(id).
 *   - For a chapter URL: main.cjs calls plugin.getChapter(id), then
 *     plugin.getPages(id) when the renderer requests images.
 *
 * ORDER OF LOADING:
 *   - Built-in plugins (app/electron/plugins/*.cjs) load first.
 *   - User plugins (%APPDATA%/Baru-Manga/plugins/*.cjs) load second and
 *     OVERRIDE built-in if `id` matches.
 *   - Iteration during parseUrl matching is alphabetical, so file naming
 *     affects priority: `aaa.cjs` is tried before `mangadex.cjs`.
 *   - Universal plugin is tried LAST as a fallback.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`)
  return res.text()
}

// ────────────────────────────────────────────────────────────────────────
// 1) parseUrl — decide if THIS plugin handles the URL.
//    Return null to let other plugins try. Return:
//      { kind: 'manga',   id: '<manga-id-or-url>' } for a manga overview page,
//      { kind: 'chapter', id: '<chapter-id-or-url>' } for a single chapter URL.
// ────────────────────────────────────────────────────────────────────────
function parseUrl(url) {
  if (!url) return null
  // Example: only handle URLs on YOUR site.
  // if (!/^https?:\/\/(www\.)?example\.com\//i.test(url)) return null

  // Example: distinguish manga vs chapter by URL pattern.
  // if (/\/chapter\//.test(url)) return { kind: 'chapter', id: url }
  // return { kind: 'manga', id: url }

  return null
}

// ────────────────────────────────────────────────────────────────────────
// 2) getManga(id) — return metadata for a manga.
//    Shape: { id, title, cover?, description?, tags?, status?, ... }
// ────────────────────────────────────────────────────────────────────────
async function getManga(id) {
  const html = await fetchHtml(id)
  // Extract title, cover URL, description from HTML.
  // const title = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] || ''
  // const cover = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1] || null
  return {
    id,
    title: 'Replace me',
    cover: null,
    description: ''
  }
}

// ────────────────────────────────────────────────────────────────────────
// 3) getChapters(mangaId, opts) — return Chapter[].
//    Each chapter: { id, number, title?, language, pageCount? }
// ────────────────────────────────────────────────────────────────────────
async function getChapters(mangaId /*, opts */) {
  const html = await fetchHtml(mangaId)
  // Scan <a href> for chapter links, extract chapter number from URL/text.
  const out = []
  // ... your scraping logic ...
  return out
}

// ────────────────────────────────────────────────────────────────────────
// 4) getPages(chapterId) — return Page[] for a chapter.
//    Each page: { url, index } — image URLs in reading order.
// ────────────────────────────────────────────────────────────────────────
async function getPages(chapterId) {
  const html = await fetchHtml(chapterId)
  const out = []
  // ... extract <img src> URLs (often look for `.jpg`/`.webp` in the right CDN host) ...
  return out
}

// ────────────────────────────────────────────────────────────────────────
// 5) getChapter(chapterUrl) — light version of getPages. Returns
//    { chapter: { id, number, title, language, pageCount }, mangaId }.
//    Called when user pastes a CHAPTER URL directly.
// ────────────────────────────────────────────────────────────────────────
async function getChapter(chapterUrl) {
  return {
    chapter: {
      id: chapterUrl,
      number: '?',
      title: undefined,
      language: 'unknown',
      pageCount: 0
    },
    mangaId: null
  }
}

async function search(_query) {
  // Optional: return [] if site has no search API.
  return []
}

module.exports = {
  id: 'example',            // unique plugin id — same id from user folder overrides built-in
  name: 'Example site',     // shown in UI
  capabilities: {
    search: false,          // true if `search()` works
    openLocal: false        // true only for local folder plugin
  },
  parseUrl,
  getManga,
  getChapters,
  getPages,
  getChapter,
  search
}
