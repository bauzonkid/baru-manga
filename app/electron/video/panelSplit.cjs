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
 * Vertically concat N images into one tall image using ffmpeg vstack.
 *
 * Output MUST be PNG when total height could exceed 65535px (MJPEG/JPEG
 * hard limit). For a 79-page manga at 1429px each ≈ 113000px > limit.
 * Caller passes a `.png` outPath; encoder is auto-selected.
 *
 * vstack requires equal widths; we scale all inputs to a common (max) width.
 */
async function vstackImages(imagePaths, outPath, opts = {}) {
  if (imagePaths.length === 0) throw new Error('vstackImages: no inputs')
  if (imagePaths.length === 1) {
    fs.copyFileSync(imagePaths[0], outPath)
    return
  }

  let maxW = 0
  let totalH = 0
  for (const p of imagePaths) {
    const { width, height } = await probeImageDimensions(p)
    if (width > maxW) maxW = width
    totalH += height
  }
  if (maxW === 0) throw new Error('vstackImages: max width is 0')

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
      resolve()
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

  // Stage 1: vstack all strips into one tall image — PNG output because
  // a 79-page chapter easily exceeds JPEG's 65535px height limit.
  onProgress?.({ phase: 'concat', msg: `Ghép ${stripPaths.length} strip thành 1 ảnh dài...` })
  const combinedPath = path.join(outDir, '_combined.png')
  await vstackImages(stripPaths, combinedPath)

  // Stage 2: read per-row brightness, find gaps
  onProgress?.({ phase: 'detect', msg: 'Phát hiện khoảng trắng giữa panels...' })
  const rowData = await readRowBrightness(combinedPath, { scaleW: 100 })
  const gaps = findPanelBoundariesFromRows(rowData, {
    whiteThreshold: opts.whiteThreshold || 240,
    minGapPx: opts.minGapPx || 30
  })

  // Build panel regions from gap midpoints
  const splitYs = [0, ...gaps.map(g => g.midFull), rowData.fullH]
  splitYs.sort((a, b) => a - b)
  const minPanelPx = opts.minPanelPx || 100  // skip tiny slivers
  const panelRegions = []
  for (let i = 0; i < splitYs.length - 1; i++) {
    const top = splitYs[i]
    const bot = splitYs[i + 1]
    if (bot - top < minPanelPx) continue
    panelRegions.push({ top, height: bot - top })
  }

  if (panelRegions.length === 0) {
    // Fallback: keep combined image as the one panel
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

  // Persist metadata
  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify({
    version: 1,
    splitAt: new Date().toISOString(),
    sourceStrips: stripPaths.length,
    totalPanels: panelPaths.length,
    panelRegions,
    settings: {
      whiteThreshold: opts.whiteThreshold || 240,
      minGapPx: opts.minGapPx || 30,
      minPanelPx: opts.minPanelPx || 100
    }
  }, null, 2))

  return { panelPaths, panelCount: panelPaths.length, sourceStrips: stripPaths.length }
}

module.exports = {
  splitChapterPanels,
  vstackImages,
  readRowBrightness,
  findPanelBoundariesFromRows,
  probeImageDimensions,
  cropVertical
}
