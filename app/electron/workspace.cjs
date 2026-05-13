/**
 * Workspace storage — 1 manga = 1 workspace.
 *
 * Persists to <userData>/workspaces.json as a single JSON array. Each entry:
 *
 *   {
 *     id:           uuid
 *     title:        "Đồ Đệ Của Ta Đều Là Đại Phản Phái"
 *     cover:        url or null
 *     source:       { pluginId, mangaId, url }
 *     defaults:     { voice, model, language, style? }
 *     chapters: [
 *       {
 *         id:           chapterId from plugin
 *         number:       "1"
 *         title:        "Khởi đầu"
 *         language:     "vi-VN"
 *         pageCount:    79
 *         pageUrls:     [string]   // cached so we don't re-fetch from plugin
 *         segments:     [{ text, panelStart, panelEnd }] | null
 *         mp4Path:      string | null
 *         ttsHits:      number
 *         renderedAt:   ISO string | null
 *         status:       'pending' | 'voiceover' | 'rendered' | 'error'
 *         updatedAt:    ISO string
 *       }
 *     ]
 *     createdAt:    ISO
 *     updatedAt:    ISO
 *   }
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function storePath(userData) {
  return path.join(userData, 'workspaces.json')
}

function loadAll(userData) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(userData), 'utf-8'))
    return Array.isArray(data.workspaces) ? data.workspaces : []
  } catch { return [] }
}

function saveAll(userData, items) {
  const p = storePath(userData)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ version: 1, workspaces: items }, null, 2))
}

/** Light summary for Home grid. */
function listSummaries(userData) {
  return loadAll(userData).map(w => ({
    id: w.id,
    title: w.title,
    cover: w.cover || null,
    source: w.source,
    chapterCount: (w.chapters || []).length,
    renderedCount: (w.chapters || []).filter(c => c.status === 'rendered').length,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt
  })).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

function get(userData, id) {
  return loadAll(userData).find(w => w.id === id) || null
}

function create(userData, input) {
  const items = loadAll(userData)
  const now = new Date().toISOString()
  const ws = {
    id: crypto.randomUUID(),
    title: input.title || 'Untitled',
    cover: input.cover || null,
    source: input.source || null,
    defaults: input.defaults || {
      voice: 'Charon',
      model: 'gemini/gemini-2.5-flash-preview-tts',
      language: 'vi',
      style: 'recap'
    },
    chapters: input.chapters || [],
    createdAt: now,
    updatedAt: now
  }
  items.push(ws)
  saveAll(userData, items)
  return ws
}

function update(userData, id, patch) {
  const items = loadAll(userData)
  const idx = items.findIndex(w => w.id === id)
  if (idx === -1) throw new Error('workspace_not_found')
  items[idx] = { ...items[idx], ...patch, id, updatedAt: new Date().toISOString() }
  saveAll(userData, items)
  return items[idx]
}

function remove(userData, id) {
  const items = loadAll(userData)
  const next = items.filter(w => w.id !== id)
  if (next.length === items.length) throw new Error('workspace_not_found')
  saveAll(userData, next)
  return { removed: true }
}

/**
 * Upsert chapter info. Used both when:
 *   - we discover chapters via plugin (status='pending')
 *   - we save voiceover segments (status='voiceover')
 *   - we finish rendering (status='rendered', mp4Path)
 */
function upsertChapter(userData, workspaceId, chapter) {
  const items = loadAll(userData)
  const ws = items.find(w => w.id === workspaceId)
  if (!ws) throw new Error('workspace_not_found')
  ws.chapters = ws.chapters || []
  const idx = ws.chapters.findIndex(c => c.id === chapter.id)
  const now = new Date().toISOString()
  if (idx === -1) {
    ws.chapters.push({ status: 'pending', updatedAt: now, ...chapter })
  } else {
    ws.chapters[idx] = { ...ws.chapters[idx], ...chapter, updatedAt: now }
  }
  ws.updatedAt = now
  saveAll(userData, items)
  return ws
}

function removeChapter(userData, workspaceId, chapterId) {
  const items = loadAll(userData)
  const ws = items.find(w => w.id === workspaceId)
  if (!ws) throw new Error('workspace_not_found')
  ws.chapters = (ws.chapters || []).filter(c => c.id !== chapterId)
  ws.updatedAt = new Date().toISOString()
  saveAll(userData, items)
  return ws
}

module.exports = {
  listSummaries,
  get,
  create,
  update,
  remove,
  upsertChapter,
  removeChapter
}
