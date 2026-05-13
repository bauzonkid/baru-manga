/**
 * Local plugin — read manga from local folder or CBZ file.
 * Each subfolder of root = a chapter; if root has only images, root itself = a chapter.
 */
const fs = require('fs')
const path = require('path')
const { dialog } = require('electron')

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

function listImages(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(f => path.join(dir, f))
}

function listSubfolders(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map(name => ({ name, full: path.join(dir, name) }))
    .filter(e => fs.statSync(e.full).isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

// Library is in-memory: opened folders this session
const library = new Map() // mangaId -> { rootDir, chapters }

async function openLocal(parentWindow) {
  const r = await dialog.showOpenDialog(parentWindow, {
    properties: ['openDirectory'],
    title: 'Chọn folder manga (gốc chứa các chương, hoặc chỉ chứa ảnh)'
  })
  if (r.canceled || !r.filePaths[0]) return null
  const root = r.filePaths[0]
  const name = path.basename(root)
  const subs = listSubfolders(root)
  const chapters = []
  if (subs.length > 0) {
    for (let i = 0; i < subs.length; i++) {
      const pages = listImages(subs[i].full)
      if (pages.length === 0) continue
      chapters.push({
        id: `${root}::${subs[i].name}`,
        number: String(i + 1),
        title: subs[i].name,
        language: 'unknown',
        pageCount: pages.length,
        _dir: subs[i].full
      })
    }
  } else {
    const pages = listImages(root)
    if (pages.length > 0) {
      chapters.push({
        id: `${root}::__root__`,
        number: '1',
        title: name,
        language: 'unknown',
        pageCount: pages.length,
        _dir: root
      })
    }
  }
  if (chapters.length === 0) return null
  const mangaId = `local::${root}`
  library.set(mangaId, { rootDir: root, chapters })
  return {
    id: mangaId,
    title: name,
    description: `${chapters.length} chương từ ${root}`,
    tags: ['local']
  }
}

async function search() {
  // Local plugin doesn't support search; return cached manga only
  return [...library.entries()].map(([id, m]) => ({
    id,
    title: path.basename(m.rootDir),
    description: `${m.chapters.length} chương từ ${m.rootDir}`,
    tags: ['local']
  }))
}

async function getManga(id) {
  const m = library.get(id)
  if (!m) throw new Error(`Local manga not loaded: ${id}`)
  return {
    id,
    title: path.basename(m.rootDir),
    description: `${m.chapters.length} chương`,
    tags: ['local']
  }
}

async function getChapters(mangaId) {
  const m = library.get(mangaId)
  if (!m) return []
  return m.chapters.map(({ _dir, ...rest }) => rest)
}

async function getPages(chapterId) {
  for (const [, m] of library) {
    const ch = m.chapters.find(c => c.id === chapterId)
    if (ch) {
      const files = listImages(ch._dir)
      return files.map((f, i) => ({ url: `file://${f.replace(/\\/g, '/')}`, index: i }))
    }
  }
  return []
}

module.exports = {
  id: 'local',
  name: 'Local Folder',
  capabilities: { search: false, openLocal: true },
  openLocal,
  search,
  getManga,
  getChapters,
  getPages
}
