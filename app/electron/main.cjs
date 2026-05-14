// Silence Electron's "Insecure Content-Security-Policy / webSecurity disabled /
// allowRunningInsecureContent" dev warnings in DevTools console. These are
// intentional trade-offs for loading manga CDN images from any origin + file://
// local panels — packaged builds won't show them anyway.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

const { app, BrowserWindow, ipcMain, dialog, net, session, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const ttsCache = require('./video/cache.cjs')
const cinematic = require('./video/cinematic.cjs')
const license = require('./license.cjs')
const workspace = require('./workspace.cjs')

let mainWindow = null

// Maps image CDN host → which Referer to spoof, so <img src="..."> tags
// in the renderer don't get blocked by hotlink protection. Populated when
// a chapter is opened (we know the page URL → origin).
const refererMap = new Map()

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const PLUGINS_DIR = path.join(__dirname, 'plugins')

const plugins = new Map()

// Plugin loader. Loads from two locations:
//   1. Built-in: `app/electron/plugins/*.cjs` (ships with app)
//   2. User:     `<userData>/plugins/*.cjs` (user-authored adapters per site)
// User plugins override built-in if same `id`. Files ending `.example` are
// treated as templates and skipped.
function loadPluginsFromDir(dir, label) {
  if (!dir || !fs.existsSync(dir)) return 0
  let count = 0
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.cjs')) continue
    if (file.endsWith('.example.cjs') || file.startsWith('_')) continue
    const full = path.join(dir, file)
    try {
      // Bust require cache so user plugins reload cleanly on app restart
      delete require.cache[require.resolve(full)]
      const plugin = require(full)
      if (plugin && plugin.id) {
        plugins.set(plugin.id, plugin)
        count++
      }
    } catch (e) {
      console.error(`Failed to load ${label || 'plugin'} ${file}:`, e.message)
    }
  }
  return count
}

// Load built-in plugins at module init so they're available before any IPC.
loadPluginsFromDir(PLUGINS_DIR, 'built-in plugin')

function userPluginsDir() {
  try { return path.join(app.getPath('userData'), 'plugins') } catch { return null }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0a0b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false // allow remote image loads from MangaDex CDN + file:// for local
    }
  })

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL)
    // DevTools off by default. Set BARU_DEVTOOLS=1 to open it (F12 also works
    // any time — Electron's default Ctrl+Shift+I shortcut still toggles it).
    if (process.env.BARU_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // Spoof Referer for image requests so manga CDNs don't 403 us.
  // Order of preference: explicit per-host override (set by chapter:registerReferer
  // when a chapter is opened) → the image's own origin (works for CDNs that
  // either don't check Referer, or accept same-origin requests).
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['*://*/*'] },
    (details, callback) => {
      const isImage = details.resourceType === 'image' || /\.(jpe?g|png|webp|gif|avif|bmp)(\?|#|$)/i.test(details.url)
      if (!isImage) return callback({ requestHeaders: details.requestHeaders })
      try {
        const host = new URL(details.url).host
        const headers = { ...details.requestHeaders }
        const override = refererMap.get(host)
        if (override) {
          headers.Referer = override
        } else {
          headers.Referer = new URL(details.url).origin + '/'
        }
        callback({ requestHeaders: headers })
      } catch {
        callback({ requestHeaders: details.requestHeaders })
      }
    }
  )

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  // Now that userData path is resolved, also load user-authored plugins.
  // mkdir is idempotent — creates <userData>/plugins on first run.
  const dir = userPluginsDir()
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    const n = loadPluginsFromDir(dir, 'user plugin')
    if (n > 0) console.log(`Loaded ${n} user plugin(s) from ${dir}`)
  }
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ----- Plugin IPC -----

ipcMain.handle('plugins:list', () =>
  [...plugins.values()].map(p => ({
    id: p.id,
    name: p.name,
    capabilities: p.capabilities || { search: true, openLocal: false },
    needsApiKey: false
  }))
)

ipcMain.handle('plugins:search', async (_e, { pluginId, query }) => {
  const p = plugins.get(pluginId)
  if (!p) return { ok: false, error: `Plugin not found: ${pluginId}` }
  try {
    return { ok: true, data: await p.search(query) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('plugins:openLocal', async (_e, { pluginId }) => {
  const p = plugins.get(pluginId)
  if (!p || !p.openLocal) return { ok: false, error: 'Plugin không hỗ trợ openLocal' }
  try {
    const result = await p.openLocal(mainWindow)
    return { ok: true, data: result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('plugins:getManga', async (_e, { pluginId, id }) => {
  const p = plugins.get(pluginId)
  if (!p) return { ok: false, error: `Plugin not found: ${pluginId}` }
  try {
    return { ok: true, data: await p.getManga(id) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('plugins:getChapters', async (_e, { pluginId, mangaId, opts }) => {
  const p = plugins.get(pluginId)
  if (!p) return { ok: false, error: `Plugin not found: ${pluginId}` }
  try {
    return { ok: true, data: await p.getChapters(mangaId, opts) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('plugins:getPages', async (_e, { pluginId, chapterId }) => {
  const p = plugins.get(pluginId)
  if (!p) return { ok: false, error: `Plugin not found: ${pluginId}` }
  try {
    return { ok: true, data: await p.getPages(chapterId) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Renderer calls this after loading a chapter's pages: it tells main process
// which Referer to send for each image CDN host. Image CDNs that hotlink-check
// (nettruyen, manhuagui...) require the referer of the host page, not the
// renderer's localhost origin.
ipcMain.handle('chapter:registerReferer', async (_e, { pageUrls, referer }) => {
  if (!Array.isArray(pageUrls) || !referer) return { ok: false }
  const hosts = new Set()
  for (const u of pageUrls) {
    try { hosts.add(new URL(u).host) } catch { /* skip invalid */ }
  }
  for (const h of hosts) refererMap.set(h, referer)
  return { ok: true, data: { hosts: [...hosts], referer } }
})

// Download all pages of a chapter to disk under <user-pick-or-default>/<slug>/<chapter>/page_001.ext
// Returns { dir, localPaths } so renderer can later use file:// URLs or feed to ffmpeg.
function safeSlug(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'chapter'
}

function extFromUrl(u, fallback = 'jpg') {
  const m = u.split('?')[0].match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : fallback
}

/**
 * Shared helper: downloads a list of image URLs to a directory using Electron's
 * net.request (handles hotlink referer). Resume-aware (skip files >1KB).
 * Used by both `chapter:download` IPC + `video:render` orchestrator.
 */
async function downloadPagesToDisk({ pageUrls, referer, dir, onProgress }) {
  fs.mkdirSync(dir, { recursive: true })
  const localPaths = []
  for (let i = 0; i < pageUrls.length; i++) {
    const url = pageUrls[i]
    const ext = extFromUrl(url, 'jpg')
    const fname = `page_${String(i + 1).padStart(3, '0')}.${ext}`
    const target = path.join(dir, fname)

    try {
      const st = fs.statSync(target)
      if (st.size > 1000) {
        localPaths.push(target)
        onProgress?.({ i: i + 1, total: pageUrls.length, file: fname, cached: true })
        continue
      }
    } catch { /* not present */ }

    // Node fetch — bypasses Chromium adblock that triggers ERR_BLOCKED_BY_CLIENT
    // for CDN URLs containing keywords like "ad", "banner", "track".
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'image/webp,image/avif,image/png,image/jpeg,image/*,*/*;q=0.8',
        ...(referer ? { 'Referer': referer } : {})
      }
    })
    if (!res.ok) throw new Error(`Page ${i + 1} → HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())

    fs.writeFileSync(target, buf)
    localPaths.push(target)
    onProgress?.({ i: i + 1, total: pageUrls.length, file: fname, cached: false })
  }
  return localPaths
}

// Open the workspace folder (or legacy downloads folder) in OS file explorer.
// Accepts either { workspaceId } (preferred, opens whole workspace folder)
// or { mangaSlug } (legacy fallback, opens downloads/<mSlug>/).
ipcMain.handle('chapter:openDownloadsFolder', async (_e, { workspaceId, mangaSlug }) => {
  try {
    let dir
    if (workspaceId) {
      dir = workspace.workspaceDir(app.getPath('userData'), workspaceId)
      workspace.ensureWorkspaceLayout(app.getPath('userData'), workspaceId)
    } else {
      dir = path.join(app.getPath('userData'), 'downloads', safeSlug(mangaSlug || 'untitled-manga'))
      fs.mkdirSync(dir, { recursive: true })
    }
    const err = await shell.openPath(dir)
    if (err) return { ok: false, error: err }
    return { ok: true, data: { dir } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Download chapter pages. With `workspaceId`, files land inside the workspace
// folder (everything for one manga in one place). Without, legacy path under
// downloads/<mSlug>/<cSlug>/ — kept for backward compat.
// Scan workspace videos/ for already-rendered MP4s + their timings JSON.
// Returns latest base render (no "withsub" in name) and latest final render
// so Studio can resume Step 6/7 across app restart.
ipcMain.handle('workspace:scanRenders', async (_e, { workspaceId }) => {
  try {
    if (!workspaceId) return { ok: false, error: 'Thiếu workspaceId' }
    const videosDir = path.join(workspace.workspaceDir(app.getPath('userData'), workspaceId), 'videos')
    if (!fs.existsSync(videosDir)) return { ok: true, data: { base: null, final: null, timings: null } }
    const files = fs.readdirSync(videosDir)

    const baseList = []
    const finalList = []
    for (const f of files) {
      if (!f.endsWith('.mp4')) continue
      const full = path.join(videosDir, f)
      const stat = fs.statSync(full)
      const info = { name: f, path: full, bytes: stat.size, mtime: stat.mtimeMs }
      if (f.includes('withsub')) finalList.push(info)
      else baseList.push(info)
    }
    baseList.sort((a, b) => b.mtime - a.mtime)
    finalList.sort((a, b) => b.mtime - a.mtime)

    const latestBase = baseList[0] || null
    let timings = null
    if (latestBase) {
      const timingsPath = path.join(videosDir, path.basename(latestBase.name, '.mp4') + '.timings.json')
      try {
        const raw = fs.readFileSync(timingsPath, 'utf-8')
        const j = JSON.parse(raw)
        if (Array.isArray(j.timings)) timings = j.timings
      } catch { /* timings file missing — render predates this scheme */ }
    }
    return {
      ok: true,
      data: {
        base: latestBase ? { outPath: latestBase.path, bytes: latestBase.bytes } : null,
        timings,
        final: finalList[0] ? { outPath: finalList[0].path, bytes: finalList[0].bytes } : null
      }
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Persist voiceover segments to disk so they survive app restart.
// Path: <ws>/voiceover/<chapterSlug>.json
ipcMain.handle('workspace:saveSegments', async (_e, { workspaceId, chapterSlug, segments }) => {
  try {
    if (!workspaceId) return { ok: false, error: 'Thiếu workspaceId' }
    const dir = path.join(workspace.workspaceDir(app.getPath('userData'), workspaceId), 'voiceover')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safeSlug(chapterSlug || 'chapter')}.json`)
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      chapterSlug,
      savedAt: new Date().toISOString(),
      segments: segments || []
    }, null, 2))
    return { ok: true, data: { path: file } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Load all saved voiceover JSON files for a workspace. Returns
// { [chapterId]: segments[] } for chapters with a saved file.
ipcMain.handle('workspace:loadSegments', async (_e, { workspaceId, chapters }) => {
  try {
    if (!workspaceId) return { ok: false, error: 'Thiếu workspaceId' }
    const dir = path.join(workspace.workspaceDir(app.getPath('userData'), workspaceId), 'voiceover')
    const result = {}
    for (const ch of (chapters || [])) {
      const slug = safeSlug(`ch${ch.number}`)
      const file = path.join(dir, `${slug}.json`)
      try {
        const raw = fs.readFileSync(file, 'utf-8')
        const json = JSON.parse(raw)
        if (Array.isArray(json.segments) && json.segments.length > 0) {
          result[ch.id] = json.segments
        }
      } catch { /* file missing or unreadable — skip */ }
    }
    return { ok: true, data: result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Scan workspace pages/ folder for already-downloaded chapter files. Returns
// { [chapterId]: localPaths[] } for chapters whose folder has files.
//
// Precedence: if a chapter has `_panels/panel_NNN.*` files (output of the
// panel-split pipeline), prefer those over the raw `page_NNN.*` strips.
// That way once the user has run the split step, everything downstream
// (voiceover gen, render) sees clean individual panels.
ipcMain.handle('workspace:scanPages', async (_e, { workspaceId, chapters }) => {
  try {
    if (!workspaceId) return { ok: false, error: 'Thiếu workspaceId' }
    const pagesRoot = path.join(workspace.workspaceDir(app.getPath('userData'), workspaceId), 'pages')
    const result = {}
    for (const ch of (chapters || [])) {
      const slug = safeSlug(`ch${ch.number}`)
      const chDir = path.join(pagesRoot, slug)
      const panelsDir = path.join(chDir, '_panels')
      let files = []
      // 1. Prefer split panels if present
      if (fs.existsSync(panelsDir)) {
        try {
          files = fs.readdirSync(panelsDir)
            .filter(f => /^panel_\d+\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f))
            .sort()
            .map(f => path.join(panelsDir, f))
        } catch { /* ignore */ }
      }
      // 2. Fallback to raw page strips
      if (files.length === 0) {
        try {
          files = fs.readdirSync(chDir)
            .filter(f => /^page_\d+\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f))
            .sort()
            .map(f => path.join(chDir, f))
        } catch { /* chapter dir not yet downloaded */ }
      }
      if (files.length > 0) result[ch.id] = files
    }
    return { ok: true, data: result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Split a chapter's raw page strips into individual panel JPGs.
//   mode: 'ai' (default) — Gemini Vision detects panel bboxes per strip.
//                          Costs ~$0.005/page. Cached in _meta.json.
//   mode: 'cv'            — Whitespace gap detection (free, offline).
//                          Less reliable on manga with bright backgrounds.
// Output: <ws>/pages/<chapter-slug>/_panels/panel_NNN.jpg + _meta.json
ipcMain.handle('chapter:splitPanels', async (evt, { workspaceId, chapterSlug, opts, mode }) => {
  try {
    if (!workspaceId) return { ok: false, error: 'Thiếu workspaceId' }
    const wsRoot = workspace.workspaceDir(app.getPath('userData'), workspaceId)
    const cSlug = safeSlug(chapterSlug || 'chapter')
    const pagesDir = path.join(wsRoot, 'pages', cSlug)
    const panelsDir = path.join(pagesDir, '_panels')
    if (!fs.existsSync(pagesDir)) {
      return { ok: false, error: 'Chapter chưa có pages — tải ở Step 3 trước.' }
    }
    const stripFiles = fs.readdirSync(pagesDir)
      .filter(f => /^page_\d+\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .map(f => path.join(pagesDir, f))
    if (stripFiles.length === 0) return { ok: false, error: 'Folder pages trống.' }

    if (fs.existsSync(panelsDir)) {
      try { fs.rmSync(panelsDir, { recursive: true, force: true }) } catch {}
    }

    const onProgress = info => evt.sender.send('chapter:splitPanels:progress', info)
    const panelSplit = require('./video/panelSplit.cjs')
    let result, modeUsed
    if (mode === 'cv') {
      result = await panelSplit.splitChapterPanels({ stripPaths: stripFiles, outDir: panelsDir, opts: opts || {}, onProgress })
      modeUsed = 'cv'
    } else {
      // Default AI mode = batch (1+ chunks, all images in 1 API call per chunk).
      // Per-strip mode kept as fallback if batch fails repeatedly.
      result = await panelSplit.splitChapterPanelsAIBatch({ stripPaths: stripFiles, outDir: panelsDir, opts: opts || {}, onProgress })
      modeUsed = 'ai-batch'
    }
    return { ok: true, data: { ...result, panelsDir, mode: modeUsed } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Read already-downloaded local files as base64 — used by AI voiceover gen
// so it doesn't re-fetch from CDN after Step 3 Download.
ipcMain.handle('chapter:readLocalAsBase64', async (_e, { paths }) => {
  try {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: 'Không có path' }
    }
    const out = []
    const mimeByExt = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp',
      gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif'
    }
    for (const p of paths) {
      const buf = fs.readFileSync(p)
      const ext = path.extname(p).slice(1).toLowerCase()
      const mimeType = mimeByExt[ext] || sniffMimeFromBuffer(buf) || 'image/jpeg'
      out.push({ base64: buf.toString('base64'), mimeType })
    }
    return { ok: true, data: out }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('chapter:download', async (evt, { pageUrls, referer, mangaSlug, chapterSlug, workspaceId }) => {
  if (!Array.isArray(pageUrls) || pageUrls.length === 0) {
    return { ok: false, error: 'Không có URL ảnh để tải' }
  }
  try {
    const cSlug = safeSlug(chapterSlug || 'untitled-chapter')
    let dir
    if (workspaceId) {
      dir = path.join(workspace.workspaceDir(app.getPath('userData'), workspaceId), 'pages', cSlug)
    } else {
      const base = path.join(app.getPath('userData'), 'downloads')
      const mSlug = safeSlug(mangaSlug || 'untitled-manga')
      dir = path.join(base, mSlug, cSlug)
    }
    const localPaths = await downloadPagesToDisk({
      pageUrls, referer, dir,
      onProgress: info => evt.sender.send('chapter:download:progress', info)
    })
    return { ok: true, data: { dir, localPaths } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('plugins:openByUrl', async (_e, { url }) => {
  for (const p of plugins.values()) {
    if (typeof p.parseUrl !== 'function') continue
    const parsed = p.parseUrl(url)
    if (!parsed) continue
    try {
      if (parsed.kind === 'manga') {
        const manga = await p.getManga(parsed.id)
        return { ok: true, data: { pluginId: p.id, kind: 'manga', manga } }
      }
      if (parsed.kind === 'chapter') {
        if (typeof p.getChapter !== 'function') {
          return { ok: false, error: `Plugin ${p.id} chưa hỗ trợ chapter URL` }
        }
        const info = await p.getChapter(parsed.id)
        let manga = null
        if (info.mangaId) {
          try { manga = await p.getManga(info.mangaId) } catch { /* fall through */ }
        }
        return { ok: true, data: { pluginId: p.id, kind: 'chapter', manga, chapter: info.chapter } }
      }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
  return { ok: false, error: 'Không nhận diện được URL (chỉ hỗ trợ mangadex.org/title/... hoặc /chapter/...)' }
})

// Open user plugins folder in OS file explorer. Creates the folder first
// so even on a fresh install the user lands somewhere they can drop files.
ipcMain.handle('plugins:openUserFolder', async () => {
  try {
    const dir = path.join(app.getPath('userData'), 'plugins')
    fs.mkdirSync(dir, { recursive: true })
    // Copy the template + doc on first open so the user has reference files
    // sitting next to where they'll create their own adapters.
    const builtInTemplate = path.join(PLUGINS_DIR, '_template.example.cjs')
    const builtInDoc = path.join(PLUGINS_DIR, 'PLUGINS.md')
    for (const src of [builtInTemplate, builtInDoc]) {
      try {
        const dst = path.join(dir, path.basename(src))
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst)
      } catch {}
    }
    const err = await shell.openPath(dir)
    if (err) return { ok: false, error: err }
    return { ok: true, data: { dir } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ----- Image proxy (so renderer can display via blob to avoid CORS) -----

function sniffMimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return ''
}

ipcMain.handle('image:fetch', async (_e, { url, referer }) => {
  // Use Node fetch (Node 18+ global) instead of electron.net.request — net.request
  // routes through Chromium's network stack which applies built-in adblock
  // filters (URLs with "ad", "banner", "track" trigger ERR_BLOCKED_BY_CLIENT).
  // Node fetch hits raw network with zero filtering.
  let ref = referer
  if (!ref) {
    try { ref = new URL(url).origin + '/' } catch { ref = '' }
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'image/webp,image/avif,image/png,image/jpeg,image/*,*/*;q=0.8',
        'Accept-Language': 'vi,en;q=0.8',
        ...(ref ? { 'Referer': ref } : {})
      }
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    const ctRaw = res.headers.get('content-type') || ''
    const cleanCt = (ctRaw.split(';')[0] || '').trim() || sniffMimeFromBuffer(buf) || 'image/jpeg'
    return {
      ok: true,
      contentType: cleanCt,
      base64: buf.toString('base64')
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ----- AI Review via 9router (OpenAI-compatible) -----
//
// Endpoint priority:
//   1. NINEROUTER_BASE env  (Baru-Manga.bat sets this to localhost for dev)
//   2. Default: yohomin tunnel — sếp's hosted 9router proxy at yohomin.com
//      User installations don't run a local 9router, so production points
//      at the tunnel which sếp pays for. Same default as Baru-YTB.
//      To override per-user (e.g. their own Gemini key direct), Settings
//      UI can write to a persisted config that we load on startup (TODO).

const ROUTER_BASE = process.env.NINEROUTER_BASE || 'https://yohomin.com/v1'

// Vision-capable model preference order. We start with the smallest free-tier
// Gemini and fall back to bigger / older variants if the chosen model is rate
// limited (HTTP 429). Order picked from /v1/models on 2026-05-12.
const VISION_FALLBACK = [
  'gemini/gemini-3.1-flash-lite-preview',
  'gemini/gemini-3-flash-preview',
  'gemini/gemini-2.0-flash-lite',
  'gemini/gemini-3.1-pro-preview',
  'openai/gpt-4o-mini',
  'openai/gpt-4o'
]

function reviewPrompt(language, style, mangaTitle, chapterTitle) {
  const langName = { vi: 'Vietnamese', th: 'Thai', en: 'English', ko: 'Korean', ja: 'Japanese' }[language] || 'English'
  const ctx = []
  if (mangaTitle) ctx.push(`Manga: ${mangaTitle}`)
  if (chapterTitle) ctx.push(`Chapter: ${chapterTitle}`)
  const ctxLine = ctx.length ? ctx.join(' • ') + '\n\n' : ''

  if (style === 'review') {
    return `${ctxLine}You are an experienced manga critic. Analyze the chapter pages provided as images and write a critical review in ${langName}.

Cover these sections (use clear headings in ${langName}):
1. **Plot summary** — what happens in this chapter (concise, 3-5 sentences).
2. **Character moments** — name the characters you recognize from the images and dialogue. What did they do? What does it reveal?
3. **Art & pacing** — panel layout, action flow, expressions. Strong moments vs weak moments.
4. **Critique** — your honest opinion. Is this chapter strong or weak? Why? Score it /10.
5. **What to expect next** — 1-2 sentences predicting the next chapter.

Tone: a knowledgeable reviewer with taste, not a corporate summary. Have opinions. Be specific. Quote dialogue when impactful.`
  }
  return `${ctxLine}You are a manga recap narrator (style: HBO documentary / movie trailer). Watch the chapter pages and write a dramatic recap in ${langName}.

Rules:
- Identify characters by name from dialogue and visual cues. Use names, not "the man / the woman".
- Capture the story flow — don't describe panels one by one.
- Cinematic tone. Vivid verbs. Short punchy sentences mixed with longer flowing ones.
- Include 1-2 impactful direct quotes from characters.
- Output as flowing prose (no bullet points).
- Keep it under 400 words for a typical chapter.`
}

ipcMain.handle('ai:ping', async () => {
  try {
    const res = await fetch(`${ROUTER_BASE}/models`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { ok: false, error: `9router ${res.status}` }
    const data = await res.json()
    return { ok: true, data: { count: (data.data || []).length, base: ROUTER_BASE } }
  } catch (e) {
    return { ok: false, error: `9router không phản hồi tại ${ROUTER_BASE} (${e.message})` }
  }
})

ipcMain.handle('ai:listModels', async () => {
  try {
    const res = await fetch(`${ROUTER_BASE}/models`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { ok: false, error: `9router ${res.status}` }
    const data = await res.json()
    const all = (data.data || []).map(m => m.id)
    // Filter to known-vision-capable models. Gemma + o1-mini + nano variants
    // are text-only and would 400 on image inputs.
    const visionCapable = all.filter(id =>
      /^gemini\/gemini-(3|3\.1|2\.0)/.test(id) ||
      /^openai\/gpt-4o/.test(id) ||
      /^openai\/gpt-4-turbo/.test(id) ||
      /^openai\/gpt-5(\.\d)?(-mini)?$/.test(id) ||
      /^openai\/gpt-4\.1(-mini)?$/.test(id)
    )
    return { ok: true, data: { all, visionCapable } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

async function callRouter(model, body) {
  return fetch(`${ROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model })
  })
}

// Voiceover script prompt — asks the LLM to return a JSON array of segments
// where each segment owns a contiguous panel range. Used by M4 to render
// cinematic video: zoom/pan over the segment's panels while the segment's
// audio plays, then advance.
//
// `style` switches narrator persona:
//   recap   (default) — HBO documentary / movie trailer narrator. Plot focus.
//   critic            — opinionated reviewer, drops a /10 score mid-script.
//   funny             — playful, witty, light jabs at tropes.
//   serious           — straight news report tone, minimal embellishment.
function voiceoverPrompt(language, mangaTitle, chapterTitle, totalPanels, style) {
  const langName = { vi: 'Vietnamese', th: 'Thai', en: 'English', ko: 'Korean', ja: 'Japanese' }[language] || 'English'
  const ctx = []
  if (mangaTitle) ctx.push(`Manga: ${mangaTitle}`)
  if (chapterTitle) ctx.push(`Chapter: ${chapterTitle}`)
  const ctxLine = ctx.length ? ctx.join(' • ') + '\n\n' : ''

  // Style-specific narrator persona block — slots into the prompt where
  // "Voice style:" used to be hardcoded.
  const personaByStyle = {
    recap: `Voice style: HBO documentary / movie trailer narrator. Vivid verbs, dramatic but not over-the-top.
- Use character names from dialogue/visuals when visible. Avoid "the man / the woman".
- Sprinkle 1 impactful direct quote (in ${langName}) across the whole script.
- Don't invent plot — describe what's actually shown.`,
    critic: `Voice style: opinionated manga critic with taste. You're not summarizing, you're REVIEWING.
- Mix narration ("X confronts Y") with judgment ("a beat the writer earns" / "a contrivance the panel layout can't sell").
- Drop your overall score as "X/10" inside ONE segment around the middle of the script (not the first or last segment).
- Use character names from dialogue/visuals. Be specific about what works and what doesn't.
- 1 direct quote (in ${langName}) somewhere in the script.`,
    funny: `Voice style: witty stand-up commentator. Light jabs at tropes, dry observations, occasional self-aware aside.
- Stay grounded in what's actually shown — humor comes from how you frame it, not from inventing gags.
- Use character names. Drop 1 quote (in ${langName}) and play off it.
- No corny puns. No "wow, much wow" memes.`,
    serious: `Voice style: straight news report. Minimal embellishment, no dramatic flair.
- Describe events factually in chronological order. Like a wire-service summary.
- Use character names. 1 direct quote (in ${langName}) is allowed but not required.
- Short, declarative sentences. Avoid metaphors and rhetorical flourishes.`
  }
  const persona = personaByStyle[style] || personaByStyle.recap

  return `${ctxLine}You are a manga recap narrator. Watch the ${totalPanels} chapter pages (provided as images in order) and produce a structured voiceover script in ${langName}.

Output a JSON object exactly matching this schema (no markdown, no commentary):
{
  "segments": [
    {
      "text": "<one sentence or short paragraph in ${langName}>",
      "panelStart": <0-based int, inclusive>,
      "panelEnd":   <0-based int, inclusive>,
      "keyPanels":  [<int>, <int>, ...]
    },
    ...
  ]
}

Rules:
- 5 to 15 segments total. Each segment's [panelStart..panelEnd] is a CONTIGUOUS range, no gaps, no overlaps, covering all ${totalPanels} pages from 0 to ${totalPanels - 1}.
- keyPanels: the FEW strips (usually 1, sometimes 2) that visually nail this segment. Pick the most DETAILED, on-point strip for the narration — don't pad with extras.
  · Default to 1 strip. Use 2 only when one strip alone doesn't capture the moment (e.g. action + reaction shot side-by-side).
  · 3 strips max — only for extended sequences where one frame can't tell the story.
  · If using 2 or 3, they MUST be contiguous: [4,5] not [4,7]. Strictly increasing by 1.
  · Placement follows content: pick the strip(s) WHERE the visuals match the text. Could be at the start, middle, or end of [panelStart..panelEnd]. DO NOT default to the first strip of each range.

  GOOD examples (smaller = better):
    Single key beat → "keyPanels": [4]              ← 1 strip, the detail shot
    Action + reaction → "keyPanels": [7, 8]         ← 2 contiguous
    Extended sequence (rare) → "keyPanels": [9, 10, 11]
  BAD examples:
    Padding with extras → "keyPanels": [0, 1, 2, 3, 4]
    Scattered → "keyPanels": [0, 1, 6, 10]
    Always picking the FIRST strips regardless of where the matching content is
- Each segment's text is 1–3 sentences. When spoken aloud, the duration roughly matches how long viewers should look at that segment.
- ${persona}
- panelStart of segment N must equal panelEnd of segment N-1 plus 1. First segment panelStart=0, last segment panelEnd=${totalPanels - 1}.

Return ONLY the JSON object.`
}

ipcMain.handle('ai:voiceoverScript', async (_e, { model, images, language, mangaTitle, chapterTitle, style }) => {
  console.log('[ai:voiceoverScript] called', {
    imageCount: Array.isArray(images) ? images.length : 0,
    language, style, mangaTitle, chapterTitle,
    routerBase: ROUTER_BASE
  })
  if (!Array.isArray(images) || images.length === 0) {
    return { ok: false, error: 'Không có ảnh để gen script' }
  }
  // Send ALL panels (no sampling) so the AI labels segments using real panel
  // indices that line up with the actual page sequence on disk. With sampling,
  // the AI would label "panels 0-8" referring to its 10 visible images, and
  // the renderer would have to map sample-space → real-space, which is fragile.
  // Hard cap at 100 to keep request size reasonable.
  const usePages = images.length > 100 ? sampleEvenly(images, 100) : images
  const declaredPanels = usePages.length
  const content = [{ type: 'text', text: voiceoverPrompt(language, mangaTitle, chapterTitle, declaredPanels, style) }]
  for (const img of usePages) {
    const mt = /^image\/(jpe?g|png|webp|gif|bmp|avif)$/i.test(img.mimeType || '') ? img.mimeType : 'image/jpeg'
    content.push({ type: 'image_url', image_url: { url: `data:${mt};base64,${img.base64}` } })
  }
  const body = {
    messages: [{ role: 'user', content }],
    temperature: 0.7,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    stream: false
  }

  const candidates = model ? [model, ...VISION_FALLBACK.filter(m => m !== model)] : VISION_FALLBACK
  const tried = []
  for (const m of candidates) {
    try {
      const res = await callRouter(m, body)
      if (res.ok) {
        const data = await res.json()
        const text = data.choices?.[0]?.message?.content || ''
        if (!text) { tried.push({ model: m, status: 'empty' }); continue }
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          // Some models wrap JSON in ```json fences; strip them.
          const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
          if (fenced) {
            try { parsed = JSON.parse(fenced[1]) } catch { /* fall through */ }
          }
          if (!parsed) {
            tried.push({ model: m, status: 'parse-fail', error: text.slice(0, 200) })
            continue
          }
        }
        const segments = Array.isArray(parsed.segments) ? parsed.segments : []
        // Sanitize: ensure ints, contiguous, in range. Plus keyPanels:
        // validate AI's panel picks; if missing/invalid, sample 3 evenly
        // from the segment's range as a sensible default.
        const clean = []
        let nextStart = 0
        for (const s of segments) {
          const start = Math.max(nextStart, Math.floor(Number(s.panelStart) || nextStart))
          const end = Math.min(declaredPanels - 1, Math.max(start, Math.floor(Number(s.panelEnd) || start)))
          const t = String(s.text || '').trim()
          if (!t) continue

          // Validate keyPanels: ints, in [start..end], unique, sorted.
          // Then ENFORCE contiguity: AI sometimes still scatters picks
          // despite prompt rule. Find the longest contiguous run inside
          // the picked set — that's the "cluster" we want.
          let keyPanels = Array.isArray(s.keyPanels)
            ? s.keyPanels
                .map(n => Math.floor(Number(n)))
                .filter(n => Number.isFinite(n) && n >= start && n <= end)
            : []
          keyPanels = Array.from(new Set(keyPanels)).sort((a, b) => a - b)

          // Pick longest contiguous run (consecutive integers)
          if (keyPanels.length > 1) {
            let bestStart = 0
            let bestLen = 1
            let curStart = 0
            let curLen = 1
            for (let k = 1; k < keyPanels.length; k++) {
              if (keyPanels[k] === keyPanels[k - 1] + 1) {
                curLen++
                if (curLen > bestLen) { bestLen = curLen; bestStart = curStart }
              } else {
                curStart = k
                curLen = 1
              }
            }
            keyPanels = keyPanels.slice(bestStart, bestStart + bestLen)
          }

          if (keyPanels.length > 3) keyPanels = keyPanels.slice(0, 3)

          // If AI gave nothing usable, fall back to a single strip near
          // the middle of the segment range.
          if (keyPanels.length === 0) {
            const span = end - start + 1
            const mid = start + Math.floor(span / 2)
            keyPanels.push(mid)
          }

          clean.push({ text: t, panelStart: start, panelEnd: end, keyPanels })
          nextStart = end + 1
          if (nextStart >= declaredPanels) break
        }
        // If last segment doesn't reach the final panel, extend it.
        if (clean.length > 0 && clean[clean.length - 1].panelEnd < declaredPanels - 1) {
          clean[clean.length - 1].panelEnd = declaredPanels - 1
        }
        if (clean.length === 0) {
          tried.push({ model: m, status: 'no-valid-segments' })
          continue
        }
        return {
          ok: true,
          data: {
            segments: clean,
            model: data.model || m,
            pagesUsed: usePages.length,
            pagesTotal: images.length,
            tried
          }
        }
      }
      const errText = await res.text()
      tried.push({ model: m, status: res.status, error: errText.slice(0, 200) })
      if (res.status !== 429 && res.status < 500) {
        return { ok: false, error: `${m} → ${res.status}: ${errText.slice(0, 300)}`, tried }
      }
    } catch (e) {
      tried.push({ model: m, error: e.message })
      console.error('[ai:voiceoverScript] model exception', { model: m, error: e.message })
    }
  }
  console.error('[ai:voiceoverScript] all models failed', { tried })
  return { ok: false, error: `Tất cả ${tried.length} models đều fail. Last: ${tried[tried.length - 1]?.error || tried[tried.length - 1]?.status || 'unknown'}`, tried }
})

ipcMain.handle('ai:review', async (_e, { model, images, language, style, mangaTitle, chapterTitle, maxPages }) => {
  if (!Array.isArray(images) || images.length === 0) {
    return { ok: false, error: 'Không có ảnh để review' }
  }

  // Cap at 200 to avoid runaway requests; clamp min at 1.
  const limit = Math.max(1, Math.min(Number(maxPages) || 60, 200))
  const usePages = images.length > limit ? sampleEvenly(images, limit) : images
  const content = [{ type: 'text', text: reviewPrompt(language, style, mangaTitle, chapterTitle) }]
  for (const img of usePages) {
    // Defensive: validate MIME or fall back. Stops "Unsupported MIME type: i"
    // when upstream sent a malformed Content-Type.
    const mt = /^image\/(jpe?g|png|webp|gif|bmp|avif)$/i.test(img.mimeType || '')
      ? img.mimeType
      : 'image/jpeg'
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mt};base64,${img.base64}` }
    })
  }
  const body = {
    messages: [{ role: 'user', content }],
    temperature: 0.7,
    max_tokens: 2048,
    stream: false  // 9router defaults to SSE; force JSON response so res.json() works
  }

  const candidates = model ? [model, ...VISION_FALLBACK.filter(m => m !== model)] : VISION_FALLBACK
  const tried = []
  for (const m of candidates) {
    try {
      const res = await callRouter(m, body)
      if (res.ok) {
        const data = await res.json()
        const text = data.choices?.[0]?.message?.content || ''
        if (!text) {
          tried.push({ model: m, status: 'empty' })
          continue
        }
        return {
          ok: true,
          data: {
            text,
            model: data.model || m,
            pagesUsed: usePages.length,
            pagesTotal: images.length,
            tried
          }
        }
      }
      const errText = await res.text()
      tried.push({ model: m, status: res.status, error: errText.slice(0, 200) })
      // On 429 / 5xx, try next model. On other 4xx, bail out — likely a code bug
      // not worth burning through models for.
      if (res.status !== 429 && res.status < 500) {
        return { ok: false, error: `${m} → ${res.status}: ${errText.slice(0, 300)}`, tried }
      }
    } catch (e) {
      tried.push({ model: m, error: e.message })
    }
  }
  return { ok: false, error: 'Tất cả models đều fail (429 / lỗi). Check 9router dashboard.', tried }
})

function sampleEvenly(arr, n) {
  if (arr.length <= n) return arr
  const out = []
  const step = (arr.length - 1) / (n - 1)
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)])
  return out
}

// ----- TTS via 9router (Gemini 2.5 TTS) -----
// Endpoint: <base>/audio/speech (OpenAI-compatible)
// Body: { model: 'gemini/gemini-2.5-flash-preview-tts/<voice>', input: '...', prompt?: '...' }
// Auth: Bearer <api_key>
// Response: WAV binary (RIFF...)
// Pattern picked from Baru-YTB's baru_ytb/tts_gemini.py — voice tucks INTO
// the model path, NOT a separate `voice` field (that field is ignored).

const TTS_BYPASS_KEY = process.env.NINEROUTER_API_KEY
  || process.env.BARU_9ROUTER_API_KEY
  || 'sk-yohomin-9router-bypass'

// Google's official voice demos. Hosted at:
//   https://docs.cloud.google.com/static/text-to-speech/docs/audio/chirp3-hd-{slug}.wav
// Slug is voice name lowercased, EXCEPT one Google typo: Aoede → aoeda.
const VOICE_DEMO_BASE = 'https://docs.cloud.google.com/static/text-to-speech/docs/audio/'
const VOICE_DEMO_SLUG_OVERRIDES = {
  Aoede: 'aoeda'
}
function voiceDemoUrl(voiceKey) {
  const slug = VOICE_DEMO_SLUG_OVERRIDES[voiceKey] || voiceKey.toLowerCase()
  return `${VOICE_DEMO_BASE}chirp3-hd-${slug}.wav`
}

const TTS_VOICES = [
  { key: 'Zephyr',        label: 'Zephyr — bright (female)' },
  { key: 'Puck',          label: 'Puck — upbeat (male)' },
  { key: 'Charon',        label: 'Charon — informative (male)' },
  { key: 'Kore',          label: 'Kore — firm (female)' },
  { key: 'Fenrir',        label: 'Fenrir — excitable (male)' },
  { key: 'Leda',          label: 'Leda — youthful (female)' },
  { key: 'Orus',          label: 'Orus — firm (male)' },
  { key: 'Aoede',         label: 'Aoede — breezy (female)' },
  { key: 'Callirrhoe',    label: 'Callirrhoe (female)' },
  { key: 'Autonoe',       label: 'Autonoe (female)' },
  { key: 'Enceladus',     label: 'Enceladus (male)' },
  { key: 'Iapetus',       label: 'Iapetus (male)' },
  { key: 'Umbriel',       label: 'Umbriel (male)' },
  { key: 'Algieba',       label: 'Algieba (male)' },
  { key: 'Despina',       label: 'Despina (female)' },
  { key: 'Erinome',       label: 'Erinome (female)' },
  { key: 'Algenib',       label: 'Algenib (male)' },
  { key: 'Rasalgethi',    label: 'Rasalgethi (male)' },
  { key: 'Laomedeia',     label: 'Laomedeia (female)' },
  { key: 'Achernar',      label: 'Achernar (female)' },
  { key: 'Alnilam',       label: 'Alnilam (male)' },
  { key: 'Schedar',       label: 'Schedar (male)' },
  { key: 'Gacrux',        label: 'Gacrux (female)' },
  { key: 'Pulcherrima',   label: 'Pulcherrima (female)' },
  { key: 'Achird',        label: 'Achird (male)' },
  { key: 'Zubenelgenubi', label: 'Zubenelgenubi (male)' },
  { key: 'Vindemiatrix',  label: 'Vindemiatrix (female)' },
  { key: 'Sadachbia',     label: 'Sadachbia (male)' },
  { key: 'Sadaltager',    label: 'Sadaltager (male)' },
  { key: 'Sulafat',       label: 'Sulafat (female)' }
]

const TTS_MODELS = [
  { key: 'gemini/gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS (mặc định, nhanh)' },
  { key: 'gemini/gemini-2.5-pro-preview-tts',   label: 'Gemini 2.5 Pro TTS (chất lượng cao, chậm)' }
]

ipcMain.handle('tts:meta', async () => ({
  ok: true,
  data: {
    voices: TTS_VOICES.map(v => ({ ...v, demoUrl: voiceDemoUrl(v.key) })),
    models: TTS_MODELS,
    defaultVoice: 'Charon',
    defaultModel: 'gemini/gemini-2.5-flash-preview-tts'
  }
}))

/**
 * Raw 9router /audio/speech call. Returns a Buffer of WAV bytes on success,
 * or throws with a clear error message. Shared between `tts:speak` (single
 * preview call) and `tts:speakBatch` (cached bulk render in M4).
 */
// Normalize short language code (vi, th, en, ko, ja) → BCP-47 (vi-VN, ...).
// Gemini TTS requires full locale tag; short codes silently fall back to
// en-US, which is why Vietnamese text was being read with an English
// accent that varied per call (Gemini's English voice realizing VN
// sounds inconsistently).
function normalizeBcp47(code) {
  if (!code) return 'en-US'
  const c = String(code).trim()
  if (/^[a-z]{2}-[A-Z]{2}$/.test(c)) return c // already BCP-47
  const map = {
    vi: 'vi-VN',
    th: 'th-TH',
    en: 'en-US',
    ko: 'ko-KR',
    ja: 'ja-JP',
    zh: 'zh-CN',
    id: 'id-ID'
  }
  return map[c.toLowerCase()] || c
}

async function fetchTtsWav({ text, voice, model, language, stylePrompt }) {
  const v = (voice || 'Charon').trim()
  const m = (model || 'gemini/gemini-2.5-flash-preview-tts').trim()
  const modelWithVoice = `${m.replace(/\/$/, '')}/${v}`
  const langCode = normalizeBcp47(language)
  const payload = { model: modelWithVoice, input: text, language: langCode }
  if (stylePrompt && stylePrompt.trim()) payload.prompt = stylePrompt.trim()
  console.log('[fetchTtsWav]', { voice: v, model: m, language: langCode, textPreview: text.slice(0, 50) })

  const res = await fetch(`${ROUTER_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TTS_BYPASS_KEY}`
    },
    body: JSON.stringify(payload)
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`TTS HTTP ${res.status}: ${errText.slice(0, 300)}`)
  }
  const ab = await res.arrayBuffer()
  const buf = Buffer.from(ab)
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error(`TTS không trả WAV (first 12 bytes: ${buf.slice(0, 12).toString('hex')})`)
  }
  return buf
}

ipcMain.handle('tts:speak', async (_e, { text, voice, model, stylePrompt, language, savePath }) => {
  const trimmed = (text || '').trim()
  if (!trimmed) return { ok: false, error: 'Text rỗng' }
  try {
    const buf = await fetchTtsWav({ text: trimmed, voice, model, language, stylePrompt })
    let writtenPath
    if (savePath) {
      fs.mkdirSync(path.dirname(savePath), { recursive: true })
      fs.writeFileSync(savePath, buf)
      writtenPath = savePath
    }
    return {
      ok: true,
      data: {
        bytes: buf.length,
        base64: buf.toString('base64'),
        savedTo: writtenPath || null,
        model: (model || 'gemini/gemini-2.5-flash-preview-tts').trim(),
        voice: (voice || 'Charon').trim()
      }
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

/**
 * Bulk TTS render for video pipeline. Each segment is keyed by SHA256 hash of
 * (text|voice|model|language); cache hits skip the network call. Streams
 * progress events via `tts:speakBatch:progress` so the renderer can show
 * a live count of done/cached/total.
 *
 * Returns: { segments: [{ index, panelStart, panelEnd, text, path, hash, bytes, cached }] }
 */
ipcMain.handle('tts:speakBatch', async (evt, { segments, voice, model, language }) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, error: 'Không có segments để render TTS' }
  }
  const v = (voice || 'Charon').trim()
  const m = (model || 'gemini/gemini-2.5-flash-preview-tts').trim()
  const lang = normalizeBcp47(language)
  const baseDir = path.join(app.getPath('userData'), 'video-cache')

  const out = []
  let cacheHits = 0
  let networkCalls = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] || {}
    const text = String(seg.text || '').trim()
    if (!text) continue
    try {
      const result = await ttsCache.getOrFetch(
        { text, voice: v, model: m, language: lang, baseDir },
        () => fetchTtsWav({ text, voice: v, model: m, language: lang })
      )
      if (result.cached) cacheHits++; else networkCalls++
      out.push({
        index: i,
        panelStart: Number(seg.panelStart) || 0,
        panelEnd: Number(seg.panelEnd) || 0,
        text,
        path: result.path,
        hash: result.hash,
        bytes: result.bytes,
        cached: result.cached
      })
      evt.sender.send('tts:speakBatch:progress', {
        i: i + 1,
        total: segments.length,
        cached: result.cached,
        hash: result.hash,
        bytes: result.bytes
      })
    } catch (e) {
      return { ok: false, error: `Segment #${i + 1}: ${e.message}`, partial: out }
    }
  }
  return {
    ok: true,
    data: {
      segments: out,
      baseDir,
      cacheHits,
      networkCalls,
      total: segments.length
    }
  }
})

ipcMain.handle('tts:cacheStats', async () => {
  const baseDir = path.join(app.getPath('userData'), 'video-cache')
  return { ok: true, data: ttsCache.stats(baseDir) }
})

ipcMain.handle('tts:cacheClear', async () => {
  const baseDir = path.join(app.getPath('userData'), 'video-cache')
  return { ok: true, data: { removed: ttsCache.clear(baseDir) } }
})

// ----- M4.3 Video Render Orchestrator -----
// End-to-end: download pages → TTS batch (cached) → per-segment cinematic clip
// → concat → final MP4. Streams `video:render:progress` events at every phase.

ipcMain.handle('video:render', async (evt, opts) => {
  const {
    pageUrls,
    referer,
    segments,
    voice,
    model,
    language,
    mangaSlug,
    chapterSlug
  } = opts || {}

  if (!Array.isArray(pageUrls) || pageUrls.length === 0) {
    return { ok: false, error: 'Không có pageUrls' }
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, error: 'Không có voiceover segments — bấm "Tạo voiceover" trước' }
  }

  const mSlug = safeSlug(mangaSlug || 'manga')
  const cSlug = safeSlug(chapterSlug || 'chapter')
  const vSlug = safeSlug(voice || 'charon')
  const v = (voice || 'Charon').trim()
  const m = (model || 'gemini/gemini-2.5-flash-preview-tts').trim()
  const lang = normalizeBcp47(language)

  const userData = app.getPath('userData')
  const downloadsDir = path.join(userData, 'downloads', mSlug, cSlug)
  const cacheBaseDir = path.join(userData, 'video-cache')
  const clipsDir = path.join(cacheBaseDir, 'clips', `${mSlug}__${cSlug}`)
  const videosDir = path.join(userData, 'videos')
  const finalOut = path.join(videosDir, `${mSlug}__${cSlug}__${vSlug}.mp4`)

  fs.mkdirSync(clipsDir, { recursive: true })
  fs.mkdirSync(videosDir, { recursive: true })

  const progress = info => evt.sender.send('video:render:progress', info)

  try {
    // ── Phase 1: download all pages
    progress({ phase: 'download', i: 0, total: pageUrls.length, msg: 'Bắt đầu tải panels...' })
    const localPaths = await downloadPagesToDisk({
      pageUrls,
      referer,
      dir: downloadsDir,
      onProgress: info => progress({ phase: 'download', ...info })
    })

    // Validate panel ranges against actual download count
    for (const seg of segments) {
      if (seg.panelStart < 0 || seg.panelEnd >= localPaths.length || seg.panelStart > seg.panelEnd) {
        return { ok: false, error: `Segment "${seg.text.slice(0, 40)}..." có panel range [${seg.panelStart}-${seg.panelEnd}] ngoài phạm vi (max ${localPaths.length - 1})` }
      }
    }

    // ── Phase 2: TTS batch with cache
    progress({ phase: 'tts', i: 0, total: segments.length, msg: 'Synthesize voice...' })
    const ttsResults = []
    let cacheHits = 0
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const text = String(seg.text || '').trim()
      if (!text) continue
      const result = await ttsCache.getOrFetch(
        { text, voice: v, model: m, language: lang, baseDir: cacheBaseDir },
        () => fetchTtsWav({ text, voice: v, model: m, language: lang })
      )
      if (result.cached) cacheHits++
      ttsResults.push({
        segmentIdx: i,
        text,
        panelStart: seg.panelStart,
        panelEnd: seg.panelEnd,
        keyPanels: Array.isArray(seg.keyPanels) ? seg.keyPanels : null,
        keyRegions: Array.isArray(seg.keyRegions) ? seg.keyRegions : null,
        audioPath: result.path,
        hash: result.hash,
        cached: result.cached
      })
      progress({ phase: 'tts', i: i + 1, total: segments.length, cached: result.cached, hash: result.hash })
    }

    // ── Phase 3: render per-segment cinematic clip
    progress({ phase: 'render', i: 0, total: ttsResults.length, msg: 'Render cinematic clips...' })
    const clipPaths = []
    for (let i = 0; i < ttsResults.length; i++) {
      const r = ttsResults[i]
      let panelIdxs
      if (Array.isArray(r.keyPanels) && r.keyPanels.length > 0) {
        panelIdxs = r.keyPanels.filter(idx => idx >= 0 && idx < localPaths.length)
      } else {
        panelIdxs = []
        for (let p = r.panelStart; p <= r.panelEnd; p++) panelIdxs.push(p)
      }
      const panels = panelIdxs.map(idx => localPaths[idx])
      const clipOut = path.join(clipsDir, `seg_${String(r.segmentIdx).padStart(3, '0')}.mp4`)
      await cinematic.renderSegmentClip({
        panelPaths: panels,
        audioPath: r.audioPath,
        captionText: r.text,
        outPath: clipOut
      })
      clipPaths.push(clipOut)
      progress({ phase: 'render', i: i + 1, total: ttsResults.length })
    }

    // ── Phase 4: concat clips → final MP4
    progress({ phase: 'concat', msg: 'Ghép thành MP4 cuối...' })
    await cinematic.concatClips({ clipPaths, outPath: finalOut })
    progress({ phase: 'done', outPath: finalOut })

    return {
      ok: true,
      data: {
        outPath: finalOut,
        segments: ttsResults.length,
        ttsHits: cacheHits,
        ttsCalls: ttsResults.length - cacheHits,
        clipsDir,
        bytes: fs.statSync(finalOut).size
      }
    }
  } catch (e) {
    progress({ phase: 'error', error: e.message })
    return { ok: false, error: e.message }
  }
})

// ----- M4.4 Video Render Batch (multi-chapter concat into 1 MP4) -----
// Loops over each chapter: download → TTS → render clips. After ALL chapters
// done, single ffmpeg concat across every clip → 1 final MP4. Progress events
// carry chapterIdx/chapterTotal so UI can show "ch 2/5 · render 4/7".

ipcMain.handle('video:renderBatch', async (evt, opts) => {
  const {
    chapters,
    referer,
    voice,
    model,
    language,
    mangaSlug,
    workspaceId,
    subtitleStyle,
    subtitleEnabled
  } = opts || {}

  if (!Array.isArray(chapters) || chapters.length === 0) {
    return { ok: false, error: 'Không có chapters' }
  }
  for (const ch of chapters) {
    if (!Array.isArray(ch.pageUrls) || ch.pageUrls.length === 0) {
      return { ok: false, error: `Chapter "${ch.chapterSlug}" không có pageUrls` }
    }
    if (!Array.isArray(ch.segments) || ch.segments.length === 0) {
      return { ok: false, error: `Chapter "${ch.chapterSlug}" không có segments` }
    }
  }

  const mSlug = safeSlug(mangaSlug || 'manga')
  const vSlug = safeSlug(voice || 'charon')
  const v = (voice || 'Charon').trim()
  const m = (model || 'gemini/gemini-2.5-flash-preview-tts').trim()
  const lang = normalizeBcp47(language)

  const userData = app.getPath('userData')
  // Per-workspace layout (preferred) — all derived artifacts land inside the
  // workspace folder. Without workspaceId, fall back to legacy global dirs.
  let cacheBaseDir, videosDir, perChapterDownloadsRoot, perChapterClipsRoot
  if (workspaceId) {
    const wsRoot = workspace.ensureWorkspaceLayout(userData, workspaceId)
    cacheBaseDir = path.join(wsRoot, 'tts')   // TTS cache scoped to this manga
    videosDir = path.join(wsRoot, 'videos')
    perChapterDownloadsRoot = path.join(wsRoot, 'pages')
    perChapterClipsRoot = path.join(wsRoot, 'clips')
  } else {
    cacheBaseDir = path.join(userData, 'video-cache')
    videosDir = path.join(userData, 'videos')
    perChapterDownloadsRoot = path.join(userData, 'downloads', mSlug)
    perChapterClipsRoot = path.join(cacheBaseDir, 'clips')
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const finalOut = path.join(videosDir, `${mSlug}__multi${chapters.length}__${vSlug}__${stamp}.mp4`)

  fs.mkdirSync(videosDir, { recursive: true })

  const progress = info => evt.sender.send('video:render:progress', info)
  const allClips = []
  const segmentTimings = []
  let totalCacheHits = 0
  let totalTtsCalls = 0

  try {
    for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
      const ch = chapters[chapterIdx]
      const cSlug = safeSlug(ch.chapterSlug || `chapter${chapterIdx + 1}`)
      const downloadsDir = path.join(perChapterDownloadsRoot, cSlug)
      const clipsDir = workspaceId
        ? path.join(perChapterClipsRoot, cSlug)
        : path.join(perChapterClipsRoot, `${mSlug}__${cSlug}`)
      fs.mkdirSync(clipsDir, { recursive: true })

      const chIdxOut = chapterIdx + 1
      const chTotal = chapters.length

      // Phase 1: download pages
      progress({ phase: 'download', chapterIdx: chIdxOut, chapterTotal: chTotal, i: 0, total: ch.pageUrls.length, msg: `Tải ${cSlug}...` })
      const localPaths = await downloadPagesToDisk({
        pageUrls: ch.pageUrls,
        referer,
        dir: downloadsDir,
        onProgress: info => progress({ phase: 'download', chapterIdx: chIdxOut, chapterTotal: chTotal, ...info })
      })

      // Validate panel ranges
      for (const seg of ch.segments) {
        if (seg.panelStart < 0 || seg.panelEnd >= localPaths.length || seg.panelStart > seg.panelEnd) {
          return { ok: false, error: `Ch ${cSlug}: segment "${String(seg.text).slice(0, 40)}..." panel [${seg.panelStart}-${seg.panelEnd}] ngoài range (max ${localPaths.length - 1})` }
        }
      }

      // Phase 2: TTS batch
      progress({ phase: 'tts', chapterIdx: chIdxOut, chapterTotal: chTotal, i: 0, total: ch.segments.length, msg: 'Synthesize voice...' })
      const ttsResults = []
      for (let i = 0; i < ch.segments.length; i++) {
        const seg = ch.segments[i]
        const text = String(seg.text || '').trim()
        if (!text) continue
        const result = await ttsCache.getOrFetch(
          { text, voice: v, model: m, language: lang, baseDir: cacheBaseDir },
          () => fetchTtsWav({ text, voice: v, model: m, language: lang })
        )
        if (result.cached) totalCacheHits++; else totalTtsCalls++
        ttsResults.push({
          segmentIdx: i,
          text,
          panelStart: seg.panelStart,
          panelEnd: seg.panelEnd,
          keyPanels: Array.isArray(seg.keyPanels) ? seg.keyPanels : null,
          audioPath: result.path,
          hash: result.hash,
          cached: result.cached
        })
        progress({ phase: 'tts', chapterIdx: chIdxOut, chapterTotal: chTotal, i: i + 1, total: ch.segments.length, cached: result.cached, hash: result.hash })
      }

      // Phase 3: render clips. New approach — vstack the strips AI picked
      // for this segment (keyPanels), then vertically scroll across the
      // combined image during the audio. Avoids strobe + handles
      // multi-panel strips naturally (whole strip scrolls past camera).
      progress({ phase: 'render', chapterIdx: chIdxOut, chapterTotal: chTotal, i: 0, total: ttsResults.length, msg: 'Render scroll clips...' })
      for (let i = 0; i < ttsResults.length; i++) {
        const r = ttsResults[i]
        let panelIndices
        if (Array.isArray(r.keyPanels) && r.keyPanels.length > 0) {
          panelIndices = r.keyPanels.filter(idx => idx >= 0 && idx < localPaths.length)
        } else {
          panelIndices = []
          for (let p = r.panelStart; p <= r.panelEnd; p++) panelIndices.push(p)
        }
        const strips = panelIndices.map(idx => localPaths[idx])
        console.log(`[renderBatch] segment ${i}: range [${r.panelStart}..${r.panelEnd}], strips [${panelIndices.join(',')}] = ${strips.length} file, text="${(r.text || '').slice(0, 60)}..."`)
        if (strips.length === 0) {
          console.warn(`[renderBatch] segment ${i} has 0 strips! (range start=${r.panelStart}, end=${r.panelEnd}, keyPanels=${JSON.stringify(r.keyPanels)}, localPaths length=${localPaths.length})`)
        }
        const clipOut = path.join(clipsDir, `seg_${String(r.segmentIdx).padStart(3, '0')}.mp4`)
        await cinematic.renderSegmentScroll({
          stripPaths: strips,
          audioPath: r.audioPath,
          outPath: clipOut
        })
        allClips.push(clipOut)
        // Track segment timing for later subtitle overlay step
        const dur = await cinematic.probeDuration(r.audioPath)
        segmentTimings.push({
          chapterIdx: chIdxOut,
          chapterSlug: cSlug,
          segmentIdx: r.segmentIdx,
          panelStart: r.panelStart,
          panelEnd: r.panelEnd,
          text: r.text,
          duration: dur
        })
        progress({ phase: 'render', chapterIdx: chIdxOut, chapterTotal: chTotal, i: i + 1, total: ttsResults.length })
      }
    }

    // Final concat — all clips from all chapters in order
    progress({ phase: 'concat', msg: `Ghép ${allClips.length} clip → 1 MP4...` })
    await cinematic.concatClips({ clipPaths: allClips, outPath: finalOut })

    // Compute cumulative start/end seconds per segment for later subtitle
    // overlay step. Segments concatenated in order, so each one's startSec is
    // the running sum of previous durations.
    const timings = []
    let cursor = 0
    for (const t of segmentTimings) {
      timings.push({
        chapterIdx: t.chapterIdx,
        chapterSlug: t.chapterSlug,
        segmentIdx: t.segmentIdx,
        startSec: cursor,
        endSec: cursor + t.duration,
        text: t.text,
        panelStart: t.panelStart,
        panelEnd: t.panelEnd
      })
      cursor += t.duration
    }

    // Persist timings JSON next to the base video so overlay step can find them.
    try {
      const stampForJson = path.basename(finalOut, '.mp4')
      const timingsPath = path.join(videosDir, `${stampForJson}.timings.json`)
      fs.writeFileSync(timingsPath, JSON.stringify({ version: 1, timings, totalDuration: cursor }, null, 2))
    } catch (e) {
      console.warn('[renderBatch] failed to persist timings:', e.message)
    }

    progress({ phase: 'done', outPath: finalOut })

    return {
      ok: true,
      data: {
        outPath: finalOut,
        chapters: chapters.length,
        segments: allClips.length,
        ttsHits: totalCacheHits,
        ttsCalls: totalTtsCalls,
        bytes: fs.statSync(finalOut).size,
        timings,
        totalDuration: cursor
      }
    }
  } catch (e) {
    progress({ phase: 'error', error: e.message })
    return { ok: false, error: e.message }
  }
})

// ----- Subtitle overlay (Step 7) -----
// Takes the base MP4 from renderBatch + segment timings + style → emits a
// new MP4 with subtitles burned in via libass. Also writes the SRT sidecar
// so the user can ship it separately to YouTube auto-CC.

ipcMain.handle('video:overlaySubtitle', async (_e, opts) => {
  const { workspaceId, baseMp4Path, timings, subtitleStyle, mangaSlug } = opts || {}
  if (!baseMp4Path || !fs.existsSync(baseMp4Path)) {
    return { ok: false, error: `Base MP4 không tồn tại: ${baseMp4Path}` }
  }
  if (!Array.isArray(timings) || timings.length === 0) {
    return { ok: false, error: 'Thiếu timings — render base trước (Step 6)' }
  }
  try {
    const userData = app.getPath('userData')
    let videosDir, srtDir
    if (workspaceId) {
      const wsRoot = workspace.ensureWorkspaceLayout(userData, workspaceId)
      videosDir = path.join(wsRoot, 'videos')
      srtDir = path.join(wsRoot, 'voiceover')
    } else {
      videosDir = path.join(userData, 'videos')
      srtDir = videosDir
    }
    fs.mkdirSync(videosDir, { recursive: true })
    fs.mkdirSync(srtDir, { recursive: true })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const mSlug = safeSlug(mangaSlug || 'manga')
    const srtPath = path.join(srtDir, `${mSlug}__${stamp}.srt`)
    const outPath = path.join(videosDir, `${mSlug}__withsub__${stamp}.mp4`)

    const maxChars = Number(subtitleStyle?.maxCharsPerChunk) || 60
    const srt = cinematic.buildSrt(timings, { maxChars })
    fs.writeFileSync(srtPath, srt, 'utf-8')

    await cinematic.overlaySubtitleOnVideo({
      inputPath: baseMp4Path,
      srtPath,
      outPath,
      subtitleStyle: subtitleStyle || {}
    })

    return {
      ok: true,
      data: {
        outPath,
        srtPath,
        bytes: fs.statSync(outPath).size
      }
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ----- License auth (yohomin.com) -----
// Mirrors Baru-YTB's flow: device_id UUID + verify key with server + persist
// status. Renderer hits these to gate the main UI.

ipcMain.handle('license:status', async () => {
  try {
    return { ok: true, data: await license.getStatus(app.getPath('userData')) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('license:setKey', async (_e, { key }) => {
  try {
    return { ok: true, data: await license.setKey(key, app.getPath('userData')) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('license:clear', async () => {
  try {
    return { ok: true, data: license.clear(app.getPath('userData')) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('license:deviceId', async () => {
  return { ok: true, data: { deviceId: license.getDeviceId(app.getPath('userData')) } }
})

// ----- Workspace (1 manga = 1 saved series) -----

ipcMain.handle('workspace:list', async () => {
  try { return { ok: true, data: workspace.listSummaries(app.getPath('userData')) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('workspace:get', async (_e, { id }) => {
  try { return { ok: true, data: workspace.get(app.getPath('userData'), id) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('workspace:create', async (_e, input) => {
  try { return { ok: true, data: workspace.create(app.getPath('userData'), input) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('workspace:update', async (_e, { id, patch }) => {
  try { return { ok: true, data: workspace.update(app.getPath('userData'), id, patch) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('workspace:delete', async (_e, { id }) => {
  try { return { ok: true, data: workspace.remove(app.getPath('userData'), id) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('workspace:upsertChapter', async (_e, { workspaceId, chapter }) => {
  try { return { ok: true, data: workspace.upsertChapter(app.getPath('userData'), workspaceId, chapter) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('workspace:removeChapter', async (_e, { workspaceId, chapterId }) => {
  try { return { ok: true, data: workspace.removeChapter(app.getPath('userData'), workspaceId, chapterId) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('video:openFolder', async (_e, { videoPath }) => {
  // Reveal in Explorer / Finder
  try {
    require('electron').shell.showItemInFolder(videoPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
