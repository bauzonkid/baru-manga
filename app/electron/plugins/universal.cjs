/**
 * Universal scraper plugin — paste ANY manga or chapter URL from ANY site.
 * Best-effort HTML heuristic, no per-site adapter.
 *
 * Behavior:
 *  - URL with chapter pattern (/chuong-N, /chapter-N, /chap-N, /ep-N, etc)
 *    → treated as chapter; extract images.
 *  - Other URL → treated as manga page; scrape title/cover/description from
 *    meta tags, enumerate chapter list by scanning <a> hrefs for chapter
 *    pattern matches on the same host.
 *
 * Limitations:
 *  - JS-rendered SPA pages (where chapter list / images are injected
 *    client-side) may return 0 chapters or 0 pages. For those sites, add
 *    a dedicated plugin.
 *  - Image order is the order they appear in the raw HTML.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

function defaultHeaders(url) {
  let referer = ''
  try { referer = new URL(url).origin + '/' } catch { /* ignore */ }
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi,en;q=0.8',
    'Referer': referer
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: defaultHeaders(url), redirect: 'follow' })
  if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`)
  return res.text()
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

function pickMeta(html, prop) {
  const re = new RegExp(`<meta\\s+(?:property|name)=["']${prop}["']\\s+content=["']([^"']+)["']`, 'i')
  const m = html.match(re)
  return m ? decodeHtmlEntities(m[1]).trim() : undefined
}

function pickTitle(html) {
  return pickMeta(html, 'og:title')
    || pickMeta(html, 'twitter:title')
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    || ''
}

function extractChapterNumber(url, title) {
  // Try URL slug: /chuong-12, /chap-12, /chapter/12, /ch-12, /c-12
  const fromUrl = url.match(/\/(?:chuong|chap(?:ter)?|ch|c|episode|ep)[-_/]?(\d+(?:\.\d+)?)/i)
  if (fromUrl) return fromUrl[1]
  // Try title: "Chapter 12", "Chap 12", "Chương 12"
  const fromTitle = title?.match(/(?:chuong|chương|chap(?:ter)?|episode|ep)[\s-]?(\d+(?:\.\d+)?)/i)
  if (fromTitle) return fromTitle[1]
  return '?'
}

const REJECT_PATH = /\/(logo|icon|avatar|ad[s]?|banner|sprite|emoji|favicon|placeholder|loading|spinner|button|btn|share|social|nav|menu|footer|header|sidebar)\b/i
const REJECT_FILENAME = /(logo|favicon|sprite|emoji|placeholder|loading|spinner)\.(jpe?g|png|webp|gif|svg)/i
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)(\?|#|$)/i

function absolutize(src, baseUrl) {
  if (!src) return null
  src = src.trim()
  if (src.startsWith('data:')) return null
  if (src.startsWith('//')) return new URL(baseUrl).protocol + src
  if (src.startsWith('/')) return new URL(baseUrl).origin + src
  if (/^https?:\/\//i.test(src)) return src
  try { return new URL(src, baseUrl).href } catch { return null }
}

// Pick the largest URL out of a srcset string like
//   "small.jpg 1x, medium.jpg 2x, large.jpg 3x"
// or
//   "thumb.jpg 320w, medium.jpg 640w, large.jpg 1280w"
// Falls back to the last URL (typically highest density) if descriptors
// are missing.
function pickLargestFromSrcset(srcset) {
  const entries = String(srcset).split(',').map(s => s.trim()).filter(Boolean)
  if (entries.length === 0) return ''
  let bestUrl = ''
  let bestWeight = -1
  for (const e of entries) {
    const [url, descriptor] = e.split(/\s+/)
    if (!url) continue
    const w = parseFloat(descriptor) || 1
    if (w > bestWeight) {
      bestUrl = url
      bestWeight = w
    }
  }
  return bestUrl || entries[entries.length - 1].split(/\s+/)[0]
}

function extractImages(html, baseUrl) {
  const out = []
  const seen = new Set()
  // Pull out src + lazy variants from every <img> tag, in DOM order.
  const re = /<img\b([^>]*)>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1]
    const srcAttrs = ['data-original', 'data-src', 'data-lazy-src', 'data-cdn', 'data-srcset', 'srcset', 'src']
    let chosen = null
    for (const a of srcAttrs) {
      const am = attrs.match(new RegExp(`\\b${a}=["']([^"']+)["']`, 'i'))
      if (am) {
        const raw = am[1]
        if (a === 'srcset' || a === 'data-srcset') {
          // Multiple sizes — pick the LARGEST for highest quality. Previous
          // code took the first which was usually the smallest thumbnail
          // → downloaded panels looked tiny / cropped at render time.
          chosen = pickLargestFromSrcset(raw)
        } else {
          chosen = raw.split(',')[0].trim().split(/\s+/)[0]
        }
        break
      }
    }
    if (!chosen) continue
    const abs = absolutize(chosen, baseUrl)
    if (!abs) continue
    if (!IMG_EXT.test(abs)) continue
    if (REJECT_PATH.test(abs)) continue
    const filename = abs.split('?')[0].split('/').pop() || ''
    if (REJECT_FILENAME.test(filename)) continue
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push({ url: abs, index: out.length, _tag: m[0] })
  }
  return out
}

function rankChapterImages(images) {
  if (images.length < 3) return images
  // Strategy: chapter readers tend to host all panel images on ONE CDN host with
  // consistent path prefix. Find the host with the most images and keep those.
  const byHost = new Map()
  for (const img of images) {
    try {
      const h = new URL(img.url).host
      byHost.set(h, (byHost.get(h) || 0) + 1)
    } catch { /* ignore */ }
  }
  if (byHost.size === 0) return images
  // Pick host with most images, but require at least 3 to consider it a chapter host.
  const sortedHosts = [...byHost.entries()].sort((a, b) => b[1] - a[1])
  const [topHost, topCount] = sortedHosts[0]
  if (topCount < 3) return images
  const dominant = images.filter(img => {
    try { return new URL(img.url).host === topHost } catch { return false }
  })
  return dominant.map((img, i) => ({ url: img.url, index: i }))
}

async function getPages(url) {
  const html = await fetchHtml(url)
  const all = extractImages(html, url)
  return rankChapterImages(all)
}

async function getChapter(url) {
  const html = await fetchHtml(url)
  const title = pickTitle(html)
  // Image count without re-fetching:
  const pageCount = rankChapterImages(extractImages(html, url)).length
  return {
    chapter: {
      id: url,
      number: extractChapterNumber(url, title),
      title: title || undefined,
      language: 'unknown',
      pageCount
    },
    mangaId: null
  }
}

// ── Manga page scraping ─────────────────────────────────────────────────
// Heuristic: scan <a href> for chapter links on the same host with chapter
// pattern in the URL. Works for nettruyen, blogtruyen, mangakakalot, etc.

// Pattern to detect chapter URLs. Covers:
//   /chuong-12, /chuong/12, /chuong_12       (Vietnamese, path segment)
//   /slug-chuong-12                          (Vietnamese, blogtruyen-style)
//   /chap-12, /chapter-12, /chapter/12       (English)
//   /episode-12, /ep-12                      (Alt)
//   Number can be int or float (12.5 or 12-5).
// Leading char must be `/`, `-`, or `_` so we don't match arbitrary
// substrings (e.g. don't match "chuongminh" in /tac-gia/chuongminh).
const CHAPTER_URL_RE = /[\/\-_](?:chuong|chương|chap(?:ter)?|episode|ep)[\/\-_](\d+(?:[.-]\d+)?)/i

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function isChapterPath(url) {
  try {
    const u = new URL(url)
    return CHAPTER_URL_RE.test(u.pathname)
  } catch { return false }
}

function pickCover(html, baseUrl) {
  const og = pickMeta(html, 'og:image') || pickMeta(html, 'twitter:image')
  if (og) return absolutize(og, baseUrl)
  return null
}

function pickDescription(html) {
  return pickMeta(html, 'og:description') || pickMeta(html, 'description') || ''
}

function extractChapterLinks(html, baseUrl) {
  let baseHost = ''
  try { baseHost = new URL(baseUrl).host } catch {}
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const href = m[1]
    if (!CHAPTER_URL_RE.test(href)) continue
    const abs = absolutize(href, baseUrl)
    if (!abs) continue
    // Same-host only — avoid cross-site noise (related-manga widgets, ads)
    try {
      if (baseHost && new URL(abs).host !== baseHost) continue
    } catch { continue }
    if (seen.has(abs)) continue
    seen.add(abs)
    const text = stripTags(m[2])
    // Number from URL first (more reliable), fallback to anchor text
    const fromUrl = abs.match(CHAPTER_URL_RE)?.[1]
    const fromText = text.match(/(\d+(?:[.-]\d+)?)/)?.[1]
    const num = (fromUrl || fromText || '?').replace(/-/g, '.')
    out.push({
      id: abs,
      number: num,
      title: text || undefined,
      language: 'unknown',
      pageCount: undefined,
      _numKey: parseFloat(num) || 0
    })
  }
  // Sort ascending by chapter number
  out.sort((a, b) => a._numKey - b._numKey)
  return out.map(({ _numKey, ...rest }) => rest)
}

async function getManga(url) {
  const html = await fetchHtml(url)
  const title = pickTitle(html) || url
  const cover = pickCover(html, url)
  const description = pickDescription(html)
  const result = { id: url, title, tags: ['universal'] }
  if (cover) result.cover = cover
  if (description) result.description = description
  return result
}

async function getChapters(mangaId /* = manga URL */) {
  const html = await fetchHtml(mangaId)
  const heuristic = extractChapterLinks(html, mangaId)
  if (heuristic.length > 0) return heuristic
  // Heuristic miss — site uses unusual markup. Fall back to AI scrape.
  // This costs 1 AI call but works on sites the regex can't read.
  try {
    const aiScrape = require('../ai/scrape.cjs')
    const aiList = await aiScrape.scrapeChaptersFromHtml(html, mangaId)
    return aiList
  } catch (e) {
    console.warn(`Universal AI scrape fallback failed for ${mangaId}: ${e.message}`)
    return []
  }
}

async function search() { return [] }

function parseUrl(url) {
  if (!url) return null
  const u = url.trim()
  if (!/^https?:\/\//i.test(u)) return null
  // Specific plugins (mangadex) win because they're tried first via the
  // iteration order in main.cjs. Universal accepts everything else and
  // distinguishes manga vs chapter by URL pattern.
  if (isChapterPath(u)) return { kind: 'chapter', id: u }
  return { kind: 'manga', id: u }
}

module.exports = {
  id: 'universal',
  name: 'Universal (paste link)',
  capabilities: { search: false, openLocal: false },
  search,
  getManga,
  getChapters,
  getPages,
  getChapter,
  parseUrl
}
