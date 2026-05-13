/**
 * MangaDex plugin — public REST API, no auth needed.
 * https://api.mangadex.org/docs/
 */
const API = 'https://api.mangadex.org'
const UPLOADS = 'https://uploads.mangadex.org'

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': 'manga-recap-studio/0.1', ...(opts.headers || {}) }
  })
  if (!res.ok) {
    throw new Error(`MangaDex ${res.status}: ${url}`)
  }
  return res.json()
}

function pickTitle(titles, altTitles = []) {
  if (!titles) return ''
  return (
    titles.en ||
    titles['ja-ro'] ||
    titles.ja ||
    titles['zh-hk'] ||
    titles.zh ||
    titles.ko ||
    titles.vi ||
    Object.values(titles)[0] ||
    altTitles[0]?.en ||
    'Untitled'
  )
}

function mapManga(item) {
  const attrs = item.attributes || {}
  const coverRel = (item.relationships || []).find(r => r.type === 'cover_art')
  const authorRels = (item.relationships || []).filter(r => r.type === 'author')
  const artistRels = (item.relationships || []).filter(r => r.type === 'artist')
  let cover
  if (coverRel?.attributes?.fileName) {
    cover = `${UPLOADS}/covers/${item.id}/${coverRel.attributes.fileName}.512.jpg`
  }
  return {
    id: item.id,
    title: pickTitle(attrs.title, attrs.altTitles),
    cover,
    description: attrs.description?.en || attrs.description?.['zh-hk'] || Object.values(attrs.description || {})[0] || '',
    tags: (attrs.tags || []).map(t => t.attributes?.name?.en).filter(Boolean),
    status: attrs.status,
    contentRating: attrs.contentRating,
    authors: authorRels.map(r => r.attributes?.name).filter(Boolean),
    artists: artistRels.map(r => r.attributes?.name).filter(Boolean),
    altTitles: (attrs.altTitles || []).map(t => Object.values(t)[0]).filter(Boolean)
  }
}

async function search(query, opts = {}) {
  const limit = opts.limit ?? 20
  const params = new URLSearchParams({
    title: query,
    limit: String(limit),
    'includes[]': 'cover_art',
    'order[relevance]': 'desc'
  })
  for (const r of ['safe', 'suggestive', 'erotica']) {
    params.append('contentRating[]', r)
  }
  const data = await fetchJSON(`${API}/manga?${params}`)
  return (data.data || []).map(mapManga)
}

async function getManga(id) {
  const params = new URLSearchParams()
  for (const inc of ['cover_art', 'author', 'artist']) params.append('includes[]', inc)
  const data = await fetchJSON(`${API}/manga/${id}?${params}`)
  return mapManga(data.data)
}

async function getChapters(mangaId, opts = {}) {
  const all = []
  let offset = 0
  const limit = 500
  const lang = opts.lang
  while (true) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      'order[chapter]': 'asc',
      'order[volume]': 'asc',
      'includes[]': 'scanlation_group'
    })
    if (lang) params.append('translatedLanguage[]', lang)
    const data = await fetchJSON(`${API}/manga/${mangaId}/feed?${params}`)
    const batch = data.data || []
    for (const item of batch) {
      const a = item.attributes || {}
      const groupRel = (item.relationships || []).find(r => r.type === 'scanlation_group')
      all.push({
        id: item.id,
        number: a.chapter || '?',
        title: a.title || undefined,
        language: a.translatedLanguage || 'unknown',
        pageCount: a.pages,
        publishedAt: a.publishAt,
        scanlationGroup: groupRel?.attributes?.name
      })
    }
    if (batch.length < limit) break
    offset += limit
    if (offset > 5000) break
  }
  return all
}

async function getPages(chapterId) {
  const data = await fetchJSON(`${API}/at-home/server/${chapterId}`)
  const baseUrl = data.baseUrl
  const hash = data.chapter?.hash
  const filenames = data.chapter?.data || []
  return filenames.map((fn, i) => ({
    url: `${baseUrl}/data/${hash}/${fn}`,
    index: i
  }))
}

// Fetch a single chapter's metadata + parent manga id.
async function getChapter(chapterId) {
  const params = new URLSearchParams()
  params.append('includes[]', 'manga')
  params.append('includes[]', 'scanlation_group')
  const data = await fetchJSON(`${API}/chapter/${chapterId}?${params}`)
  const item = data.data || {}
  const a = item.attributes || {}
  const mangaRel = (item.relationships || []).find(r => r.type === 'manga')
  const groupRel = (item.relationships || []).find(r => r.type === 'scanlation_group')
  return {
    chapter: {
      id: chapterId,
      number: a.chapter || '?',
      title: a.title || undefined,
      language: a.translatedLanguage || 'unknown',
      pageCount: a.pages,
      publishedAt: a.publishAt,
      scanlationGroup: groupRel?.attributes?.name
    },
    mangaId: mangaRel?.id
  }
}

// Parse a MangaDex URL into a routable target.
//   https://mangadex.org/title/{uuid}                     → manga
//   https://mangadex.org/title/{uuid}/{slug}              → manga
//   https://mangadex.org/chapter/{uuid}                   → chapter
//   https://mangadex.org/chapter/{uuid}/{page}            → chapter
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
function parseUrl(url) {
  if (!url) return null
  const u = url.trim()
  let m = u.match(new RegExp(`mangadex\\.org/chapter/(${UUID_RE})`, 'i'))
  if (m) return { kind: 'chapter', id: m[1].toLowerCase() }
  m = u.match(new RegExp(`mangadex\\.org/title/(${UUID_RE})`, 'i'))
  if (m) return { kind: 'manga', id: m[1].toLowerCase() }
  return null
}

module.exports = {
  id: 'mangadex',
  name: 'MangaDex',
  capabilities: { search: true, openLocal: false },
  search,
  getManga,
  getChapters,
  getPages,
  getChapter,
  parseUrl
}
