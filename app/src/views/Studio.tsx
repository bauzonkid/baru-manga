/**
 * Studio — all-in-one render page.
 *
 * Mọi step pipeline ở 1 trang, scroll xuống:
 *   1. Input URL
 *   2. Manga info + multi-select chapters
 *   3. Voiceover script (gen per chapter, edit segments)  ← Phase 2
 *   4. Voice + style                                      ← Phase 3
 *   5. Render multi-chapter → 1 MP4 concat                ← Phase 3
 *
 * Workspace auto-sinh khi user paste URL + bấm "Mở" — em fetch metadata,
 * tạo workspace entry trong workspaces.json. Tất cả files (pages/tts/clips/
 * videos) liên quan đến manga đó nằm cùng folder.
 *
 * Resume: paste lại URL cũ → em detect workspace tồn tại → load state cũ.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Chapter, Page } from '../types/plugin'
import type { VoiceoverSegment } from '../App'

interface StudioProps {
  onOpenLegacy: () => void
}

interface WorkspaceData {
  id: string
  title: string
  cover: string | null
  source: { pluginId: string; mangaId: string; url?: string } | null
  chapters: ChapterEntry[]
  defaults: {
    voice: string
    model: string
    language: string
    style?: string
    subtitleEnabled?: boolean
    subtitlePreset?: string
    subtitleFontSize?: number
    subtitlePosition?: 'top' | 'middle' | 'bottom'
    subtitleBoxOpacity?: number
    subtitleShowBox?: boolean
  }
}

interface ChapterEntry {
  id: string
  number: string
  title?: string
  language?: string
  pageCount?: number
  status: 'pending' | 'voiceover' | 'rendered' | 'error'
}

export default function Studio({ onOpenLegacy }: StudioProps) {
  // ── Section 1: Input + workspace picker ──────────────────────────────
  interface WorkspaceSummary {
    id: string
    title: string
    cover: string | null
    source: { pluginId: string; mangaId: string; url?: string } | null
    chapterCount: number
    renderedCount: number
    createdAt: string
    updatedAt: string
  }
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [wsList, setWsList] = useState<WorkspaceSummary[]>([])

  // Load existing workspace summaries on mount + after CRUD ops
  const refreshWsList = async () => {
    if (!window.api?.workspace) return
    const r = await window.api.workspace.list()
    if (r.ok) setWsList(r.data as WorkspaceSummary[])
  }
  useEffect(() => { refreshWsList() }, [])

  // ── Section 2: Workspace + chapters ──────────────────────────────────
  const [ws, setWs] = useState<WorkspaceData | null>(null)
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set())
  const [previewChapter, setPreviewChapter] = useState<string | null>(null)
  const [previewPages, setPreviewPages] = useState<Map<string, Page[]>>(new Map())
  const [previewBusy, setPreviewBusy] = useState<Set<string>>(new Set())
  const [previewError, setPreviewError] = useState<Map<string, string>>(new Map())
  // Pages user marks to skip (banner / ads / intro junk). Two mechanisms:
  //   1. Bulk rule per chapter: drop N from start + M from end (skipRules)
  //   2. Individual click toggle: ad-hoc indices (excludedPages)
  // Final excluded set = union of both, computed at gen + render time.
  const [excludedPages, setExcludedPages] = useState<Map<string, Set<number>>>(new Map())
  const [skipRules, setSkipRules] = useState<Map<string, { fromStart: number; fromEnd: number }>>(new Map())

  // ── Section 3: Download pages to workspace ───────────────────────────
  // Pre-download all selected chapter pages to disk so AI gen + ffmpeg
  // render read from local files (no double network fetch). Backend
  // `chapter:download` is cache-aware — re-running is cheap.
  const [localPaths, setLocalPaths] = useState<Map<string, string[]>>(new Map())
  const [downloadBusy, setDownloadBusy] = useState<Set<string>>(new Set())
  const [downloadProgress, setDownloadProgress] = useState<Map<string, { i: number; total: number; cached?: number }>>(new Map())
  const [downloadError, setDownloadError] = useState<Map<string, string>>(new Map())
  const [activeDownloadChId, setActiveDownloadChId] = useState<string | null>(null)

  // ── Section 4: Voiceover per-chapter ─────────────────────────────────
  const [segments, setSegments] = useState<Map<string, VoiceoverSegment[]>>(new Map())
  const [genBusy, setGenBusy] = useState<Set<string>>(new Set())
  const [genPhase, setGenPhase] = useState<Map<string, string>>(new Map())
  const [genError, setGenError] = useState<Map<string, string>>(new Map())
  const [expandedChapter, setExpandedChapter] = useState<string | null>(null)

  // ── Pipeline step navigation ─────────────────────────────────────────
  // Sidebar pipeline (left column). Each step has its own panel; only the
  // active step renders. Step 1 is always reachable. Steps 2-5 require the
  // workspace + a chapter selection (computed inside PipelineNav).
  const [activeStep, setActiveStep] = useState<Step>(1)

  // ── Section 4: Voice meta ────────────────────────────────────────────
  interface VoiceMeta {
    voices: { key: string; label: string; demoUrl: string }[]
    models: { key: string; label: string }[]
    defaultVoice: string
    defaultModel: string
  }
  const [voiceMeta, setVoiceMeta] = useState<VoiceMeta | null>(null)
  const [demoAudio, setDemoAudio] = useState<HTMLAudioElement | null>(null)

  // ── Section 5: Render ────────────────────────────────────────────────
  const [renderBusy, setRenderBusy] = useState(false)
  const [renderPhase, setRenderPhase] = useState<{ phase: string; i?: number; total?: number; chapterIdx?: number; chapterTotal?: number; msg?: string } | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [renderOutput, setRenderOutput] = useState<{ outPath: string; bytes: number } | null>(null)

  // Load voice meta once
  useEffect(() => {
    if (!window.api?.tts) return
    window.api.tts.meta().then(r => {
      if (r.ok) setVoiceMeta(r.data)
    })
  }, [])

  // Sync localPaths from disk whenever the workspace changes. Files persist
  // across app restarts but the React state Map doesn't — without this scan
  // the user would need to re-download even though the JPGs are already on
  // disk.
  useEffect(() => {
    if (!ws || !window.api?.workspace) return
    let mounted = true
    window.api.workspace.scanPages(ws.id, ws.chapters.map(c => ({ id: c.id, number: c.number }))).then(r => {
      if (!mounted) return
      if (r.ok) {
        setLocalPaths(new Map(Object.entries(r.data)))
      }
    })
    return () => { mounted = false }
  }, [ws?.id])

  // Subscribe to render progress
  useEffect(() => {
    if (!window.api?.video?.onProgress) return
    const off = window.api.video.onProgress((info: any) => {
      if (info.phase === 'done') {
        setRenderBusy(false)
        setRenderPhase(null)
        if (info.outPath) setRenderOutput({ outPath: info.outPath, bytes: 0 })
      } else if (info.phase === 'error') {
        setRenderBusy(false)
        setRenderPhase(null)
        setRenderError(info.error || info.msg || 'Render failed')
      } else {
        setRenderPhase({
          phase: info.phase,
          i: info.i,
          total: info.total,
          chapterIdx: info.chapterIdx,
          chapterTotal: info.chapterTotal,
          msg: info.msg
        })
      }
    })
    return () => off()
  }, [])

  // Auto-load workspace if URL matches existing on paste blur (resume).
  // Phase 1: simple — load by URL after fetch metadata.

  // Sorted list of selected chapters, by chapter number ascending.
  // Render concat needs ordered chapters; em pre-sort once.
  const selectedList = useMemo(() => {
    if (!ws) return []
    return ws.chapters
      .filter(c => selectedChapters.has(c.id))
      .sort((a, b) => {
        const na = parseFloat(a.number) || 0
        const nb = parseFloat(b.number) || 0
        return na - nb
      })
  }, [ws, selectedChapters])

  const handleOpen = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!url.trim() || !window.api?.plugins || !window.api?.workspace) return
    setBusy(true)
    setError(null)
    setPhase('Fetching metadata...')

    // 1. Resolve URL — plugin returns either { kind: 'manga' } (multi-chapter
    //    listing, e.g. MangaDex title) or { kind: 'chapter' } (universal /
    //    direct chapter URL — chapter list not enumerable).
    const r = await window.api.plugins.openByUrl(url.trim())
    if (!r.ok) { setBusy(false); setError(r.error); setPhase(''); return }

    // Identify manga key + chapter list source. Universal returns manga: null;
    // we synthesize a single-chapter workspace using the URL as the manga id.
    let mangaTitle: string
    let mangaCover: string | null = null
    let mangaIdKey: string
    let initialChapters: ChapterEntry[]

    if (r.data.kind === 'manga') {
      const manga = r.data.manga
      mangaTitle = manga.title
      mangaCover = manga.cover || null
      mangaIdKey = manga.id
      // Fetch full chapter list
      setPhase('Fetch chapter list...')
      const chRes = await window.api.plugins.getChapters(r.data.pluginId, manga.id, { lang: 'vi' })
      initialChapters = chRes.ok
        ? chRes.data.slice(0, 500).map((c: Chapter) => ({
            id: c.id, number: c.number, title: c.title, language: c.language,
            pageCount: c.pageCount, status: 'pending' as const
          }))
        : []
    } else {
      // kind === 'chapter' — universal plugin path or direct chapter URL
      const ch = r.data.chapter
      const manga = r.data.manga
      if (manga) {
        mangaTitle = manga.title
        mangaCover = manga.cover || null
        mangaIdKey = manga.id
      } else {
        // Fall back to URL hostname for title — better than blank
        try { mangaTitle = new URL(url.trim()).hostname.replace(/^www\./, '') } catch { mangaTitle = 'Manga' }
        mangaIdKey = ch.id // URL is the chapter id for universal
      }
      initialChapters = [{
        id: ch.id, number: ch.number, title: ch.title, language: ch.language,
        pageCount: ch.pageCount, status: 'pending' as const
      }]
    }

    // 2. Check if workspace already exists for this manga key (resume)
    setPhase('Check existing workspace...')
    const listRes = await window.api.workspace.list()
    let existing: WorkspaceData | null = null
    if (listRes.ok) {
      const match = listRes.data.find(w =>
        w.source?.pluginId === r.data.pluginId && w.source?.mangaId === mangaIdKey
      )
      if (match) {
        const detail = await window.api.workspace.get(match.id)
        if (detail.ok && detail.data) existing = detail.data as WorkspaceData
      }
    }

    if (existing) {
      // Resume — for 'manga' kind, refresh chapter list from source.
      // For 'chapter' kind (universal), single chapter is already stored.
      if (r.data.kind === 'manga') {
        setPhase('Resume workspace — sync chapter list...')
        const chRes = await window.api.plugins.getChapters(r.data.pluginId, mangaIdKey, { lang: existing.defaults.language })
        if (chRes.ok) {
          const existingIds = new Set(existing.chapters.map(c => c.id))
          const newChapters = chRes.data
            .filter((c: Chapter) => !existingIds.has(c.id))
            .map((c: Chapter) => ({
              id: c.id, number: c.number, title: c.title, language: c.language,
              pageCount: c.pageCount, status: 'pending' as const
            }))
          if (newChapters.length > 0) {
            for (const ch of newChapters) {
              await window.api.workspace.upsertChapter(existing.id, ch)
            }
            const refresh = await window.api.workspace.get(existing.id)
            if (refresh.ok && refresh.data) existing = refresh.data as WorkspaceData
          }
        }
      }
      setWs(existing)
      setBusy(false)
      setPhase('')
      setActiveStep(2) // auto-advance to chapter picker
      return
    }

    // 3. Create new workspace
    setPhase('Tạo workspace...')
    const created = await window.api.workspace.create({
      title: mangaTitle,
      cover: mangaCover,
      source: { pluginId: r.data.pluginId, mangaId: mangaIdKey, url: url.trim() },
      defaults: { voice: 'Charon', model: 'gemini/gemini-2.5-flash-preview-tts', language: 'vi', style: 'recap' },
      chapters: initialChapters
    })
    setBusy(false)
    setPhase('')
    if (!created.ok) { setError(created.error); return }
    setWs(created.data as WorkspaceData)
    setActiveStep(2) // auto-advance to chapter picker
    refreshWsList()
  }

  const loadExistingWorkspace = async (wsId: string) => {
    if (!window.api?.workspace) return
    setBusy(true)
    setError(null)
    setPhase('Loading workspace...')
    const r = await window.api.workspace.get(wsId)
    setBusy(false)
    setPhase('')
    if (!r.ok) { setError(r.error); return }
    if (r.data) {
      setWs(r.data as WorkspaceData)
      // Reset transient state — fresh start with this workspace
      setSelectedChapters(new Set())
      setSegments(new Map())
      setLocalPaths(new Map())
      setRenderOutput(null)
      setRenderError(null)
      setActiveStep(2)
    }
  }

  const deleteWorkspace = async (wsId: string, title: string) => {
    if (!window.api?.workspace) return
    if (!confirm(`Xoá workspace "${title}"? Folder workspace (pages, voiceover, video) sẽ bị xoá hết.`)) return
    const r = await window.api.workspace.delete(wsId)
    if (!r.ok) { setError(r.error); return }
    if (ws?.id === wsId) {
      setWs(null)
      setActiveStep(1)
    }
    refreshWsList()
  }

  const toggleChapter = (chId: string) => {
    setSelectedChapters(prev => {
      const next = new Set(prev)
      if (next.has(chId)) next.delete(chId)
      else next.add(chId)
      return next
    })
  }

  const selectAll = () => {
    if (!ws) return
    setSelectedChapters(new Set(ws.chapters.map(c => c.id)))
  }

  const selectNone = () => setSelectedChapters(new Set())

  const toggleExclude = (chId: string, idx: number) => {
    setExcludedPages(prev => {
      const set = new Set<number>(prev.get(chId) || [])
      if (set.has(idx)) set.delete(idx); else set.add(idx)
      const next = new Map(prev)
      next.set(chId, set)
      return next
    })
    invalidateSegments(chId)
  }

  // Set bulk skip rule (N pages from start / end). Invalidates segments since
  // panel indices shift when skip count changes.
  const setSkipRule = (chId: string, patch: Partial<{ fromStart: number; fromEnd: number }>) => {
    setSkipRules(prev => {
      const cur = prev.get(chId) || { fromStart: 0, fromEnd: 0 }
      const next = new Map(prev)
      next.set(chId, { ...cur, ...patch })
      return next
    })
    invalidateSegments(chId)
  }

  // Drop voiceover segments for this chapter — panel indices reference a
  // specific filtered page list, so any skip change makes them stale.
  const invalidateSegments = (chId: string) => {
    setSegments(prev => {
      if (!prev.has(chId)) return prev
      const next = new Map(prev)
      next.delete(chId)
      return next
    })
  }

  // Compute final excluded indices = union of (bulk rule) + (individual clicks).
  // Caller passes total page count for the chapter (known after pages loaded).
  const computeExcluded = (chId: string, total: number): Set<number> => {
    const rule = skipRules.get(chId) || { fromStart: 0, fromEnd: 0 }
    const set = new Set<number>(excludedPages.get(chId) || [])
    for (let i = 0; i < rule.fromStart && i < total; i++) set.add(i)
    for (let i = 0; i < rule.fromEnd && i < total; i++) set.add(total - 1 - i)
    return set
  }

  const togglePreview = async (chId: string) => {
    if (previewChapter === chId) { setPreviewChapter(null); return }
    setPreviewChapter(chId)
    if (previewPages.has(chId) || previewBusy.has(chId)) return
    if (!ws || !window.api?.plugins) return
    setPreviewBusy(prev => new Set(prev).add(chId))
    setPreviewError(prev => { const n = new Map(prev); n.delete(chId); return n })
    try {
      const r = await window.api.plugins.getPages(ws.source!.pluginId, chId)
      if (!r.ok) throw new Error(r.error)
      // Register referer so hotlink CDNs (nettruyen etc) don't 403 the <img> requests
      if (ws.source?.url && window.api?.chapter) {
        await window.api.chapter.registerReferer(r.data.map(p => p.url), ws.source.url)
      }
      setPreviewPages(prev => new Map(prev).set(chId, r.data))
    } catch (e: any) {
      setPreviewError(prev => new Map(prev).set(chId, e?.message || String(e)))
    } finally {
      setPreviewBusy(prev => { const n = new Set(prev); n.delete(chId); return n })
    }
  }

  // ── Download handlers ─────────────────────────────────────────────────

  const downloadForChapter = async (chId: string) => {
    if (!ws || !window.api?.plugins || !window.api?.chapter) return
    if (downloadBusy.has(chId)) return

    const ch = ws.chapters.find(c => c.id === chId)
    if (!ch) return

    setDownloadBusy(prev => new Set(prev).add(chId))
    setDownloadError(prev => { const n = new Map(prev); n.delete(chId); return n })
    setActiveDownloadChId(chId)

    try {
      const pg = await window.api.plugins.getPages(ws.source!.pluginId, chId)
      if (!pg.ok) throw new Error(pg.error)
      if (pg.data.length === 0) throw new Error('Chapter trống')

      const excluded = computeExcluded(chId, pg.data.length)
      const filtered = pg.data.filter((_, i) => !excluded.has(i))
      if (filtered.length === 0) throw new Error('Tất cả page đã bị bỏ — chừa lại ít nhất 1 ảnh')

      if (ws.source?.url) {
        await window.api.chapter.registerReferer(filtered.map(p => p.url), ws.source.url)
      }

      const dl = await window.api.chapter.download({
        pageUrls: filtered.map(p => p.url),
        referer: ws.source?.url,
        mangaSlug: slugify(ws.title),
        chapterSlug: `ch${ch.number}`,
        workspaceId: ws.id
      })
      if (!dl.ok) throw new Error(dl.error)
      setLocalPaths(prev => new Map(prev).set(chId, dl.data.localPaths))
    } catch (e: any) {
      setDownloadError(prev => new Map(prev).set(chId, e?.message || String(e)))
    } finally {
      setDownloadBusy(prev => { const n = new Set(prev); n.delete(chId); return n })
      setActiveDownloadChId(null)
    }
  }

  const downloadAllSelected = async () => {
    for (const ch of selectedList) {
      if (localPaths.has(ch.id)) continue
      await downloadForChapter(ch.id)
    }
  }

  // Subscribe to download progress, attribute to the currently-active chapter
  useEffect(() => {
    if (!window.api?.chapter?.onDownloadProgress) return
    const off = window.api.chapter.onDownloadProgress((info: { i: number; total: number; file: string; cached: boolean }) => {
      if (!activeDownloadChId) return
      setDownloadProgress(prev => new Map(prev).set(activeDownloadChId, { i: info.i, total: info.total }))
    })
    return () => off()
  }, [activeDownloadChId])

  const allSelectedDownloaded = selectedList.length > 0 && selectedList.every(c => (localPaths.get(c.id)?.length ?? 0) > 0)

  // ── Voiceover handlers ────────────────────────────────────────────────

  const setPhaseFor = (chId: string, p: string) => {
    setGenPhase(prev => {
      const next = new Map(prev)
      if (p) next.set(chId, p); else next.delete(chId)
      return next
    })
  }

  const setErrorFor = (chId: string, e: string | null) => {
    setGenError(prev => {
      const next = new Map(prev)
      if (e) next.set(chId, e); else next.delete(chId)
      return next
    })
  }

  const generateForChapter = async (chId: string) => {
    console.log('[Voiceover] generateForChapter called', { chId, wsId: ws?.id })
    if (!ws) { console.warn('[Voiceover] aborted: no workspace'); return }
    if (!window.api?.ai) { setErrorFor(chId, 'window.api.ai chưa expose — restart Electron'); return }
    if (!window.api?.chapter) { setErrorFor(chId, 'window.api.chapter chưa expose — restart Electron'); return }
    if (!window.api?.plugins) { setErrorFor(chId, 'window.api.plugins chưa expose — restart Electron'); return }
    if (!window.api?.image) { setErrorFor(chId, 'window.api.image chưa expose — restart Electron'); return }
    if (genBusy.has(chId)) { console.warn('[Voiceover] already busy', chId); return }

    const ch = ws.chapters.find(c => c.id === chId)
    if (!ch) { setErrorFor(chId, `Không tìm thấy chapter ${chId}`); return }

    setGenBusy(prev => new Set(prev).add(chId))
    setErrorFor(chId, null)

    try {
      // Prefer local files downloaded in Step 3 — much faster, no network.
      // Step 3 already applied the skip rule, so localPaths is the filtered
      // set; panel indices from AI line up 1:1 with what ffmpeg renders.
      // No frontend cap — backend caps at 100 + handles sampling internally.
      let images: { base64: string; mimeType: string }[] = []
      const localList = localPaths.get(chId)

      if (localList && localList.length > 0) {
        setPhaseFor(chId, `Đọc ${localList.length} ảnh local...`)
        const r = await window.api.chapter.readLocalAsBase64(localList)
        if (!r.ok) throw new Error(r.error)
        images = r.data
      } else {
        // Fallback: fetch from CDN (only hit if Step 3 was skipped)
        setPhaseFor(chId, 'Fetching pages từ CDN...')
        const pgRes = await window.api.plugins.getPages(ws.source!.pluginId, chId)
        if (!pgRes.ok) throw new Error(pgRes.error)
        if (pgRes.data.length === 0) throw new Error('Chapter trống')
        if (ws.source?.url) {
          await window.api.chapter.registerReferer(pgRes.data.map(p => p.url), ws.source.url)
        }
        const excluded = computeExcluded(chId, pgRes.data.length)
        const filteredPages = pgRes.data.filter((_, i) => !excluded.has(i))
        if (filteredPages.length === 0) throw new Error('Tất cả page đã bị bỏ — chừa lại ít nhất 1 ảnh')
        for (let i = 0; i < filteredPages.length; i++) {
          setPhaseFor(chId, `Tải ảnh ${i + 1}/${filteredPages.length}...`)
          const img = await window.api.image.fetch(filteredPages[i].url, ws.source?.url)
          if (img.ok) images.push({ base64: img.base64, mimeType: img.contentType })
        }
      }
      if (images.length === 0) throw new Error('Không có ảnh nào để gen voiceover')

      // 4. Call AI
      setPhaseFor(chId, `Gen voiceover (${images.length} ảnh)...`)
      console.log('[Voiceover] calling AI', { imageCount: images.length, lang: ws.defaults.language, style: ws.defaults.style })
      const aiRes = await window.api.ai.voiceoverScript({
        images,
        language: ws.defaults.language,
        mangaTitle: ws.title,
        chapterTitle: `Chapter ${ch.number}${ch.title ? ' — ' + ch.title : ''}`,
        style: (ws.defaults.style as 'recap' | 'critic' | 'funny' | 'serious') || 'recap'
      })
      console.log('[Voiceover] AI response', aiRes)
      if (!aiRes.ok) throw new Error(aiRes.error || 'AI không trả response')
      if (!aiRes.data || !Array.isArray(aiRes.data.segments) || aiRes.data.segments.length === 0) {
        throw new Error('AI trả về 0 segment — kiểm tra console DevTools để xem chi tiết')
      }

      // 5. Save segments
      console.log('[Voiceover] storing', aiRes.data.segments.length, 'segments for', chId)
      setSegments(prev => new Map(prev).set(chId, aiRes.data.segments))
      setExpandedChapter(chId)

      // 6. Update workspace chapter status
      if (window.api?.workspace) {
        await window.api.workspace.upsertChapter(ws.id, { ...ch, status: 'voiceover' })
        const refresh = await window.api.workspace.get(ws.id)
        if (refresh.ok && refresh.data) setWs(refresh.data as WorkspaceData)
      }
    } catch (err: any) {
      setErrorFor(chId, err?.message || String(err))
    } finally {
      setGenBusy(prev => { const next = new Set(prev); next.delete(chId); return next })
      setPhaseFor(chId, '')
    }
  }

  const generateForAllSelected = async () => {
    for (const ch of selectedList) {
      if (segments.has(ch.id)) continue
      await generateForChapter(ch.id)
    }
  }

  const updateSegment = (chId: string, idx: number, patch: Partial<VoiceoverSegment>) => {
    setSegments(prev => {
      const list = prev.get(chId)
      if (!list) return prev
      const next = new Map(prev)
      next.set(chId, list.map((s, i) => i === idx ? { ...s, ...patch } : s))
      return next
    })
  }

  const removeSegment = (chId: string, idx: number) => {
    setSegments(prev => {
      const list = prev.get(chId)
      if (!list) return prev
      const next = new Map(prev)
      next.set(chId, list.filter((_, i) => i !== idx))
      return next
    })
  }

  const addSegment = (chId: string) => {
    setSegments(prev => {
      const list = prev.get(chId) || []
      const last = list[list.length - 1]
      const next = new Map(prev)
      next.set(chId, [...list, {
        text: '',
        panelStart: last ? last.panelEnd + 1 : 1,
        panelEnd: last ? last.panelEnd + 2 : 2
      }])
      return next
    })
  }

  // ── Voice + Render handlers ───────────────────────────────────────────

  const updateDefault = async (patch: Partial<WorkspaceData['defaults']>) => {
    if (!ws || !window.api?.workspace) return
    const nextDefaults = { ...ws.defaults, ...patch }
    setWs({ ...ws, defaults: nextDefaults })
    await window.api.workspace.update(ws.id, { defaults: nextDefaults })
  }

  const playDemo = (demoUrl: string) => {
    try { demoAudio?.pause() } catch {}
    if (!demoUrl) return
    const a = new Audio(demoUrl)
    a.play().catch(() => {})
    setDemoAudio(a)
  }

  const allSelectedHaveSegments = selectedList.length > 0 && selectedList.every(c => (segments.get(c.id)?.length ?? 0) > 0)

  const handleRender = async () => {
    if (!ws || !window.api?.video || !window.api?.plugins) return
    if (!allSelectedHaveSegments) {
      setRenderError('Còn chapter chưa có voiceover. Gen ở Section 3 trước.')
      return
    }
    setRenderBusy(true)
    setRenderError(null)
    setRenderOutput(null)
    setRenderPhase({ phase: 'download', msg: 'Chuẩn bị...' })

    try {
      // Build batch input — collect pageUrls per chapter, drop excluded pages
      // (same filter that was applied at gen-voiceover so segment indices match).
      const chaptersInput: { chapterSlug: string; pageUrls: string[]; segments: VoiceoverSegment[] }[] = []
      for (let i = 0; i < selectedList.length; i++) {
        const ch = selectedList[i]
        setRenderPhase({ phase: 'download', msg: `Fetch pages ch ${ch.number}...`, chapterIdx: i + 1, chapterTotal: selectedList.length })
        const pgRes = await window.api.plugins.getPages(ws.source!.pluginId, ch.id)
        if (!pgRes.ok) throw new Error(`Ch ${ch.number}: ${pgRes.error}`)
        if (ws.source?.url && window.api?.chapter) {
          await window.api.chapter.registerReferer(pgRes.data.map(p => p.url), ws.source.url)
        }
        const excluded = computeExcluded(ch.id, pgRes.data.length)
        const filteredUrls = pgRes.data.filter((_, idx) => !excluded.has(idx)).map(p => p.url)
        if (filteredUrls.length === 0) throw new Error(`Ch ${ch.number}: tất cả page đã bị bỏ`)
        chaptersInput.push({
          chapterSlug: `ch${ch.number}`,
          pageUrls: filteredUrls,
          segments: segments.get(ch.id) || []
        })
      }

      // Call batch render IPC (handles both 1 chapter and N chapters)
      const wsAny = ws.defaults as any
      const r = await window.api.video.renderBatch({
        chapters: chaptersInput,
        referer: ws.source?.url,
        voice: ws.defaults.voice,
        model: ws.defaults.model,
        language: ws.defaults.language,
        mangaSlug: slugify(ws.title),
        workspaceId: ws.id,
        subtitleEnabled: wsAny.subtitleEnabled !== false,
        subtitleStyle: {
          fontSize: wsAny.subtitleFontSize,
          position: wsAny.subtitlePosition,
          boxOpacity: wsAny.subtitleBoxOpacity,
          showBox: wsAny.subtitleShowBox
        }
      })
      if (!r.ok) throw new Error(r.error)
      setRenderOutput({ outPath: r.data.outPath, bytes: r.data.bytes })
      // Mark all rendered
      if (window.api?.workspace) {
        for (const ch of selectedList) {
          await window.api.workspace.upsertChapter(ws.id, { ...ch, status: 'rendered' })
        }
        const refresh = await window.api.workspace.get(ws.id)
        if (refresh.ok && refresh.data) setWs(refresh.data as WorkspaceData)
      }
    } catch (err: any) {
      setRenderError(err?.message || String(err))
    } finally {
      setRenderBusy(false)
      setRenderPhase(null)
    }
  }

  const openOutputFolder = () => {
    if (!renderOutput || !window.api?.video) return
    window.api.video.openFolder(renderOutput.outPath)
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#0a0a0b' }}>
      {/* ── Header ─────────────────────────────────────────────────── */}
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
              Baru-Manga Studio
            </h1>
            <p className="text-[11px] text-zinc-500 leading-tight">
              Paste link → render video recap
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.api?.plugins?.openUserFolder?.()}
            className="text-xs text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded transition-colors"
            style={{ borderColor: '#27272a', borderWidth: '1px' }}
            title="Mở folder plugins — thả .cjs adapter vào để hỗ trợ site mới"
          >
            📁 Plugins
          </button>
          <button
            onClick={onOpenLegacy}
            className="text-xs text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded transition-colors"
            style={{ borderColor: '#27272a', borderWidth: '1px' }}
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

      {/* ── Sidebar + Content ────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        <PipelineNav
          activeStep={activeStep}
          onSelect={s => setActiveStep(s)}
          hasWorkspace={!!ws}
          chaptersSelected={selectedList.length}
          allDownloaded={allSelectedDownloaded}
          downloadedCount={selectedList.filter(c => (localPaths.get(c.id)?.length ?? 0) > 0).length}
          allHaveSegments={allSelectedHaveSegments}
          renderDone={!!renderOutput}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">

          {/* SECTION 1: Input URL + existing workspace picker */}
          {activeStep === 1 && (
          <Section number={1} title="Nguồn manga">
            {wsList.length > 0 && (
              <div className="mb-5">
                <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2.5 flex items-center justify-between">
                  <span>Workspace đã có ({wsList.length})</span>
                  <span className="text-[10px] text-zinc-600">Click để mở · hover hiện nút xoá</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {wsList.map(w => {
                    const isCurrent = ws?.id === w.id
                    return (
                      <div
                        key={w.id}
                        className="group relative rounded-lg p-2 cursor-pointer transition-colors hover:bg-zinc-800/40"
                        style={{
                          backgroundColor: isCurrent ? 'rgba(244, 63, 94, 0.08)' : '#0a0a0b',
                          borderColor: isCurrent ? 'rgba(244, 63, 94, 0.3)' : '#27272a',
                          borderWidth: '1px'
                        }}
                        onClick={() => loadExistingWorkspace(w.id)}
                      >
                        <div className="flex gap-2.5">
                          {w.cover ? (
                            <PageImage
                              url={w.cover}
                              referer={w.source?.url}
                              alt=""
                              className="w-12 aspect-[2/3] object-cover rounded shrink-0"
                              style={{ borderColor: '#27272a', borderWidth: '1px' }}
                            />
                          ) : (
                            <div
                              className="w-12 aspect-[2/3] rounded shrink-0 flex items-center justify-center text-zinc-700 text-2xl"
                              style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px' }}
                            >
                              📖
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-zinc-100 truncate" title={w.title}>{w.title}</div>
                            <div className="text-[10px] text-zinc-500 mt-1">
                              {w.chapterCount} chap
                              {w.renderedCount > 0 && (
                                <span className="ml-1.5 text-emerald-300">· {w.renderedCount} render</span>
                              )}
                            </div>
                            <div className="text-[10px] text-zinc-600 mt-0.5 capitalize">
                              {w.source?.pluginId || '—'}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); deleteWorkspace(w.id, w.title) }}
                          className="absolute top-1 right-1 w-5 h-5 rounded text-zinc-500 hover:text-rose-400 hover:bg-zinc-900/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                          title="Xoá workspace"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    )
                  })}
                </div>
                <div className="text-[11px] uppercase tracking-wider text-zinc-500 mt-5 mb-2">
                  Hoặc paste link manga mới
                </div>
              </div>
            )}
            <form onSubmit={handleOpen} className="flex gap-2">
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
                {busy ? 'Đang xử lý...' : 'Mở'}
              </button>
            </form>
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
          </Section>
          )}

          {/* SECTION 2: Chapters multi-select */}
          {activeStep === 2 && ws && (
            <Section number={2} title="Chọn chapter">
              <div className="flex gap-4">
                {ws.cover && (
                  <img
                    src={ws.cover}
                    alt=""
                    className="w-24 aspect-[2/3] object-cover rounded-lg shrink-0"
                    style={{ borderColor: '#27272a', borderWidth: '1px' }}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-zinc-100 mb-1 truncate">{ws.title}</h3>
                  <p className="text-xs text-zinc-500 mb-3">
                    Source: <span className="capitalize">{ws.source?.pluginId}</span> · {ws.chapters.length} chapter
                  </p>

                  <div className="flex items-center gap-2 mb-3">
                    <button onClick={selectAll} className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-100" style={{ borderColor: '#27272a', borderWidth: '1px' }}>
                      Chọn tất cả
                    </button>
                    <button onClick={selectNone} className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-100" style={{ borderColor: '#27272a', borderWidth: '1px' }}>
                      Bỏ chọn
                    </button>
                    <span className="text-[11px] text-zinc-500 ml-auto">
                      {selectedChapters.size} / {ws.chapters.length} chapter selected
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg" style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px' }}>
                {ws.chapters.length === 0 ? (
                  <div className="p-6 text-center text-sm text-zinc-500">Chưa có chapter</div>
                ) : (
                  ws.chapters.map(c => {
                    const checked = selectedChapters.has(c.id)
                    const dot = { pending: '#52525b', voiceover: '#f59e0b', rendered: '#10b981', error: '#f43f5e' }[c.status]
                    const isPreview = previewChapter === c.id
                    const pages = previewPages.get(c.id)
                    const isPreviewBusy = previewBusy.has(c.id)
                    const previewErr = previewError.get(c.id)
                    return (
                      <div key={c.id} style={{ borderTopColor: '#27272a', borderTopWidth: '1px' }}>
                        {/* Chapter row (main + skip rule), always visible */}
                        <div
                          style={{
                            backgroundColor: checked ? '#231518' : '#0a0a0b',
                            borderBottomColor: isPreview ? '#27272a' : 'transparent',
                            borderBottomWidth: '1px'
                          }}
                        >
                        <div className="flex items-center">
                          <button
                            onClick={() => toggleChapter(c.id)}
                            className="flex-1 px-4 py-2.5 flex items-center gap-3 text-left transition-colors"
                          >
                            <div
                              className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                              style={{
                                backgroundColor: checked ? '#f43f5e' : 'transparent',
                                borderColor: checked ? '#f43f5e' : '#52525b',
                                borderWidth: '1.5px'
                              }}
                            >
                              {checked && (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </div>
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: dot }} />
                            <span className="text-sm text-zinc-100 shrink-0">Ch {c.number}</span>
                            {c.title && <span className="text-sm text-zinc-400 truncate">— {c.title}</span>}
                            <span className="ml-auto text-[11px] text-zinc-500 shrink-0 flex items-center gap-1.5">
                              {c.pageCount ? `${c.pageCount}p` : ''} · {c.language?.toUpperCase()}
                              {(() => {
                                // Skip count: exact if pages loaded, otherwise sum of rule + click set.
                                const rule = skipRules.get(c.id)
                                const indivCount = excludedPages.get(c.id)?.size || 0
                                const ruleCount = (rule?.fromStart || 0) + (rule?.fromEnd || 0)
                                const loaded = previewPages.get(c.id)
                                const total = loaded ? computeExcluded(c.id, loaded.length).size : (ruleCount + indivCount)
                                return total > 0 ? (
                                  <span
                                    className="px-1.5 py-0.5 rounded text-[10px]"
                                    style={{ backgroundColor: 'rgba(244, 63, 94, 0.15)', color: '#fda4af' }}
                                  >
                                    bỏ {total}
                                  </span>
                                ) : null
                              })()}
                            </span>
                          </button>
                          <button
                            onClick={() => togglePreview(c.id)}
                            className="text-xs font-medium px-3 py-1.5 rounded-md transition-colors shrink-0 mr-3"
                            style={{
                              backgroundColor: isPreview ? '#27272a' : '#f43f5e',
                              color: isPreview ? '#d4d4d8' : 'white',
                              borderColor: isPreview ? '#3f3f46' : 'transparent',
                              borderWidth: '1px'
                            }}
                            title={isPreview ? 'Đóng reader' : 'Đọc chapter'}
                          >
                            {isPreview ? 'Đóng' : 'Đọc'}
                          </button>
                        </div>
                        {/* Skip rule row — always visible per chapter, no need to open reader */}
                        {(() => {
                          const rule = skipRules.get(c.id) || { fromStart: 0, fromEnd: 0 }
                          const totalKnown = (previewPages.get(c.id)?.length) ?? c.pageCount ?? 0
                          const computed = totalKnown > 0 ? computeExcluded(c.id, totalKnown) : null
                          return (
                            <div
                              className="px-3 py-1.5 flex items-center gap-3 text-xs"
                              style={{ borderTopColor: '#27272a', borderTopWidth: '1px', backgroundColor: 'rgba(0,0,0,0.2)' }}
                            >
                              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Bỏ ảnh</span>
                              <label className="flex items-center gap-1.5 text-zinc-300">
                                <span className="text-zinc-500">Đầu:</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={totalKnown || undefined}
                                  value={rule.fromStart}
                                  onChange={e => setSkipRule(c.id, { fromStart: Math.max(0, Number(e.target.value) || 0) })}
                                  className="w-12 px-1.5 py-0.5 text-xs rounded text-center outline-none"
                                  style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                                />
                              </label>
                              <label className="flex items-center gap-1.5 text-zinc-300">
                                <span className="text-zinc-500">Cuối:</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={totalKnown || undefined}
                                  value={rule.fromEnd}
                                  onChange={e => setSkipRule(c.id, { fromEnd: Math.max(0, Number(e.target.value) || 0) })}
                                  className="w-12 px-1.5 py-0.5 text-xs rounded text-center outline-none"
                                  style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                                />
                              </label>
                              {computed && (
                                <span className="text-[10px] text-zinc-500 ml-auto">
                                  Giữ <span className="text-emerald-300">{totalKnown - computed.size}</span> / Bỏ <span className="text-rose-300">{computed.size}</span> / Tổng {totalKnown}
                                </span>
                              )}
                              {!computed && (
                                <span className="text-[10px] text-zinc-600 ml-auto">
                                  Số trang chưa biết — mở "Đọc" để xem trước
                                </span>
                              )}
                            </div>
                          )
                        })()}
                        </div>
                        {/* Reader block — fixed-height frame with internal scroll */}
                        {isPreview && (
                          <div
                            className="overflow-y-auto"
                            style={{
                              backgroundColor: '#050506',
                              borderTopColor: '#27272a',
                              borderTopWidth: '1px',
                              maxHeight: '70vh'
                            }}
                          >
                            {isPreviewBusy && (
                              <div className="text-xs text-zinc-500 flex items-center gap-2 justify-center py-6">
                                <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: '#f43f5e' }} />
                                Đang tải pages...
                              </div>
                            )}
                            {previewErr && !isPreviewBusy && (
                              <div className="text-xs text-rose-300 text-center py-6">{previewErr}</div>
                            )}
                            {pages && !isPreviewBusy && pages.length === 0 && (
                              <div className="text-xs text-zinc-500 text-center py-6">Chapter trống</div>
                            )}
                            {pages && !isPreviewBusy && pages.length > 0 && (() => {
                              const computedExcluded = computeExcluded(c.id, pages.length)
                              return (
                                <div className="flex flex-col items-center">
                                  {pages.map((p, i) => {
                                    const excluded = computedExcluded.has(i)
                                    return (
                                      <div
                                        key={i}
                                        onClick={() => toggleExclude(c.id, i)}
                                        className="relative cursor-pointer w-full flex justify-center group"
                                      >
                                        <PageImage
                                          url={p.url}
                                          referer={ws.source?.url}
                                          alt={`Page ${i + 1}`}
                                          className="max-w-full block transition-opacity"
                                          style={{ opacity: excluded ? 0.18 : 1 }}
                                        />
                                        {excluded ? (
                                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                            <div
                                              className="px-3 py-1.5 rounded text-xs font-medium"
                                              style={{ backgroundColor: 'rgba(244, 63, 94, 0.9)', color: 'white' }}
                                            >
                                              ✕ Đã bỏ (page {i + 1})
                                            </div>
                                          </div>
                                        ) : (
                                          <div
                                            className="absolute top-2 right-2 px-2 py-1 rounded text-[10px] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                                            style={{ backgroundColor: 'rgba(0,0,0,0.75)', color: '#fda4af' }}
                                          >
                                            ✕ Bỏ ảnh này
                                          </div>
                                        )}
                                        <div
                                          className="absolute top-2 left-2 px-1.5 py-0.5 rounded text-[10px] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                                          style={{ backgroundColor: 'rgba(0,0,0,0.75)', color: '#a1a1aa' }}
                                        >
                                          {i + 1}
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              )
                            })()}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
              <StepNextBar
                disabled={selectedList.length === 0}
                hint={selectedList.length === 0 ? 'Chọn ít nhất 1 chapter để tiếp tục' : `${selectedList.length} chapter sẵn sàng tải`}
                label="Tiếp: Tải ảnh"
                onNext={() => setActiveStep(3)}
              />
            </Section>
          )}

          {/* SECTION 3: Download to workspace */}
          {activeStep === 3 && ws && selectedList.length > 0 && (
            <Section number={3} title="Tải ảnh về workspace">
              <div className="flex items-center justify-between mb-4 gap-3">
                <p className="text-xs text-zinc-500 flex-1 truncate">
                  {selectedList.filter(c => (localPaths.get(c.id)?.length ?? 0) > 0).length} / {selectedList.length} chapter đã tải
                  <span className="ml-2 text-zinc-600">·</span>
                  <span className="ml-2 font-mono text-[10px]">%APPDATA%\Baru-Manga\workspaces\{ws.id.slice(0, 8)}…\pages\</span>
                </p>
                <button
                  onClick={() => window.api?.chapter?.openDownloadsFolder?.({ workspaceId: ws.id })}
                  className="text-xs px-2.5 py-1.5 rounded-md text-zinc-300 hover:text-white shrink-0"
                  style={{ borderColor: '#27272a', borderWidth: '1px' }}
                  title="Mở folder workspace trong File Explorer"
                >
                  📂 Folder
                </button>
                <button
                  onClick={downloadAllSelected}
                  disabled={downloadBusy.size > 0 || allSelectedDownloaded}
                  className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors disabled:opacity-50 shrink-0"
                  style={{ backgroundColor: '#f43f5e' }}
                >
                  {downloadBusy.size > 0
                    ? `Đang tải ch ${activeDownloadChId ? selectedList.findIndex(c => c.id === activeDownloadChId) + 1 : ''}...`
                    : allSelectedDownloaded ? 'Đã tải hết' : 'Tải tất cả'}
                </button>
              </div>

              <div className="space-y-2">
                {selectedList.map(ch => {
                  const paths = localPaths.get(ch.id)
                  const busy = downloadBusy.has(ch.id)
                  const prog = downloadProgress.get(ch.id)
                  const err = downloadError.get(ch.id)
                  const done = (paths?.length ?? 0) > 0
                  return (
                    <div
                      key={ch.id}
                      className="rounded-md px-3 py-2 flex items-center gap-3"
                      style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px' }}
                    >
                      <span className="text-sm text-zinc-100 shrink-0">Ch {ch.number}</span>
                      {ch.title && <span className="text-sm text-zinc-400 truncate flex-1">— {ch.title}</span>}
                      {!ch.title && <span className="flex-1" />}

                      {busy && prog && (
                        <span className="text-[11px] text-amber-300 shrink-0">
                          {prog.i}/{prog.total} pages
                        </span>
                      )}
                      {busy && !prog && (
                        <span className="text-[11px] text-amber-300 shrink-0 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
                          Đang chuẩn bị...
                        </span>
                      )}
                      {err && (
                        <span className="text-[11px] text-rose-300 truncate" title={err}>{err}</span>
                      )}
                      {done && !busy && (
                        <span className="text-[11px] text-emerald-300 shrink-0 flex items-center gap-1.5">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          {paths!.length} ảnh
                        </span>
                      )}
                      {!busy && !done && !err && (
                        <button
                          onClick={() => downloadForChapter(ch.id)}
                          className="text-[11px] px-2.5 py-1 rounded text-white shrink-0"
                          style={{ backgroundColor: '#f43f5e' }}
                        >
                          Tải
                        </button>
                      )}
                      {(done || err) && !busy && (
                        <button
                          onClick={() => downloadForChapter(ch.id)}
                          className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 shrink-0"
                          style={{ borderColor: '#27272a', borderWidth: '1px' }}
                          title="Tải lại"
                        >
                          ↻
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              <StepNextBar
                disabled={!allSelectedDownloaded}
                hint={allSelectedDownloaded
                  ? `${selectedList.length} chapter đã sẵn trên đĩa`
                  : `Còn ${selectedList.length - selectedList.filter(c => (localPaths.get(c.id)?.length ?? 0) > 0).length} chapter chưa tải`}
                label="Tiếp: Voiceover"
                onNext={() => setActiveStep(4)}
                onBack={() => setActiveStep(2)}
              />
            </Section>
          )}

          {/* SECTION 4: Voiceover per-chapter (was 3 before adding Download step) */}
          {activeStep === 4 && ws && selectedList.length > 0 && (
            <Section number={4} title="Voiceover script">
              {/* Style picker — controls AI narrator persona for THIS section's gen */}
              <div
                className="mb-4 p-3 rounded-md flex items-center gap-3 flex-wrap"
                style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px' }}
              >
                <span className="text-[11px] uppercase tracking-wider text-zinc-500 shrink-0">Phong cách script</span>
                <select
                  value={(['recap','critic','funny','serious'].includes(ws.defaults.style || '') ? ws.defaults.style : 'recap')}
                  onChange={e => updateDefault({ style: e.target.value })}
                  className="px-2.5 py-1.5 text-sm rounded-md outline-none flex-1 min-w-[260px]"
                  style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                >
                  <option value="recap">Recap kịch tính — HBO documentary narrator</option>
                  <option value="critic">Critic chấm điểm — phê phán + điểm /10 giữa script</option>
                  <option value="funny">Hài hước — witty, jab tropes</option>
                  <option value="serious">Nghiêm túc — straight news report</option>
                </select>
                <span className="text-[10px] text-zinc-600 shrink-0">
                  Đổi style → bấm ↻ regen chapter để áp dụng
                </span>
              </div>

              {/* Aggregate error banner — bubble up any chapter-level gen error */}
              {genError.size > 0 && (
                <div
                  className="mb-3 p-3 rounded-md text-xs"
                  style={{ backgroundColor: 'rgba(244, 63, 94, 0.12)', borderColor: 'rgba(244, 63, 94, 0.4)', borderWidth: '1px', color: '#fda4af' }}
                >
                  <div className="font-medium mb-1">Có lỗi khi gen voiceover:</div>
                  {Array.from(genError.entries()).map(([chId, msg]) => {
                    const ch = ws?.chapters.find(c => c.id === chId)
                    return (
                      <div key={chId} className="font-mono text-[11px] leading-relaxed break-words">
                        Ch {ch?.number || chId}: {msg}
                      </div>
                    )
                  })}
                  <div className="text-[10px] text-rose-300/70 mt-2">
                    Mở DevTools (Ctrl+Shift+I) → tab Console → tìm log "[Voiceover]" để xem chi tiết.
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between mb-4">
                <p className="text-xs text-zinc-500">
                  {segments.size} / {selectedList.length} chapter đã có script
                </p>
                <button
                  onClick={generateForAllSelected}
                  disabled={genBusy.size > 0}
                  className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors disabled:opacity-50"
                  style={{ backgroundColor: '#f43f5e' }}
                >
                  {genBusy.size > 0 ? `Đang gen... (${genBusy.size})` : 'Gen tất cả chương thiếu'}
                </button>
              </div>

              <div className="space-y-3">
                {selectedList.map(ch => {
                  const list = segments.get(ch.id)
                  const busy = genBusy.has(ch.id)
                  const phaseMsg = genPhase.get(ch.id)
                  const errMsg = genError.get(ch.id)
                  const expanded = expandedChapter === ch.id
                  return (
                    <div
                      key={ch.id}
                      className="rounded-lg overflow-hidden"
                      style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px' }}
                    >
                      {/* Chapter header row */}
                      <div className="px-4 py-3 flex items-center gap-3">
                        <span className="text-sm font-medium text-zinc-100 shrink-0">Ch {ch.number}</span>
                        {ch.title && <span className="text-sm text-zinc-400 truncate flex-1">— {ch.title}</span>}
                        {!ch.title && <span className="flex-1" />}

                        {list && !busy && (() => {
                          const totalChars = list.reduce((s, x) => s + (x.text?.length || 0), 0)
                          const estSec = Math.round(totalChars / 12) // ~12 chars/sec spoken VN
                          const mm = Math.floor(estSec / 60)
                          const ss = estSec % 60
                          return (
                            <span className="text-[11px] text-zinc-500 shrink-0">
                              {list.length} seg · ~{mm}:{ss.toString().padStart(2, '0')}
                            </span>
                          )
                        })()}

                        {busy ? (
                          <span className="text-[11px] text-amber-300 shrink-0">Đang gen...</span>
                        ) : list ? (
                          <>
                            <button
                              onClick={() => setExpandedChapter(expanded ? null : ch.id)}
                              className="text-[11px] px-2.5 py-1 rounded font-medium text-white"
                              style={{ backgroundColor: expanded ? '#27272a' : '#f43f5e' }}
                            >
                              {expanded ? 'Thu gọn' : 'Edit'}
                            </button>
                            <button
                              onClick={() => generateForChapter(ch.id)}
                              className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-100"
                              style={{ borderColor: '#27272a', borderWidth: '1px' }}
                              title="Re-generate"
                            >
                              ↻
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => generateForChapter(ch.id)}
                            className="text-[11px] px-3 py-1.5 rounded font-medium text-white"
                            style={{ backgroundColor: '#f43f5e' }}
                          >
                            Gen
                          </button>
                        )}
                      </div>

                      {/* Progress bar (visible during gen) */}
                      {busy && (
                        <div
                          className="px-4 py-3"
                          style={{ borderTopColor: '#27272a', borderTopWidth: '1px', backgroundColor: '#0a0a0b' }}
                        >
                          <div className="flex items-center gap-2 mb-2 text-[11px] text-amber-300">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
                            <span className="font-medium">{phaseMsg || 'Đang chuẩn bị...'}</span>
                          </div>
                          {/* Indeterminate progress bar — animate-pulse opacity + 100% width */}
                          <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: '#18181b' }}>
                            <div
                              className="h-full animate-pulse"
                              style={{
                                width: '60%',
                                background: 'linear-gradient(90deg, transparent, #f59e0b 50%, transparent)'
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Error */}
                      {errMsg && (
                        <div
                          className="px-4 py-2 text-[11px]"
                          style={{ backgroundColor: 'rgba(244, 63, 94, 0.08)', color: '#fda4af', borderTopColor: '#27272a', borderTopWidth: '1px' }}
                        >
                          {errMsg}
                        </div>
                      )}

                      {/* Segments editor */}
                      {list && expanded && (
                        <div className="p-4 space-y-3" style={{ borderTopColor: '#27272a', borderTopWidth: '1px' }}>
                          {list.map((seg, i) => {
                            const chars = seg.text?.length || 0
                            const estSec = Math.round(chars / 12)
                            const panelSpan = Math.max(1, (seg.panelEnd ?? 0) - (seg.panelStart ?? 0) + 1)
                            return (
                              <div
                                key={i}
                                className="rounded-lg overflow-hidden"
                                style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px' }}
                              >
                                {/* Segment header */}
                                <div
                                  className="px-3 py-2 flex items-center justify-between text-[11px]"
                                  style={{ backgroundColor: 'rgba(0,0,0,0.25)', borderBottomColor: '#27272a', borderBottomWidth: '1px' }}
                                >
                                  <div className="flex items-center gap-3 text-zinc-400">
                                    <span className="font-semibold text-zinc-200">Segment {i + 1}/{list.length}</span>
                                    <span className="text-zinc-600">·</span>
                                    <span>Panel <span className="text-zinc-300">{seg.panelStart}</span> – <span className="text-zinc-300">{seg.panelEnd}</span> ({panelSpan} ảnh)</span>
                                    <span className="text-zinc-600">·</span>
                                    <span>{chars} chữ ~{estSec}s</span>
                                  </div>
                                  <button
                                    onClick={() => removeSegment(ch.id, i)}
                                    className="w-6 h-6 rounded text-zinc-500 hover:text-rose-400 flex items-center justify-center"
                                    title="Xoá segment"
                                  >
                                    ×
                                  </button>
                                </div>
                                {/* Segment body */}
                                <div className="p-3 flex gap-3">
                                  <div className="flex flex-col gap-1.5 shrink-0 w-20">
                                    <label className="text-[10px] uppercase tracking-wider text-zinc-600">Start</label>
                                    <input
                                      type="number"
                                      min={0}
                                      value={seg.panelStart}
                                      onChange={e => updateSegment(ch.id, i, { panelStart: Math.max(0, Number(e.target.value) || 0) })}
                                      className="w-full px-2 py-1.5 text-sm rounded text-center outline-none"
                                      style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                                    />
                                    <label className="text-[10px] uppercase tracking-wider text-zinc-600 mt-1">End</label>
                                    <input
                                      type="number"
                                      min={0}
                                      value={seg.panelEnd}
                                      onChange={e => updateSegment(ch.id, i, { panelEnd: Math.max(0, Number(e.target.value) || 0) })}
                                      className="w-full px-2 py-1.5 text-sm rounded text-center outline-none"
                                      style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                                    />
                                  </div>
                                  <textarea
                                    value={seg.text}
                                    onChange={e => updateSegment(ch.id, i, { text: e.target.value })}
                                    rows={4}
                                    placeholder="Viết text narration cho segment này..."
                                    className="flex-1 px-3 py-2 text-sm rounded outline-none resize-y leading-relaxed"
                                    style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#fafafa', minHeight: 96 }}
                                  />
                                </div>
                              </div>
                            )
                          })}
                          <button
                            onClick={() => addSegment(ch.id)}
                            className="w-full py-2.5 text-xs rounded-md text-zinc-400 hover:text-zinc-100 transition-colors"
                            style={{ borderColor: '#27272a', borderWidth: '1px', borderStyle: 'dashed' }}
                          >
                            + Thêm segment
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <StepNextBar
                disabled={!allSelectedHaveSegments}
                hint={allSelectedHaveSegments ? 'Đủ script cho mọi chapter' : `Còn ${selectedList.length - segments.size} chapter chưa gen`}
                label="Tiếp: Giọng đọc"
                onNext={() => setActiveStep(5)}
                onBack={() => setActiveStep(3)}
              />
            </Section>
          )}

          {/* SECTION 5: Voice + subtitle (was 4) */}
          {activeStep === 5 && ws && selectedList.length > 0 && (
            <Section number={5} title="Giọng đọc + Phụ đề">
              {!voiceMeta ? (
                <p className="text-sm text-zinc-500 italic">Đang tải danh sách voice...</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wider text-zinc-500">Voice</span>
                    <div className="flex gap-1.5">
                      <select
                        value={ws.defaults.voice}
                        onChange={e => updateDefault({ voice: e.target.value })}
                        className="flex-1 px-2.5 py-2 text-sm rounded-md outline-none"
                        style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                      >
                        {voiceMeta.voices.map(v => (
                          <option key={v.key} value={v.key}>{v.label}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          const v = voiceMeta.voices.find(x => x.key === ws.defaults.voice)
                          if (v?.demoUrl) playDemo(v.demoUrl)
                        }}
                        className="px-2.5 py-2 rounded-md text-xs text-zinc-300 hover:text-white shrink-0"
                        style={{ borderColor: '#27272a', borderWidth: '1px' }}
                        title="Demo Google (deterministic)"
                      >
                        ▶
                      </button>
                    </div>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wider text-zinc-500">Ngôn ngữ</span>
                    <select
                      value={ws.defaults.language}
                      onChange={e => updateDefault({ language: e.target.value })}
                      className="px-2.5 py-2 text-sm rounded-md outline-none"
                      style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                    >
                      <option value="vi">Tiếng Việt (vi-VN)</option>
                      <option value="th">ภาษาไทย (th-TH)</option>
                      <option value="en">English (en-US)</option>
                      <option value="ko">한국어 (ko-KR)</option>
                      <option value="ja">日本語 (ja-JP)</option>
                    </select>
                  </label>

                </div>
              )}

              {/* Subtitle config — burned-in caption khi render */}
              <div className="mt-5 pt-4" style={{ borderTopColor: '#27272a', borderTopWidth: '1px' }}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] uppercase tracking-wider text-zinc-500">Phụ đề (burn vào video)</span>
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={ws.defaults.subtitleEnabled !== false}
                      onChange={e => updateDefault({ subtitleEnabled: e.target.checked } as any)}
                      className="accent-rose-500"
                    />
                    Bật phụ đề
                  </label>
                </div>

                {ws.defaults.subtitleEnabled !== false && (
                  <div className="space-y-3">
                    {/* Preset */}
                    <div className="grid grid-cols-4 gap-2">
                      {([
                        { id: 'tiktok',  label: 'TikTok',  size: 56, pos: 'bottom', opacity: 0.85, box: true,  desc: 'Big, bold, dark box' },
                        { id: 'youtube', label: 'YouTube', size: 40, pos: 'bottom', opacity: 0.65, box: true,  desc: 'Standard caption' },
                        { id: 'cinema',  label: 'Cinema',  size: 38, pos: 'bottom', opacity: 0,    box: false, desc: 'No box, shadow only' },
                        { id: 'mini',    label: 'Mini',    size: 30, pos: 'bottom', opacity: 0.4,  box: true,  desc: 'Small, unobtrusive' }
                      ] as const).map(p => {
                        const isActive = (ws.defaults.subtitlePreset || 'tiktok') === p.id
                        return (
                          <button
                            key={p.id}
                            onClick={() => updateDefault({
                              subtitlePreset: p.id,
                              subtitleFontSize: p.size,
                              subtitlePosition: p.pos,
                              subtitleBoxOpacity: p.opacity,
                              subtitleShowBox: p.box
                            } as any)}
                            className="px-2 py-2 rounded-md text-left transition-colors"
                            style={{
                              backgroundColor: isActive ? 'rgba(244, 63, 94, 0.12)' : '#0a0a0b',
                              borderColor: isActive ? 'rgba(244, 63, 94, 0.4)' : '#27272a',
                              borderWidth: '1px'
                            }}
                          >
                            <div className="text-xs font-medium text-zinc-100">{p.label}</div>
                            <div className="text-[10px] text-zinc-500 mt-0.5">{p.desc}</div>
                          </button>
                        )
                      })}
                    </div>

                    {/* Fine tune */}
                    <div className="grid grid-cols-3 gap-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-600">Cỡ chữ</span>
                        <input
                          type="number"
                          min={20}
                          max={96}
                          value={ws.defaults.subtitleFontSize || 42}
                          onChange={e => updateDefault({ subtitleFontSize: Math.max(20, Math.min(96, Number(e.target.value) || 42)) } as any)}
                          className="px-2 py-1.5 text-sm rounded outline-none text-center"
                          style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-600">Vị trí</span>
                        <select
                          value={ws.defaults.subtitlePosition || 'bottom'}
                          onChange={e => updateDefault({ subtitlePosition: e.target.value } as any)}
                          className="px-2 py-1.5 text-sm rounded outline-none"
                          style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                        >
                          <option value="bottom">Dưới</option>
                          <option value="middle">Giữa</option>
                          <option value="top">Trên</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-600">Nền chữ</span>
                        <select
                          value={ws.defaults.subtitleShowBox === false ? 'none' : String(ws.defaults.subtitleBoxOpacity ?? 0.65)}
                          onChange={e => {
                            const v = e.target.value
                            if (v === 'none') {
                              updateDefault({ subtitleShowBox: false } as any)
                            } else {
                              updateDefault({ subtitleShowBox: true, subtitleBoxOpacity: Number(v) } as any)
                            }
                          }}
                          className="px-2 py-1.5 text-sm rounded outline-none"
                          style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
                        >
                          <option value="0.85">Đặc (85%)</option>
                          <option value="0.65">Vừa (65%)</option>
                          <option value="0.4">Mờ (40%)</option>
                          <option value="none">Không nền</option>
                        </select>
                      </label>
                    </div>

                    {/* Preview */}
                    <div
                      className="rounded-md p-4 flex items-end justify-center"
                      style={{
                        background: 'linear-gradient(135deg, #1c1917, #292524)',
                        height: 100,
                        position: 'relative'
                      }}
                    >
                      <div
                        className="rounded"
                        style={{
                          fontSize: Math.max(10, (ws.defaults.subtitleFontSize || 42) / 4),
                          color: 'white',
                          padding: ws.defaults.subtitleShowBox === false ? '0' : '4px 10px',
                          backgroundColor: ws.defaults.subtitleShowBox === false
                            ? 'transparent'
                            : `rgba(0,0,0,${ws.defaults.subtitleBoxOpacity ?? 0.65})`,
                          textShadow: '1px 1px 2px rgba(0,0,0,0.6)',
                          maxWidth: '80%',
                          textAlign: 'center',
                          alignSelf: ws.defaults.subtitlePosition === 'top'
                            ? 'flex-start'
                            : ws.defaults.subtitlePosition === 'middle'
                            ? 'center'
                            : 'flex-end'
                        }}
                      >
                        Đại Lăng ngồi giữa rừng tre vắng lặng...
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <StepNextBar
                disabled={false}
                hint={`Voice: ${ws.defaults.voice} · ${ws.defaults.language.toUpperCase()} · Sub: ${ws.defaults.subtitleEnabled === false ? 'OFF' : (ws.defaults.subtitlePreset || 'tiktok')}`}
                label="Tiếp: Render"
                onNext={() => setActiveStep(6)}
                onBack={() => setActiveStep(4)}
              />
            </Section>
          )}

          {/* SECTION 6: Render (was 5) */}
          {activeStep === 6 && ws && selectedList.length > 0 && (
            <Section number={6} title="Render video">
              <div className="space-y-3">
                {/* Summary */}
                <div className="text-xs text-zinc-400 flex items-center gap-4 flex-wrap">
                  <span>{selectedList.length} chapter</span>
                  <span>·</span>
                  <span>{Array.from(segments.values()).reduce((s, arr) => s + arr.length, 0)} segment tổng</span>
                  <span>·</span>
                  <span>Voice: <span className="text-zinc-200">{ws.defaults.voice}</span></span>
                  <span>·</span>
                  <span>{ws.defaults.language.toUpperCase()}</span>
                </div>

                {/* Render button */}
                <button
                  onClick={handleRender}
                  disabled={renderBusy || !allSelectedHaveSegments}
                  className="w-full py-3 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-50"
                  style={{ backgroundColor: renderBusy ? '#71717a' : '#f43f5e' }}
                >
                  {renderBusy ? 'Đang render...' : (
                    allSelectedHaveSegments
                      ? `🎬 Render ${selectedList.length} chapter → 1 MP4`
                      : 'Gen voiceover cho tất cả chapter trước'
                  )}
                </button>

                {/* Progress */}
                {renderBusy && renderPhase && (
                  <div
                    className="rounded-md p-3 text-xs space-y-1.5"
                    style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px' }}
                  >
                    <div className="flex items-center gap-2 text-zinc-300">
                      <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: '#f43f5e' }} />
                      <span className="uppercase tracking-wider text-[10px] text-zinc-500">{renderPhase.phase}</span>
                      {renderPhase.chapterIdx && renderPhase.chapterTotal && (
                        <span className="text-zinc-500">· chapter {renderPhase.chapterIdx}/{renderPhase.chapterTotal}</span>
                      )}
                      {renderPhase.i != null && renderPhase.total != null && (
                        <span className="text-zinc-500">· {renderPhase.i}/{renderPhase.total}</span>
                      )}
                    </div>
                    {renderPhase.msg && (
                      <div className="text-zinc-400 pl-4 truncate">{renderPhase.msg}</div>
                    )}
                  </div>
                )}

                {/* Error */}
                {renderError && (
                  <div
                    className="px-3 py-2 rounded-md text-xs"
                    style={{ backgroundColor: 'rgba(244, 63, 94, 0.08)', borderColor: 'rgba(244, 63, 94, 0.3)', color: '#fda4af', borderWidth: '1px' }}
                  >
                    {renderError}
                  </div>
                )}

                {/* Output */}
                {renderOutput && (
                  <div
                    className="rounded-md p-3 flex items-center gap-3"
                    style={{ backgroundColor: 'rgba(16, 185, 129, 0.08)', borderColor: 'rgba(16, 185, 129, 0.3)', borderWidth: '1px' }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-emerald-300 font-medium">Render xong</div>
                      <div className="text-[11px] text-zinc-400 truncate font-mono">{renderOutput.outPath}</div>
                    </div>
                    <button
                      onClick={openOutputFolder}
                      className="text-xs px-3 py-1.5 rounded text-zinc-200 hover:text-white shrink-0"
                      style={{ borderColor: '#27272a', borderWidth: '1px' }}
                    >
                      📁 Mở folder
                    </button>
                  </div>
                )}
              </div>
              <StepNextBar
                onBack={() => setActiveStep(5)}
                hint={renderOutput ? 'Hoàn thành — sếp có thể đổi voice/chapter để re-render' : 'Bấm "Render video" ở trên để chạy pipeline'}
              />
            </Section>
          )}

          </div>
        </main>
      </div>

    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'manga'
}

// ─── Pipeline sidebar ────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4 | 5 | 6

interface PipelineNavProps {
  activeStep: Step
  onSelect: (s: Step) => void
  hasWorkspace: boolean
  chaptersSelected: number
  allDownloaded: boolean
  downloadedCount: number
  allHaveSegments: boolean
  renderDone: boolean
}

type StepStatus = 'locked' | 'ready' | 'done'

function PipelineNav({ activeStep, onSelect, hasWorkspace, chaptersSelected, allDownloaded, downloadedCount, allHaveSegments, renderDone }: PipelineNavProps) {
  // Per-step status:
  //   locked → prerequisite unmet (greyed, click ignored)
  //   ready  → reachable, no payload yet
  //   done   → user has produced output for this step
  const steps: { n: Step; title: string; sub: string; status: StepStatus }[] = [
    {
      n: 1, title: 'Nguồn manga', sub: 'Paste link',
      status: hasWorkspace ? 'done' : 'ready'
    },
    {
      n: 2, title: 'Chọn chapter', sub: chaptersSelected ? `${chaptersSelected} chương` : 'Chọn 1+ chương',
      status: !hasWorkspace ? 'locked' : (chaptersSelected ? 'done' : 'ready')
    },
    {
      n: 3, title: 'Tải ảnh', sub: allDownloaded ? `${downloadedCount} chương tải xong` : (chaptersSelected ? `${downloadedCount}/${chaptersSelected} chương` : 'Đợi chọn chapter'),
      status: !chaptersSelected ? 'locked' : (allDownloaded ? 'done' : 'ready')
    },
    {
      n: 4, title: 'Voiceover', sub: allHaveSegments ? 'Đầy đủ script' : 'Gen + edit',
      status: !allDownloaded ? 'locked' : (allHaveSegments ? 'done' : 'ready')
    },
    {
      n: 5, title: 'Giọng đọc', sub: 'Voice + style',
      status: !allDownloaded ? 'locked' : 'ready'
    },
    {
      n: 6, title: 'Render', sub: renderDone ? 'Hoàn thành' : (allHaveSegments ? 'Sẵn sàng' : 'Đợi voiceover'),
      status: !allHaveSegments ? 'locked' : (renderDone ? 'done' : 'ready')
    }
  ]

  return (
    <aside
      className="w-56 shrink-0 overflow-y-auto border-r"
      style={{ backgroundColor: '#111114', borderColor: '#27272a' }}
    >
      <div className="p-3 space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-zinc-600 px-3 pt-2 pb-3">Pipeline</div>
        {steps.map(s => {
          const isActive = activeStep === s.n
          const isLocked = s.status === 'locked'
          return (
            <button
              key={s.n}
              onClick={() => !isLocked && onSelect(s.n)}
              disabled={isLocked}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors disabled:cursor-not-allowed"
              style={{
                backgroundColor: isActive ? 'rgba(244, 63, 94, 0.12)' : 'transparent',
                borderColor: isActive ? 'rgba(244, 63, 94, 0.3)' : 'transparent',
                borderWidth: '1px',
                opacity: isLocked ? 0.4 : 1
              }}
            >
              {/* Numbered badge / done check */}
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0"
                style={{
                  backgroundColor: s.status === 'done' ? '#10b981' : (isActive ? '#f43f5e' : '#27272a'),
                  color: s.status === 'done' || isActive ? '#fff' : '#a1a1aa'
                }}
              >
                {s.status === 'done' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : s.n}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="text-[13px] font-medium leading-tight"
                  style={{ color: isActive ? '#fafafa' : '#d4d4d8' }}
                >
                  {s.title}
                </div>
                <div className="text-[10px] text-zinc-500 leading-tight mt-0.5 truncate">
                  {s.sub}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

// ─── Page image — fetch via main process to bypass adblock ────────────────
// Chrome inside Electron sometimes throws net::ERR_BLOCKED_BY_CLIENT when a
// CDN URL contains adblock-trigger keywords ("ad", "banner", "track"...).
// Routing the image through main process via image:fetch IPC and rendering
// as a base64 data URL bypasses the renderer's request filter entirely.

interface PageImageProps {
  url: string
  referer?: string
  alt: string
  className?: string
  style?: React.CSSProperties
}

function PageImage({ url, referer, alt, className, style }: PageImageProps) {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    if (!window.api?.image) return
    setSrc(null)
    setErr(null)
    window.api.image.fetch(url, referer).then(r => {
      if (!mounted) return
      if (r.ok) {
        setSrc(`data:${r.contentType};base64,${r.base64}`)
      } else {
        setErr(r.error)
      }
    }).catch(e => {
      if (mounted) setErr(e?.message || String(e))
    })
    return () => { mounted = false }
  }, [url, referer])

  if (err) {
    return (
      <div
        className={(className || '') + ' bg-rose-950/30 flex items-center justify-center text-rose-300 text-xs p-4'}
        style={{ ...style, minHeight: 120 }}
      >
        Tải ảnh fail: {err}
      </div>
    )
  }
  if (!src) {
    return (
      <div
        className={(className || '') + ' flex items-center justify-center text-zinc-600 text-xs'}
        style={{ ...style, minHeight: 200, backgroundColor: '#18181b' }}
      >
        Đang tải...
      </div>
    )
  }
  return <img src={src} alt={alt} className={className} style={style} loading="lazy" />
}

// ─── Step Next/Back bar ──────────────────────────────────────────────────
// Lives at the bottom of each section, guides user to the next step.
// Hint text on the left explains state; Back/Next buttons on the right.

interface StepNextBarProps {
  onNext?: () => void
  onBack?: () => void
  label?: string
  hint?: string
  disabled?: boolean
}

function StepNextBar({ onNext, onBack, label, hint, disabled }: StepNextBarProps) {
  return (
    <div
      className="mt-5 pt-4 flex items-center gap-3"
      style={{ borderTopColor: '#27272a', borderTopWidth: '1px' }}
    >
      {onBack && (
        <button
          onClick={onBack}
          className="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 transition-colors"
          style={{ borderColor: '#27272a', borderWidth: '1px' }}
        >
          ← Quay lại
        </button>
      )}
      {hint && (
        <span className="text-[11px] text-zinc-500 truncate">{hint}</span>
      )}
      {onNext && (
        <button
          onClick={onNext}
          disabled={disabled}
          className="ml-auto text-xs font-medium px-4 py-2 rounded-md text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: '#f43f5e' }}
        >
          {label || 'Tiếp'} →
        </button>
      )}
    </div>
  )
}

// ─── Section wrapper ─────────────────────────────────────────────────────

function Section({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-xl p-5"
      style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px' }}
    >
      <h2 className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-3 flex items-center gap-2">
        <span
          className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white"
          style={{ backgroundColor: '#f43f5e' }}
        >
          {number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}
