/**
 * Home view — grid of series workspaces with inline add form.
 *
 * Layout:
 *   Header (logo + Quick reader + Settings)
 *   AddWorkspaceForm (always visible top of content — no popup modal)
 *   Empty state OR Series grid (below the form)
 */

import { useEffect, useState } from 'react'

export interface WorkspaceSummary {
  id: string
  title: string
  cover: string | null
  source: { pluginId: string; mangaId: string; url?: string } | null
  chapterCount: number
  renderedCount: number
  createdAt: string
  updatedAt: string
}

interface HomeViewProps {
  onOpenWorkspace: (id: string) => void
  onOpenLegacy: () => void
}

export default function HomeView({ onOpenWorkspace, onOpenLegacy }: HomeViewProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const refresh = async () => {
    if (!window.api?.workspace) { setLoading(false); return }
    const r = await window.api.workspace.list()
    setLoading(false)
    if (r.ok) setWorkspaces(r.data)
    else setListError(r.error)
  }

  useEffect(() => { refresh() }, [])

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#0a0a0b' }}>
      {/* ── Top bar ────────────────────────────────────────────────── */}
      <header
        className="px-8 py-4 flex items-center justify-between border-b shrink-0"
        style={{ backgroundColor: '#111114', borderColor: '#27272a' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-white text-base"
            style={{ backgroundColor: '#f43f5e' }}
          >
            M
          </div>
          <div>
            <h1 className="text-base font-semibold text-zinc-100 leading-tight tracking-tight">
              Baru-Manga
            </h1>
            <p className="text-[11px] text-zinc-500 leading-tight">
              Đọc manga • AI review • Render video recap
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenLegacy}
            className="text-xs text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded transition-colors"
            style={{ borderColor: '#27272a', borderWidth: '1px' }}
            title="Quick reader — paste link, render không lưu workspace"
          >
            Quick reader
          </button>
          <button
            className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
            title="Settings — coming soon"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Content ────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-8 py-8">
          {/* Inline add form — always visible at top */}
          <AddWorkspaceForm onCreated={refresh} />

          {listError && (
            <div
              className="mt-4 px-4 py-3 rounded-lg text-sm"
              style={{ backgroundColor: 'rgba(244, 63, 94, 0.08)', borderColor: 'rgba(244, 63, 94, 0.3)', color: '#fda4af', borderWidth: '1px' }}
            >
              {listError}
            </div>
          )}

          {/* Empty illustration when no workspaces */}
          {!loading && workspaces.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="text-5xl mb-4 opacity-30">📚</div>
              <h2 className="text-xl font-bold text-zinc-100 mb-2 tracking-tight">
                Chưa có bộ truyện nào
              </h2>
              <p className="text-sm text-zinc-500 max-w-md">
                Paste link manga vào ô phía trên để bắt đầu.
              </p>
            </div>
          )}

          {/* Filled grid */}
          {!loading && workspaces.length > 0 && (
            <>
              <div className="flex items-baseline justify-between mb-5 mt-8">
                <div>
                  <h2 className="text-xl font-bold text-zinc-100 tracking-tight">My Series</h2>
                  <p className="text-xs text-zinc-500 mt-1">
                    {workspaces.length} bộ • {workspaces.reduce((s, w) => s + w.renderedCount, 0)} chapter đã render
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
                {workspaces.map(ws => (
                  <SeriesCard key={ws.id} ws={ws} onOpen={() => onOpenWorkspace(ws.id)} />
                ))}
              </div>
            </>
          )}

          {loading && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5 mt-8">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="aspect-[2/3] rounded-xl animate-pulse" style={{ backgroundColor: '#18181b' }} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

// ─── Inline add form ─────────────────────────────────────────────────────

function AddWorkspaceForm({ onCreated }: { onCreated: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || !window.api?.plugins || !window.api?.workspace) return
    setBusy(true)
    setError(null)

    setPhase('Fetching metadata...')
    const r = await window.api.plugins.openByUrl(url.trim())
    if (!r.ok) { setBusy(false); setError(r.error); return }
    const manga = r.data.kind === 'manga' ? r.data.manga : r.data.manga
    if (!manga) {
      setBusy(false)
      setError('URL không có metadata manga. Paste link manga (không phải chapter).')
      return
    }

    setPhase('Loading chapters...')
    let chapters: any[] = []
    const chRes = await window.api.plugins.getChapters(r.data.pluginId, manga.id, { lang: 'vi' })
    if (chRes.ok) {
      chapters = chRes.data.slice(0, 200).map((c: any) => ({
        id: c.id, number: c.number, title: c.title, language: c.language,
        pageCount: c.pageCount, status: 'pending'
      }))
    }

    setPhase('Saving...')
    const created = await window.api.workspace.create({
      title: manga.title,
      cover: manga.cover || null,
      source: { pluginId: r.data.pluginId, mangaId: manga.id, url: url.trim() },
      defaults: {
        voice: 'Charon',
        model: 'gemini/gemini-2.5-flash-preview-tts',
        language: 'vi',
        style: 'recap'
      },
      chapters
    })
    setBusy(false)
    if (!created.ok) { setError(created.error); return }
    setUrl('')
    setPhase('')
    onCreated()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl p-5"
      style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px' }}
    >
      <label className="block text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-2">
        Thêm bộ truyện
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="https://mangadex.org/title/... hoặc https://nettruyen.gg/truyen-tranh/..."
          value={url}
          onChange={e => setUrl(e.target.value)}
          disabled={busy}
          className="flex-1 rounded-lg px-3 py-2.5 text-sm font-mono outline-none transition-colors"
          style={{
            backgroundColor: '#0a0a0b',
            borderColor: '#27272a',
            borderWidth: '1px',
            color: '#e4e4e7'
          }}
          onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = '#f43f5e' }}
          onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = '#27272a' }}
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50 shrink-0"
          style={{ backgroundColor: '#f43f5e' }}
        >
          {busy ? 'Đang xử lý...' : 'Thêm'}
        </button>
      </div>

      {busy && phase && (
        <div className="mt-3 text-xs text-zinc-500 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: '#f43f5e' }}></div>
          {phase}
        </div>
      )}

      {error && (
        <div
          className="mt-3 px-3 py-2 rounded-md text-xs"
          style={{ backgroundColor: 'rgba(244, 63, 94, 0.08)', borderColor: 'rgba(244, 63, 94, 0.3)', color: '#fda4af', borderWidth: '1px' }}
        >
          {error}
        </div>
      )}
    </form>
  )
}

// ─── Series card ─────────────────────────────────────────────────────────

function SeriesCard({ ws, onOpen }: { ws: WorkspaceSummary; onOpen: () => void }) {
  const isDone = ws.chapterCount > 0 && ws.renderedCount === ws.chapterCount
  const isActive = ws.renderedCount > 0 && !isDone
  const statusColor = isDone ? '#10b981' : (isActive ? '#f59e0b' : '#52525b')

  return (
    <button
      onClick={onOpen}
      className="text-left rounded-xl overflow-hidden transition-all group relative"
      style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#f43f5e80' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#27272a' }}
    >
      <div className="aspect-[2/3] overflow-hidden relative" style={{ backgroundColor: '#0a0a0b' }}>
        {ws.cover ? (
          <img
            src={ws.cover}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-600 text-3xl">📕</div>
        )}
        <div
          className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-medium flex items-center gap-1.5"
          style={{ backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
        >
          <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: statusColor }} />
          <span className="text-zinc-200">{ws.renderedCount}/{ws.chapterCount}</span>
        </div>
      </div>
      <div className="p-3">
        <h3 className="text-sm font-semibold text-zinc-100 line-clamp-2 leading-snug mb-1">
          {ws.title}
        </h3>
        <p className="text-[11px] text-zinc-500 capitalize">
          {ws.source?.pluginId || 'local'}
        </p>
      </div>
    </button>
  )
}
