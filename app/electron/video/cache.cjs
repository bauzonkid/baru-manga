/**
 * TTS WAV cache by content hash.
 *
 * Key = SHA256(text|voice|model|language) truncated to 24 hex chars.
 * Same text/voice/model/lang → same hash → reuse cached WAV.
 * Anything changes → hash differs → re-fetch.
 *
 * Purpose: Gemini TTS Preview has per-call variance. By caching the FIRST
 * successful generation, subsequent renders of the same chapter (or the
 * same segment after a re-render trigger) reuse the locked audio. Final
 * video has 1 consistent voice across all segments.
 *
 * Layout:
 *   <baseDir>/tts/<hash>.wav    — audio file
 *   <baseDir>/tts/<hash>.json   — metadata (text excerpt, voice, model, language, ts)
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function hashKey(text, voice, model, language) {
  return crypto.createHash('sha256')
    .update(`${text}|${voice}|${model}|${language || ''}`)
    .digest('hex')
    .slice(0, 24)
}

function cachePaths(baseDir, hash) {
  const dir = path.join(baseDir, 'tts')
  return {
    dir,
    wav: path.join(dir, `${hash}.wav`),
    meta: path.join(dir, `${hash}.json`)
  }
}

function isValidWav(buf) {
  return buf && buf.length > 1000 && buf.slice(0, 4).toString('ascii') === 'RIFF'
}

/**
 * Lookup-or-generate. Calls `generator()` only on cache miss. The generator
 * must return a Buffer containing a valid RIFF/WAVE payload.
 *
 * @returns {Promise<{ path: string, hash: string, bytes: number, cached: boolean }>}
 */
async function getOrFetch({ text, voice, model, language, baseDir }, generator) {
  const hash = hashKey(text, voice, model, language)
  const paths = cachePaths(baseDir, hash)

  // Cache hit?
  if (fs.existsSync(paths.wav)) {
    const stat = fs.statSync(paths.wav)
    if (stat.size > 1000) {
      return { path: paths.wav, hash, bytes: stat.size, cached: true }
    }
    // Corrupt / partial — fall through to regenerate.
    try { fs.unlinkSync(paths.wav) } catch { /* ignore */ }
  }

  // Cache miss — call generator and persist.
  const buf = await generator()
  if (!isValidWav(buf)) {
    throw new Error(`Generator returned invalid WAV (first 4 bytes: ${buf?.slice(0, 4).toString('hex')})`)
  }
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.writeFileSync(paths.wav, buf)
  fs.writeFileSync(paths.meta, JSON.stringify({
    text: text.slice(0, 200),
    textLength: text.length,
    voice, model, language,
    bytes: buf.length,
    createdAt: new Date().toISOString()
  }, null, 2))
  return { path: paths.wav, hash, bytes: buf.length, cached: false }
}

/** Stats over the whole cache. */
function stats(baseDir) {
  const dir = path.join(baseDir, 'tts')
  if (!fs.existsSync(dir)) return { count: 0, totalBytes: 0 }
  let count = 0
  let totalBytes = 0
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.wav')) continue
    count++
    try { totalBytes += fs.statSync(path.join(dir, f)).size } catch { /* ignore */ }
  }
  return { count, totalBytes }
}

/** Best-effort wipe. */
function clear(baseDir) {
  const dir = path.join(baseDir, 'tts')
  if (!fs.existsSync(dir)) return 0
  let removed = 0
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, f)); removed++ } catch { /* ignore */ }
  }
  return removed
}

module.exports = { hashKey, cachePaths, getOrFetch, isValidWav, stats, clear }
