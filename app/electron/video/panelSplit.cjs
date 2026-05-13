/**
 * Panel splitter — joins all chapter page strips vertically into one tall
 * image, detects whitespace gaps between manga panels by row-brightness
 * analysis, then cuts the combined image back into individual panel JPGs.
 *
 * Why concat-then-split:
 *   1. Some publishers split a single panel across two pages — concat
 *      restores it so the panel detector finds the true boundaries.
 *   2. The brightness threshold tunes once per chapter, not per-strip.
 *   3. Output panels are content-bounded (no whitespace gap padding),
 *      so the renderer shows full panels filling the canvas.
 *
 * No native deps — all image work is done via ffmpeg + ffprobe shells.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { resolveFfmpeg, resolveFfprobe } = require('./cinematic.cjs')
const { callRouter } = require('../ai/router.cjs')

// Vision-capable models — try in order, fall back on 429/error
const VISION_MODELS_PANEL_DETECT = [
  'gemini/gemini-2.5-flash',
  'gemini/gemini-2.0-flash',
  'gemini/gemini-2.5-flash-lite'
]

const PANEL_DETECT_PROMPT = `You are looking at a single page from a manga chapter. The page is a tall vertical image that may contain ONE OR MORE comic panels stacked top-to-bottom, separated by whitespace gaps.

Identify each panel as a vertical region. Return ONLY this JSON (no markdown, no commentary):

{
  "panels": [
    { "yTopPct": <0.0-1.0>, "yBottomPct": <0.0-1.0> },
    ...
  ]
}

Rules:
- yTopPct and yBottomPct are vertical coordinates normalized to image height. 0.0 = top of image, 1.0 = bottom.
- List panels top-to-bottom in reading order.
- The region [yTopPct, yBottomPct] should TIGHTLY enclose the panel content — exclude whitespace/gaps ABOVE and BELOW it.
- Don't overlap: yTopPct of panel N must be > yBottomPct of panel N-1.
- If the whole page is a single panel filling the image, return one entry { "yTopPct": 0.0, "yBottomPct": 1.0 }.
- Exclude any publisher watermark or chapter footer at the very bottom (if it's clearly separate from the last panel).

Return ONLY the JSON object.`

async function detectPanelsViaAI(imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`)
  const buf = fs.readFileSync(imagePath)
  const ext = path.extname(imagePath).slice(1).toLowerCase()
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'image/jpeg'
  const base64 = buf.toString('base64')
  const content = [
    { type: 'text', text: PANEL_DETECT_PROMPT },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
  ]
  let lastError = ''
  for (const model of VISION_MODELS_PANEL_DETECT) {
    try {
      const res = await callRouter(model, {
        messages: [{ role: 'user', content }],
        temperature: 0,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        stream: false
      })
      if (!res.ok) { lastError = `${model}: HTTP ${res.status}`; continue }
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content || '{}'
      let parsed = null
      try { parsed = JSON.parse(text) } catch {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (fenced) { try { parsed = JSON.parse(fenced[1]) } catch {} }
      }
      const raw = Array.isArray(parsed?.panels) ? parsed.panels : []
      const clean = []
      for (const p of raw) {
        const top = Math.max(0, Math.min(1, Number(p?.yTopPct)))
        const bot = Math.max(0, Math.min(1, Number(p?.yBottomPct)))
        if (!Number.isFinite(top) || !Number.isFinite(bot)) continue
        if (bot - top < 0.02) continue // skip slivers < 2% height
        // Enforce no overlap with previous (clamp top)
        const lastEnd = clean.length > 0 ? clean[clean.length - 1].yBottomPct : 0
        const fixedTop = Math.max(top, lastEnd)
        if (bot - fixedTop < 0.02) continue
        clean.push({ yTopPct: fixedTop, yBottomPct: bot })
      }
      if (clean.length === 0) {
        // AI returned junk — treat whole page as one panel
        return [{ yTopPct: 0, yBottomPct: 1 }]
      }
      return clean
    } catch (e) {
      lastError = `${model}: ${e.message}`
    }
  }
  throw new Error(`AI panel detect failed: ${lastError}`)
}

function probeImageDimensions(imagePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfprobe(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      imagePath
    ], { windowsHide: true })
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe img exit ${code}: ${err.slice(0, 200)}`))
      const m = out.trim().match(/^(\d+)x(\d+)$/)
      if (!m) return reject(new Error(`ffprobe img bad output: "${out.trim()}"`))
      resolve({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) })
    })
    proc.on('error', reject)
  })
}

/**
 * Vertically concat N images using ffmpeg vstack.
 *
 * Returns `{ commonWidth, scaledHeights[] }` so the caller can compute
 * each page strip's boundary Y in the combined image — those boundaries
 * are guaranteed cut points even if the whitespace detector misses subtle
 * gaps between adjacent strips.
 */
async function vstackImages(imagePaths, outPath, opts = {}) {
  if (imagePaths.length === 0) throw new Error('vstackImages: no inputs')
  if (imagePaths.length === 1) {
    fs.copyFileSync(imagePaths[0], outPath)
    const { width, height } = await probeImageDimensions(outPath)
    return { commonWidth: width, scaledHeights: [height] }
  }

  let maxW = 0
  const origDims = []
  for (const p of imagePaths) {
    const dim = await probeImageDimensions(p)
    origDims.push(dim)
    if (dim.width > maxW) maxW = dim.width
  }
  if (maxW === 0) throw new Error('vstackImages: max width is 0')

  // scaledH per input after scale=maxW:-1 (keeps aspect)
  const scaledHeights = origDims.map(d => Math.round(d.height * maxW / d.width))
  const totalH = scaledHeights.reduce((a, b) => a + b, 0)

  console.log(`[vstackImages] ${imagePaths.length} inputs, common width=${maxW}, est total height=${totalH}, out=${path.basename(outPath)}`)

  const args = ['-y']
  for (const p of imagePaths) args.push('-i', p)
  const N = imagePaths.length
  const parts = []
  const tags = []
  for (let i = 0; i < N; i++) {
    parts.push(`[${i}:v]scale=${maxW}:-1:flags=lanczos,setsar=1[s${i}]`)
    tags.push(`[s${i}]`)
  }
  parts.push(`${tags.join('')}vstack=inputs=${N}[v]`)
  args.push('-filter_complex', parts.join(';'), '-map', '[v]')

  // Encoder + quality args. Force PNG codec explicitly to side-step
  // ffmpeg's auto-pick (which sometimes still tries mjpeg for .png extension
  // when an early filter introduces yuv).
  if (/\.png$/i.test(outPath)) {
    args.push('-c:v', 'png', '-compression_level', '1') // fast write, larger file
  } else {
    args.push('-q:v', String(opts.quality || 5))
  }
  args.push(outPath)

  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpeg(), args, { windowsHide: true })
    let err = ''
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`vstack exit ${code}: ${err.slice(-600)}`))
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
        return reject(new Error('vstack produced empty/tiny output'))
      }
      resolve({ commonWidth: maxW, scaledHeights })
    })
    proc.on('error', reject)
  })
}

/**
 * Extract per-row average brightness from a tall image via ffmpeg.
 * Scales image down to a narrow width (default 100px) for speed; converts
 * to greyscale and streams raw bytes back to compute row averages.
 *
 * Returns array of length scaled-height with values 0..255 (avg brightness
 * of that row in the scaled image).
 */
async function readRowBrightness(imagePath, opts = {}) {
  const scaleW = opts.scaleW || 100
  const dims = await probeImageDimensions(imagePath)
  const aspectH = Math.round(scaleW * dims.height / dims.width)

  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-y', '-i', imagePath,
      '-vf', `scale=${scaleW}:${aspectH}:flags=area,format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray',
      'pipe:1'
    ]
    const proc = spawn(resolveFfmpeg(), args, { windowsHide: true })
    const chunks = []
    let stderr = ''
    proc.stdout.on('data', d => chunks.push(d))
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`rowBrightness exit ${code}: ${stderr.slice(-300)}`))
      const buf = Buffer.concat(chunks)
      if (buf.length < scaleW * aspectH) {
        return reject(new Error(`rowBrightness short read: got ${buf.length} bytes, expected ${scaleW * aspectH}`))
      }
      const rows = new Array(aspectH)
      for (let y = 0; y < aspectH; y++) {
        let sum = 0
        const offset = y * scaleW
        for (let x = 0; x < scaleW; x++) sum += buf[offset + x]
        rows[y] = sum / scaleW
      }
      resolve({ rows, scaleW, scaledH: aspectH, fullH: dims.height, fullW: dims.width })
    })
    proc.on('error', reject)
  })
}

/**
 * Given per-row brightness, find vertical gap regions (whitespace
 * stretches between panels) and return the BOUNDARIES between panels
 * (midpoints of gap regions) in FULL-RESOLUTION pixel coordinates.
 */
function findPanelBoundariesFromRows({ rows, scaledH, fullH }, opts = {}) {
  const whiteThreshold = opts.whiteThreshold || 240   // rows brighter than this = whitespace
  const minGapPxFull = opts.minGapPx || 30            // a gap must be ≥ this many full-res pixels tall

  const minGapScaled = Math.max(1, Math.floor(minGapPxFull * scaledH / fullH))
  const gaps = []
  let inGap = false
  let gapStartY = 0
  for (let y = 0; y < scaledH; y++) {
    const isWhite = rows[y] > whiteThreshold
    if (isWhite && !inGap) { gapStartY = y; inGap = true }
    else if (!isWhite && inGap) {
      const gapEndY = y - 1
      const lenScaled = gapEndY - gapStartY + 1
      if (lenScaled >= minGapScaled) {
        const midScaled = (gapStartY + gapEndY) / 2
        const midFull = Math.round(midScaled * fullH / scaledH)
        gaps.push({ midFull, lenFull: Math.round(lenScaled * fullH / scaledH) })
      }
      inGap = false
    }
  }
  // Edge case: image ends inside a gap
  if (inGap) {
    const gapEndY = scaledH - 1
    const lenScaled = gapEndY - gapStartY + 1
    if (lenScaled >= minGapScaled) {
      const midFull = Math.round(((gapStartY + gapEndY) / 2) * fullH / scaledH)
      gaps.push({ midFull, lenFull: Math.round(lenScaled * fullH / scaledH) })
    }
  }
  return gaps
}

/**
 * Crop a vertical slice of an image via ffmpeg `crop` filter.
 */
async function cropVertical(imagePath, yTopPx, heightPx, outPath, quality = 3) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpeg(), [
      '-y', '-i', imagePath,
      '-vf', `crop=in_w:${heightPx}:0:${yTopPx}`,
      '-q:v', String(quality),
      outPath
    ], { windowsHide: true })
    let err = ''
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`crop exit ${code}: ${err.slice(-300)}`))
      resolve()
    })
    proc.on('error', reject)
  })
}

/**
 * Main entry: take all chapter page strips, ghép + cắt → individual panels.
 *
 * Output: <outDir>/panel_NNN.jpg files + _meta.json
 * Caller is responsible for cleaning <outDir> first if re-running.
 */
async function splitChapterPanels({ stripPaths, outDir, onProgress, opts = {} }) {
  if (!Array.isArray(stripPaths) || stripPaths.length === 0) {
    throw new Error('splitChapterPanels: no strip paths')
  }
  fs.mkdirSync(outDir, { recursive: true })

  // Stage 1: vstack all strips into one tall PNG (JPEG max 65535px height
  // hard limit; combined easily exceeds for 50+ page chapters).
  onProgress?.({ phase: 'concat', msg: `Ghép ${stripPaths.length} strip thành 1 ảnh dài...` })
  const combinedPath = path.join(outDir, '_combined.png')
  const { scaledHeights } = await vstackImages(stripPaths, combinedPath)

  // Page-boundary cuts: between adjacent strips in the vstack, the seam is
  // a guaranteed cut point even if the whitespace detector misses subtle
  // gaps. Compute cumulative scaled Y for each boundary.
  const pageBoundaryYs = []
  let cumY = 0
  for (let i = 0; i < scaledHeights.length - 1; i++) {
    cumY += scaledHeights[i]
    pageBoundaryYs.push(cumY)
  }

  // Stage 2: read per-row brightness, find whitespace gaps within strips
  onProgress?.({ phase: 'detect', msg: 'Phát hiện khoảng trắng giữa panels...' })
  const rowData = await readRowBrightness(combinedPath, { scaleW: 100 })
  const gaps = findPanelBoundariesFromRows(rowData, {
    whiteThreshold: opts.whiteThreshold || 230,   // permissive — catch mildly noisy whitespace
    minGapPx: opts.minGapPx || 15                  // many manga gaps are short (10–20px)
  })

  console.log(`[splitChapterPanels] detected ${gaps.length} whitespace gaps + ${pageBoundaryYs.length} page boundaries`)

  // Merge: page boundaries always cut; whitespace gaps add more cuts.
  // Dedupe boundaries that are close (< 30px apart — likely same gap).
  const allCuts = new Set()
  for (const y of pageBoundaryYs) allCuts.add(y)
  for (const g of gaps) allCuts.add(g.midFull)
  const sortedCuts = [...allCuts].sort((a, b) => a - b)
  const dedupedCuts = []
  for (const y of sortedCuts) {
    if (dedupedCuts.length === 0 || y - dedupedCuts[dedupedCuts.length - 1] >= 30) {
      dedupedCuts.push(y)
    }
  }

  const splitYs = [0, ...dedupedCuts, rowData.fullH]
  const minPanelPx = opts.minPanelPx || 100
  const panelRegions = []
  for (let i = 0; i < splitYs.length - 1; i++) {
    const top = splitYs[i]
    const bot = splitYs[i + 1]
    if (bot - top < minPanelPx) continue
    panelRegions.push({ top, height: bot - top })
  }

  if (panelRegions.length === 0) {
    panelRegions.push({ top: 0, height: rowData.fullH })
  }

  // Stage 3: ffmpeg crop combined → panel_NNN.jpg
  onProgress?.({ phase: 'crop', msg: `Cắt ra ${panelRegions.length} panels...`, i: 0, total: panelRegions.length })
  const panelPaths = []
  for (let i = 0; i < panelRegions.length; i++) {
    const reg = panelRegions[i]
    const outPath = path.join(outDir, `panel_${String(i + 1).padStart(3, '0')}.jpg`)
    await cropVertical(combinedPath, reg.top, reg.height, outPath, opts.outputQuality || 3)
    panelPaths.push(outPath)
    onProgress?.({ phase: 'crop', i: i + 1, total: panelRegions.length })
  }

  // Cleanup combined image
  try { fs.unlinkSync(combinedPath) } catch {}

  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify({
    version: 1,
    splitAt: new Date().toISOString(),
    sourceStrips: stripPaths.length,
    totalPanels: panelPaths.length,
    panelRegions,
    detection: {
      whitespaceGaps: gaps.length,
      pageBoundaries: pageBoundaryYs.length,
      finalCuts: dedupedCuts.length
    },
    settings: {
      whiteThreshold: opts.whiteThreshold || 230,
      minGapPx: opts.minGapPx || 15,
      minPanelPx: opts.minPanelPx || 100
    }
  }, null, 2))

  return { panelPaths, panelCount: panelPaths.length, sourceStrips: stripPaths.length }
}

/**
 * AI-based variant: send each strip to Gemini Vision, get panel bounding
 * boxes, ffmpeg crop. No vstack — each strip processed independently. Cost
 * ~$0.005 per page (Flash). For a 79-page chapter ≈ $0.05–0.10 + 3–5 min.
 * Results cached in _meta.json so re-run is free.
 */
async function splitChapterPanelsAI({ stripPaths, outDir, onProgress, opts = {} }) {
  if (!Array.isArray(stripPaths) || stripPaths.length === 0) {
    throw new Error('splitChapterPanelsAI: no strip paths')
  }
  fs.mkdirSync(outDir, { recursive: true })

  const panelPaths = []
  const allBboxes = []
  let panelIdx = 0

  for (let s = 0; s < stripPaths.length; s++) {
    const stripPath = stripPaths[s]
    onProgress?.({
      phase: 'ai-detect',
      i: s + 1,
      total: stripPaths.length,
      msg: `AI nhận panel page ${s + 1}/${stripPaths.length}...`
    })

    let bboxes
    try {
      bboxes = await detectPanelsViaAI(stripPath)
    } catch (e) {
      console.warn(`[splitChapterPanelsAI] page ${s + 1} AI fail (${e.message}), fallback whole page`)
      bboxes = [{ yTopPct: 0, yBottomPct: 1 }]
    }

    const { width, height } = await probeImageDimensions(stripPath)
    onProgress?.({
      phase: 'ai-crop',
      i: s + 1,
      total: stripPaths.length,
      msg: `Cắt ${bboxes.length} panel từ page ${s + 1}...`
    })
    for (let b = 0; b < bboxes.length; b++) {
      const bb = bboxes[b]
      const yTop = Math.max(0, Math.floor(bb.yTopPct * height))
      const yBot = Math.min(height, Math.ceil(bb.yBottomPct * height))
      const cropH = yBot - yTop
      if (cropH < 50) continue
      panelIdx++
      const outName = `panel_${String(panelIdx).padStart(3, '0')}.jpg`
      const outPath = path.join(outDir, outName)
      await cropVertical(stripPath, yTop, cropH, outPath, opts.outputQuality || 3)
      panelPaths.push(outPath)
      allBboxes.push({
        panelIdx,
        sourceStrip: s,
        sourcePage: path.basename(stripPath),
        yTopPct: bb.yTopPct,
        yBottomPct: bb.yBottomPct,
        yTopPx: yTop,
        yBottomPx: yBot,
        width,
        height
      })
    }
  }

  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify({
    version: 2,
    method: 'ai-vision',
    splitAt: new Date().toISOString(),
    sourceStrips: stripPaths.length,
    totalPanels: panelPaths.length,
    bboxes: allBboxes
  }, null, 2))

  return { panelPaths, panelCount: panelPaths.length, sourceStrips: stripPaths.length, method: 'ai-vision' }
}

module.exports = {
  splitChapterPanels,
  splitChapterPanelsAI,
  detectPanelsViaAI,
  vstackImages,
  readRowBrightness,
  findPanelBoundariesFromRows,
  probeImageDimensions,
  cropVertical
}
