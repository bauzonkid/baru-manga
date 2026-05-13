/**
 * Cinematic per-segment renderer.
 *
 * Takes one segment (a list of panel image paths + an audio WAV + caption text)
 * and produces a single MP4 clip with:
 *   - Background: panel blurred + scaled to fill 1920×1080
 *   - Foreground: panel fitted with slow zoom-pan (1.0 → 1.3) centered
 *   - Caption: burned-in drawtext bottom-center (TikTok-style, semi-transparent box)
 *   - Audio: the segment's TTS WAV
 *
 * Multi-panel segments get N evenly-split sub-clips concatenated inside the
 * same MP4 chunk (each panel shows for `audio_duration / N` seconds).
 *
 * Outputs into the same dir as the audio WAV with `.mp4` extension by default.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Resolve ffmpeg binary. Prefer ffmpeg-static (bundled) if installed;
// fall back to system ffmpeg on PATH (dev mode + sếp đã có ffmpeg 8.1).
function resolveFfmpeg() {
  try {
    const p = require('ffmpeg-static')
    if (p && fs.existsSync(p)) return p
  } catch { /* not installed */ }
  return 'ffmpeg'
}

function resolveFfprobe() {
  try {
    const { path: p } = require('ffprobe-static')
    if (p && fs.existsSync(p)) return p
  } catch { /* not installed */ }
  return 'ffprobe'
}

// Find a system font for drawtext. Windows ffmpeg without fontconfig crashes
// if drawtext is given no `fontfile`. Prefer fonts with Vietnamese diacritics.
function resolveFontFile() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arial.ttf'),
        path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'segoeui.ttf'),
        path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'tahoma.ttf')
      ]
    : [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/Library/Fonts/Arial.ttf',
        '/System/Library/Fonts/Helvetica.ttc'
      ]
  for (const f of candidates) {
    if (fs.existsSync(f)) return f
  }
  return null
}

// ffmpeg drawtext fontfile path on Windows needs forward slashes + escaped colon.
function escapeFontfilePath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

/** Probe WAV duration in seconds (float). Uses ffprobe. */
async function probeDuration(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfprobe(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ], { windowsHide: true })
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.slice(0, 200)}`))
      const dur = parseFloat(out.trim())
      if (!isFinite(dur) || dur <= 0) return reject(new Error(`ffprobe bad duration: "${out.trim()}"`))
      resolve(dur)
    })
    proc.on('error', reject)
  })
}

/** Escape drawtext text — colon, backslash, single-quote must be escaped. */
function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '’')   // U+2019 right-single-quote, looks identical, side-steps ffmpeg quoting hell
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ')
}

/** Word-wrap caption to fit 1920px width. Roughly 60 chars per line at 42pt. */
function wrapCaption(text, maxChars = 60) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      if (line) lines.push(line)
      line = w
    } else {
      line = (line + ' ' + w).trim()
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

/**
 * Render a single segment clip.
 *
 * @param {object} opts
 * @param {string[]} opts.panelPaths     - one or more local image paths (in order)
 * @param {string}   opts.audioPath      - WAV file
 * @param {string}   opts.captionText    - subtitle text to burn
 * @param {string}   opts.outPath        - output MP4 path
 * @param {object}   [opts.dims]         - { width, height } default 1920×1080
 * @param {number}   [opts.fps=30]
 * @param {boolean}  [opts.burnCaption=true]
 * @returns {Promise<{ path: string, duration: number, panels: number }>}
 */
async function renderSegmentClip(opts) {
  const {
    panelPaths,
    audioPath,
    captionText,
    outPath,
    dims = { width: 1920, height: 1080 },
    fps = 30,
    burnCaption = true,
    subtitleStyle = {}
  } = opts

  // Subtitle style with sensible defaults. Frontend can override per workspace.
  const subFontSize = Number(subtitleStyle.fontSize) || 42
  const subPosition = ['top', 'middle', 'bottom'].includes(subtitleStyle.position) ? subtitleStyle.position : 'bottom'
  const subColor = subtitleStyle.color || 'white'
  const subBoxOpacity = Number.isFinite(subtitleStyle.boxOpacity) ? subtitleStyle.boxOpacity : 0.65
  const subShowBox = subtitleStyle.showBox !== false  // default true
  const subYOffset = Number.isFinite(subtitleStyle.yOffset) ? subtitleStyle.yOffset : 80
  const subMaxLineChars = Number(subtitleStyle.maxLineChars) || Math.max(28, Math.floor(1600 / (subFontSize / 1.5)))

  if (!Array.isArray(panelPaths) || panelPaths.length === 0) {
    throw new Error('renderSegmentClip: panelPaths empty')
  }
  for (const p of panelPaths) {
    if (!fs.existsSync(p)) throw new Error(`Panel image not found: ${p}`)
  }
  if (!fs.existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`)

  const totalDur = await probeDuration(audioPath)
  const perPanelDur = totalDur / panelPaths.length
  const frames = Math.max(1, Math.round(perPanelDur * fps))

  const { width: W, height: H } = dims
  // Pre-zoompan canvas size — must be larger than output for the zoompan engine
  // to interpolate smoothly. 4× output is the recipe ffmpeg cookbook uses to
  // dodge the well-known "shake" artifact when zooming small images.
  const zpInner = W * 2

  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  // Build inputs: each panel as image2 with -loop 1 -t <perPanelDur>.
  // Audio as a final input (-i audioPath, no loop).
  const inputs = []
  for (const p of panelPaths) {
    inputs.push('-loop', '1', '-t', String(perPanelDur), '-i', p)
  }
  inputs.push('-i', audioPath)

  // Per-panel filter graph:
  //   [Ni]
  //     split [bgN][fgN];
  //   [bgN] scale=W:H:force_original_aspect_ratio=increase, crop=W:H, boxblur=20:5,
  //         setsar=1 [bgN_blur];
  //   [fgN] scale=zp:-1, zoompan=z='1+0.3*on/frames':d=frames:s=WxH, setsar=1 [fgN_zoom];
  //   [bgN_blur][fgN_zoom] overlay=(W-w)/2:(H-h)/2 [vN]
  // Then concat: [v0][v1]...[vN] concat=n=N:v=1:a=0 [v]
  // Then optionally drawtext on [v] for caption.
  const parts = []
  const tags = []
  for (let i = 0; i < panelPaths.length; i++) {
    parts.push(
      `[${i}:v]split[bg${i}][fg${i}]`,
      `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:5,setsar=1[bg${i}b]`,
      // Pre-scale foreground large so zoompan doesn't blur it. Keep aspect.
      `[fg${i}]scale=${zpInner}:-1:force_original_aspect_ratio=decrease,zoompan=z='min(1+0.3*on/${frames},1.3)':d=${frames}:s=${W}x${H}:fps=${fps},setsar=1[fg${i}z]`,
      `[bg${i}b][fg${i}z]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p[v${i}]`
    )
    tags.push(`[v${i}]`)
  }
  let lastTag = 'v'
  if (panelPaths.length === 1) {
    // Single panel — just rename the only chain to [v]
    parts[parts.length - 1] = parts[parts.length - 1].replace('[v0]', '[v]')
  } else {
    parts.push(`${tags.join('')}concat=n=${panelPaths.length}:v=1:a=0[v]`)
  }
  if (burnCaption && captionText && captionText.trim()) {
    const fontFile = resolveFontFile()
    if (!fontFile) {
      console.warn('[cinematic] no system font found, skipping caption burn')
      const last = parts[parts.length - 1]
      parts[parts.length - 1] = last.replace(/\[v\]$/, '[vout]')
      lastTag = 'vout'
    } else {
      const fontArg = escapeFontfilePath(fontFile)
      const wrapped = wrapCaption(captionText.trim(), subMaxLineChars)
      const escaped = escapeDrawtext(wrapped)
      // y expression by position. top/middle/bottom relative to frame.
      let yExpr
      if (subPosition === 'top') yExpr = String(subYOffset)
      else if (subPosition === 'middle') yExpr = `(h-text_h)/2`
      else yExpr = `h-text_h-${subYOffset}`
      const boxArg = subShowBox
        ? `box=1:boxcolor=black@${subBoxOpacity}:boxborderw=24:`
        : ''
      parts.push(
        `[${lastTag}]drawtext=fontfile='${fontArg}':text='${escaped}':fontsize=${subFontSize}:fontcolor=${subColor}:` +
        `${boxArg}` +
        `line_spacing=10:shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
        `x=(w-text_w)/2:y=${yExpr}[vout]`
      )
      lastTag = 'vout'
    }
  } else {
    // Rename [v] -> [vout] so mapping is uniform
    const last = parts[parts.length - 1]
    parts[parts.length - 1] = last.replace(/\[v\]$/, '[vout]')
    lastTag = 'vout'
  }
  const filterComplex = parts.join(';')

  // Audio index = number of image inputs (i.e. panelPaths.length)
  const audioInputIdx = panelPaths.length

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', `[${lastTag}]`,
    '-map', `${audioInputIdx}:a`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outPath
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpeg(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exit ${code}\nLast stderr:\n${stderr.slice(-2000)}`))
      }
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
        return reject(new Error('ffmpeg succeeded but output missing/tiny'))
      }
      resolve({ path: outPath, duration: totalDur, panels: panelPaths.length })
    })
    proc.on('error', reject)
  })
}

/**
 * Concat a list of MP4 clips into one final MP4. Uses ffmpeg concat demuxer
 * which is lossless (no re-encode) when all clips share codec/timebase —
 * they do, since we render all of them with the same settings above.
 */
async function concatClips({ clipPaths, outPath }) {
  if (!Array.isArray(clipPaths) || clipPaths.length === 0) {
    throw new Error('concatClips: empty')
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  // Write a temp concat list file: each line `file '<absolute path>'`
  const listPath = path.join(path.dirname(outPath), `concat-${Date.now()}.txt`)
  const listContent = clipPaths.map(p => {
    // ffmpeg concat demuxer wants forward slashes + escaped single quote
    const safe = p.replace(/\\/g, '/').replace(/'/g, "'\\''")
    return `file '${safe}'`
  }).join('\n')
  fs.writeFileSync(listPath, listContent, 'utf8')

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outPath
  ]

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(resolveFfmpeg(), args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', d => { stderr += d.toString() })
      proc.on('close', code => {
        if (code !== 0) return reject(new Error(`ffmpeg concat exit ${code}\n${stderr.slice(-1500)}`))
        if (!fs.existsSync(outPath)) return reject(new Error('concat output missing'))
        resolve()
      })
      proc.on('error', reject)
    })
  } finally {
    try { fs.unlinkSync(listPath) } catch { /* ignore */ }
  }
  return { path: outPath, clips: clipPaths.length }
}

/**
 * Build an SRT subtitle file from segment timings.
 * timings = [{ startSec, endSec, text }]
 */
function buildSrt(timings) {
  const fmt = sec => {
    const ms = Math.max(0, Math.round(sec * 1000))
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    const mm = ms % 1000
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mm).padStart(3, '0')}`
  }
  return timings.map((t, i) => {
    const text = String(t.text || '').replace(/\r?\n/g, ' ').trim()
    return `${i + 1}\n${fmt(t.startSec)} --> ${fmt(t.endSec)}\n${text}\n`
  }).join('\n')
}

/**
 * Overlay subtitles from an SRT file onto an existing MP4 via ffmpeg's
 * `subtitles=` (libass). Single video re-encode + audio copy.
 */
async function overlaySubtitleOnVideo(opts) {
  const {
    inputPath,
    srtPath,
    outPath,
    subtitleStyle = {}
  } = opts
  if (!fs.existsSync(inputPath)) throw new Error(`Input MP4 not found: ${inputPath}`)
  if (!fs.existsSync(srtPath)) throw new Error(`SRT not found: ${srtPath}`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const fontSize = Number(subtitleStyle.fontSize) || 42
  const position = ['top', 'middle', 'bottom'].includes(subtitleStyle.position) ? subtitleStyle.position : 'bottom'
  const boxOpacity = Number.isFinite(subtitleStyle.boxOpacity) ? subtitleStyle.boxOpacity : 0.65
  const showBox = subtitleStyle.showBox !== false
  const fontFile = resolveFontFile()

  // libass ASS alignment: 2=bottom-center, 5=top-center, 10=middle-center
  const alignment = position === 'top' ? 5 : position === 'middle' ? 10 : 2
  // BackColour: &HAABBGGRR. Alpha 00=opaque, FF=transparent.
  const alphaHex = Math.round((1 - boxOpacity) * 255).toString(16).padStart(2, '0').toUpperCase()
  const backColour = showBox ? `&H${alphaHex}000000` : '&HFF000000'
  const borderStyle = showBox ? 4 : 1 // 4=opaque box, 1=outline+shadow only
  const styleParts = [
    `FontName=${fontFile ? path.basename(fontFile, path.extname(fontFile)) : 'Arial'}`,
    `FontSize=${fontSize}`,
    `PrimaryColour=&H00FFFFFF`,
    `BackColour=${backColour}`,
    `BorderStyle=${borderStyle}`,
    `Outline=2`,
    `Shadow=1`,
    `Alignment=${alignment}`,
    `MarginV=60`
  ].join(',')

  const srtArg = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:')
  const vf = `subtitles='${srtArg}':force_style='${styleParts}'`

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-c:a', 'copy',
    outPath
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpeg(), args, { windowsHide: true })
    let err = ''
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg subtitle overlay exit ${code}: ${err.slice(-600)}`))
      resolve({ path: outPath })
    })
    proc.on('error', reject)
  })
}

module.exports = {
  renderSegmentClip,
  concatClips,
  probeDuration,
  resolveFfmpeg,
  resolveFfprobe,
  buildSrt,
  overlaySubtitleOnVideo
}
