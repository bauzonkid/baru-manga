/**
 * AI fallback for chapter list extraction.
 *
 * Used when the universal heuristic scraper (HTML <a> tag regex) fails to
 * find any chapter links — e.g. the site uses obscure CSS classes, the
 * markup is unusual, or chapter pattern is non-standard.
 *
 * Sends truncated HTML to Gemini Flash via 9router and asks for a JSON
 * chapter list. Costs ~1 AI call per "open manga URL" on unknown sites.
 */

const { callRouter } = require('./router.cjs')

// Try in this order. Lite model is fastest + cheapest; falls through if
// rate-limited or refuses.
const MODELS = [
  'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash',
  'gemini/gemini-2.0-flash-lite'
]

function absolutize(src, baseUrl) {
  if (!src) return null
  src = String(src).trim()
  if (src.startsWith('//')) {
    try { return new URL(baseUrl).protocol + src } catch { return null }
  }
  if (src.startsWith('/')) {
    try { return new URL(baseUrl).origin + src } catch { return null }
  }
  if (/^https?:\/\//i.test(src)) return src
  try { return new URL(src, baseUrl).href } catch { return null }
}

async function scrapeChaptersFromHtml(html, baseUrl) {
  // Most chapter lists live in the first ~80KB. Truncate to keep the
  // request within context limit + cost reasonable.
  const truncated = String(html).slice(0, 80000)

  const prompt = `From this manga reader site HTML (URL: ${baseUrl}), extract the chapter list for the current manga.

Return JSON exactly matching this schema:
{ "chapters": [{ "href": "<url>", "number": "<string>", "title": "<string|optional>" }] }

Rules:
- href = link to the chapter reading page. Relative or absolute both OK.
- number = chapter number as string ("1", "12.5", "100"). If you can't read it, omit the entry.
- title = chapter title if present (e.g. "Chương 12: Bí mật"), otherwise omit.
- ONLY chapter reading URLs of this manga. Skip ads, navigation, related manga, comments.
- Sort ascending by chapter number.
- If no chapter list found, return { "chapters": [] }.

HTML (truncated, ${truncated.length} chars):
${truncated}`

  let lastError = 'unknown'
  for (const model of MODELS) {
    try {
      const res = await callRouter(model, {
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        stream: false,
        max_tokens: 4096,
        temperature: 0
      })
      if (!res.ok) { lastError = `${model}: HTTP ${res.status}`; continue }
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content || '{}'
      let parsed = null
      try { parsed = JSON.parse(text) } catch {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (fenced) { try { parsed = JSON.parse(fenced[1]) } catch {} }
      }
      const raw = Array.isArray(parsed?.chapters)
        ? parsed.chapters
        : (Array.isArray(parsed) ? parsed : [])
      const out = []
      const seen = new Set()
      for (const c of raw) {
        const abs = absolutize(c.href || c.url || c.id, baseUrl)
        if (!abs || seen.has(abs)) continue
        seen.add(abs)
        out.push({
          id: abs,
          number: String(c.number ?? c.chapter ?? '?'),
          title: c.title || undefined,
          language: 'unknown',
          pageCount: undefined
        })
      }
      out.sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0))
      return out
    } catch (e) {
      lastError = `${model}: ${e.message}`
    }
  }
  throw new Error(`AI scrape failed: ${lastError}`)
}

module.exports = { scrapeChaptersFromHtml }
