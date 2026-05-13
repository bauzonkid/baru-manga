/**
 * Series view — workspace detail.
 *
 * Layout:
 *   - Header: cover + title + alt titles + tags + defaults summary
 *   - Toolbar: [Pull chapters] [Series settings] [Delete]
 *   - Chapter list: status badge + actions per row
 */

import { useCallback, useEffect, useState } from 'react'

interface ChapterEntry {
  id: string
  number: string
  title?: string
  language?: string
  pageCount?: number
  status: 'pending' | 'voiceover' | 'rendered' | 'error'
  segments?: unknown
  mp4Path?: string | null
  ttsHits?: number
  renderedAt?: string | null
  updatedAt?: string
}

interface Workspace {
  id: string
  title: string
  cover: string | null
  source: { pluginId: string; mangaId: string; url?: string } | null
  defaults: {
    voice: string
    model: string
    language: string
    style?: string
  }
  chapters: ChapterEntry[]
  createdAt: string
  updatedAt: string
}

interface SeriesViewProps {
  wsId: string
  onBack: () => void
  onOpenChapter: (chapterId: string) => void
  onDeleted: () => void
}

export default function SeriesView({ wsId, onBack, onOpenChapter, onDeleted }: SeriesViewProps) {
  const [ws, setWs] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const [pullSummary, setPullSummary] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!window.api?.workspace) return
    const r = await window.api.workspace.get(wsId)
    setLoading(false)
    if (r.ok) setWs(r.data)
    else setError(r.error)
  }, [wsId])

  useEffect(() => { refresh() }, [refresh])

  const handlePullChapters = async () => {
    if (!ws?.source || !window.api?.plugins || !window.api?.workspace) return
    setPulling(true)
    setError(null)
    setPullSummary(null)
    const r = await window.api.plugins.getChapters(ws.source.pluginId, ws.source.mangaId, { lang: ws.defaults.language })
    if (!r.ok) {
      setPulling(false)
      setError(r.error)
      return
    }
    const fetched = r.data
    const existingIds = new Set(ws.chapters.map(c => c.id))
    let added = 0
    for (const c of fetched) {
      if (existingIds.has(c.id)) continue
      await window.api.workspace.upsertChapter(wsId, {
        id: c.id,
        number: c.number,
        title: c.title,
        language: c.language,
        pageCount: c.pageCount,
        status: 'pending'
      })
      added++
    }
    setPulling(false)
    setPullSummary(`Sync xong: thêm ${added} chapter mới (${fetched.length} từ source, ${ws.chapters.length} đã có).`)
    refresh()
  }

  const handleDelete = async () => {
    if (!ws || !window.api?.workspace) return
    if (!confirm(`Xoá workspace "${ws.title}"?\nMọi chapter rendered (MP4) trên disk vẫn còn — chỉ xoá entry trong app.`)) return
    const r = await window.api.workspace.delete(ws.id)
    if (r.ok) onDeleted()
    else setError(r.error)
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-bg">
        <div className="text-muted text-sm">Đang load workspace...</div>
      </div>
    )
  }
  if (error || !ws) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-bg gap-3">
        <div className="text-rose-400">{error || 'Không tìm thấy workspace'}</div>
        <button onClick={onBack} className="btn-ghost text-sm py-2 px-4">← Home</button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Top bar */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-panel/40">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-sm text-muted hover:text-zinc-100">← Home</button>
          <div>
            <h1 className="font-semibold text-sm">{ws.title}</h1>
            <p className="text-xs text-muted">
              {ws.chapters.length} chapter · {ws.chapters.filter(c => c.status === 'rendered').length} rendered
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePullChapters}
            disabled={pulling || !ws.source}
            className="btn-ghost text-xs py-1.5 px-3"
            title="Sync danh sách chapter từ source"
          >
            {pulling ? 'Đang sync...' : '↻ Pull chapters'}
          </button>
          <button onClick={handleDelete} className="btn-ghost text-xs py-1.5 px-3 text-rose-400">
            Xoá series
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-6">
          {/* Series header */}
          <div className="flex gap-6 mb-6">
            {ws.cover && (
              <img src={ws.cover} className="w-40 aspect-[2/3] object-cover rounded-lg border border-border shrink-0" />
            )}
            <div className="flex-1">
              <h2 className="text-2xl font-bold mb-1">{ws.title}</h2>
              <p className="text-xs text-muted mb-3">Source: {ws.source?.pluginId || '?'}</p>
              <div className="space-y-1 text-xs">
                <div>
                  <span className="text-muted">Default voice:</span>{' '}
                  <span className="font-mono">{ws.defaults.voice}</span>
                </div>
                <div>
                  <span className="text-muted">Default language:</span>{' '}
                  <span className="uppercase">{ws.defaults.language}</span>
                </div>
                <div>
                  <span className="text-muted">Tạo:</span>{' '}
                  {new Date(ws.createdAt).toLocaleString('vi-VN', { hour12: false })}
                </div>
              </div>
            </div>
          </div>

          {pullSummary && (
            <div className="mb-4 px-3 py-2 bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 rounded">
              {pullSummary}
            </div>
          )}

          {/* Chapter list */}
          <div className="bg-panel border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-medium">Chapters ({ws.chapters.length})</h3>
              <div className="flex items-center gap-3 text-[10px] text-muted">
                <span><span className="inline-block w-2 h-2 rounded-full bg-zinc-500 mr-1"></span>Pending</span>
                <span><span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1"></span>Voiceover</span>
                <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1"></span>Rendered</span>
              </div>
            </div>

            {ws.chapters.length === 0 ? (
              <div className="p-12 text-center text-sm text-muted">
                Chưa có chapter. Bấm <strong>↻ Pull chapters</strong> phía trên để sync từ source.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {ws.chapters.map(c => (
                  <ChapterRow key={c.id} chapter={c} onOpen={() => onOpenChapter(c.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function ChapterRow({ chapter, onOpen }: { chapter: ChapterEntry; onOpen: () => void }) {
  const dot = {
    pending: 'bg-zinc-500',
    voiceover: 'bg-amber-400',
    rendered: 'bg-emerald-400',
    error: 'bg-rose-500'
  }[chapter.status]
  const actionLabel = {
    pending: 'Bắt đầu →',
    voiceover: 'Tiếp tục →',
    rendered: 'Re-render',
    error: 'Thử lại'
  }[chapter.status]

  return (
    <div className="px-4 py-3 flex items-center gap-3 hover:bg-bg/40 transition-colors">
      <span className={`inline-block w-2 h-2 rounded-full ${dot} shrink-0`} title={chapter.status}></span>
      <div className="flex-1 min-w-0">
        <div className="text-sm">
          <span className="font-medium">Ch {chapter.number}</span>
          {chapter.title && <span className="text-zinc-300 ml-2">— {chapter.title}</span>}
        </div>
        <div className="text-[10px] text-muted flex items-center gap-3 mt-0.5">
          {chapter.pageCount && <span>{chapter.pageCount} trang</span>}
          {chapter.language && <span className="uppercase">{chapter.language}</span>}
          {chapter.renderedAt && (
            <span>Rendered: {new Date(chapter.renderedAt).toLocaleString('vi-VN', { hour12: false })}</span>
          )}
          {typeof chapter.ttsHits === 'number' && <span>TTS hit: {chapter.ttsHits}</span>}
        </div>
      </div>
      <button onClick={onOpen} className="btn-ghost text-xs py-1 px-3 shrink-0">
        {actionLabel}
      </button>
    </div>
  )
}
