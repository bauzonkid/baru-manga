/**
 * Legacy 3-pane reader. Rebuilt after accidental delete during Phase 7
 * cleanup. Same functionality as before:
 *   - Left:   Source picker + search bar + paste URL + open local folder
 *   - Center: Manga grid → manga detail → vertical scroll reader
 *   - Right:  AI Review tab + Voiceover tab + TTS panel (voice picker + demos)
 *
 * Quick-flow style (no workspace save) — sếp can paste URL, render video,
 * not bind to a persistent series workspace. Workspace flow stays in
 * HomeView → SeriesView → StepperView for organized projects.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Chapter, MangaResult, Page } from '../types/plugin'
import type { VoiceoverSegment, VideoProgress } from '../App'

type ReviewLanguage = 'vi' | 'th' | 'en' | 'ko' | 'ja'
type ReviewStyle = 'recap' | 'review'
type View = 'idle' | 'results' | 'manga' | 'reader'

interface SourceInfo {
  id: string
  name: string
  capabilities: { search: boolean; openLocal: boolean }
}

interface LegacyReaderProps {
  onBack: () => void
}

const BCP47_MAP: Record<ReviewLanguage, string> = {
  vi: 'vi-VN', th: 'th-TH', en: 'en-US', ko: 'ko-KR', ja: 'ja-JP'
}

export default function LegacyReader({ onBack }: LegacyReaderProps) {
  const inElectron = typeof window !== 'undefined' && !!window.api

  // Source + search state
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [activeSourceId, setActiveSourceId] = useState('')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<MangaResult[]>([])

  // Manga / chapter / reader state
  const [currentManga, setCurrentManga] = useState<MangaResult | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [chapterFilter, setChapterFilter] = useState('en')
  const [currentChapter, setCurrentChapter] = useState<Chapter | null>(null)
  const [pages, setPages] = useState<Page[]>([])
  const [pagesLoading, setPagesLoading] = useState(false)

  const [view, setView] = useState<View>('idle')
  const [error, setError] = useState<string | null>(null)

  // Download
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<{ done: number; total: number; file: string } | null>(null)
  const [downloadResult, setDownloadResult] = useState<{ dir: string; count: number } | null>(null)

  // 9router + AI
  const [routerStatus, setRouterStatus] = useState<'unknown' | 'online' | 'offline'>('unknown')
  const [visionModels, setVisionModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [maxPages, setMaxPages] = useState(60)

  // Review
  const [reviewLanguage, setReviewLanguage] = useState<ReviewLanguage>('vi')
  const [reviewStyle, setReviewStyle] = useState<ReviewStyle>('review')
  const [reviewText, setReviewText] = useState('')
  const [reviewing, setReviewing] = useState(false)

  // Voiceover
  const [voiceoverSegments, setVoiceoverSegments] = useState<VoiceoverSegment[]>([])
  const [generatingVoiceover, setGeneratingVoiceover] = useState(false)
  const [playingSegmentIdx, setPlayingSegmentIdx] = useState<number | null>(null)
  const [outputTab, setOutputTab] = useState<'review' | 'voiceover'>('review')

  // TTS
  const [ttsVoices, setTtsVoices] = useState<{ key: string; label: string; demoUrl: string }[]>([])
  const [ttsVoice, setTtsVoice] = useState('Charon')
  const [ttsModel, setTtsModel] = useState('gemini/gemini-2.5-flash-preview-tts')
  const [ttsTesting, setTtsTesting] = useState(false)
  const [ttsAudioUrl, setTtsAudioUrl] = useState<string | null>(null)

  // Render
  const [rendering, setRendering] = useState(false)
  const [renderProgress, setRenderProgress] = useState<VideoProgress | null>(null)
  const [renderResult, setRenderResult] = useState<{ outPath: string; segments: number; ttsHits: number; bytes: number } | null>(null)

  // ── Mount ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!inElectron) return
    window.api!.plugins.list().then(list => {
      setSources(list as SourceInfo[])
      if (list.length > 0) setActiveSourceId(list[0].id)
    })
    window.api!.ai.ping().then(r => setRouterStatus(r.ok ? 'online' : 'offline'))
    window.api!.ai.listModels().then(r => {
      if (r.ok) {
        setVisionModels(r.data.visionCapable)
        if (r.data.visionCapable.length > 0) setSelectedModel(r.data.visionCapable[0])
      }
    })
    window.api!.tts.meta().then(r => {
      if (r.ok) {
        setTtsVoices(r.data.voices)
        setTtsVoice(r.data.defaultVoice)
        setTtsModel(r.data.defaultModel)
      }
    })
    const offDl = window.api!.chapter.onDownloadProgress(info => {
      setDownloadProgress({ done: info.i, total: info.total, file: info.file })
    })
    const offRender = window.api!.video.onProgress(info => setRenderProgress(info))
    return () => { offDl(); offRender() }
  }, [inElectron])

  // Reload chapters when language filter changes
  useEffect(() => {
    if (view === 'manga' && currentManga && activeSourceId && window.api?.plugins) {
      window.api.plugins.getChapters(activeSourceId, currentManga.id, { lang: chapterFilter }).then(r => {
        if (r.ok) setChapters(r.data)
      })
    }
  }, [chapterFilter, view, currentManga, activeSourceId])

  // ── Helpers ──────────────────────────────────────────────────────────
  const refererFor = useCallback((pluginId: string, chapterId: string) => {
    if (pluginId === 'mangadex') return 'https://mangadex.org/'
    if (/^https?:\/\//i.test(chapterId)) {
      try { return new URL(chapterId).origin + '/' } catch { /* */ }
    }
    return ''
  }, [])

  const activeSource = sources.find(s => s.id === activeSourceId)

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleOpenManga = useCallback(async (manga: MangaResult) => {
    if (!inElectron || !activeSource) return
    setCurrentManga(manga)
    setError(null)
    const r = await window.api!.plugins.getChapters(activeSource.id, manga.id, { lang: chapterFilter })
    if (!r.ok) { setError(r.error); return }
    setChapters(r.data)
    setView('manga')
  }, [activeSource, inElectron, chapterFilter])

  const handleOpenByUrl = useCallback(async (url: string) => {
    if (!inElectron) return
    setSearching(true)
    setError(null)
    const r = await window.api!.plugins.openByUrl(url.trim())
    if (!r.ok) { setSearching(false); setError(r.error); return }
    const data = r.data
    setActiveSourceId(data.pluginId)

    if (data.kind === 'manga') {
      setCurrentManga(data.manga)
      const ch = await window.api!.plugins.getChapters(data.pluginId, data.manga.id, { lang: chapterFilter })
      if (ch.ok) setChapters(ch.data)
      setSearching(false)
      setView('manga')
      return
    }
    setCurrentManga(data.manga)
    setCurrentChapter(data.chapter)
    setPagesLoading(true)
    setReviewText('')
    setVoiceoverSegments([])
    const pg = await window.api!.plugins.getPages(data.pluginId, data.chapter.id)
    setPagesLoading(false)
    setSearching(false)
    if (!pg.ok) { setError(pg.error); return }
    const ref = refererFor(data.pluginId, data.chapter.id)
    if (ref) await window.api!.chapter.registerReferer(pg.data.map(p => p.url), ref)
    setPages(pg.data)
    setView('reader')
  }, [chapterFilter, inElectron, refererFor])

  const handleSearch = useCallback(async () => {
    if (!inElectron || !query.trim()) return
    const q = query.trim()
    if (/^https?:\/\//i.test(q)) { await handleOpenByUrl(q); return }
    if (!activeSource) return
    setSearching(true)
    setError(null)
    const r = await window.api!.plugins.search(activeSource.id, q)
    setSearching(false)
    if (!r.ok) { setError(r.error); return }
    setSearchResults(r.data)
    setView('results')
    setCurrentManga(null)
    setCurrentChapter(null)
  }, [activeSource, query, inElectron, handleOpenByUrl])

  const handleOpenLocal = useCallback(async () => {
    if (!inElectron || !activeSource) return
    const r = await window.api!.plugins.openLocal(activeSource.id)
    if (!r.ok) { setError(r.error); return }
    if (!r.data) return
    setSearchResults([r.data])
    setCurrentManga(r.data)
    const ch = await window.api!.plugins.getChapters(activeSource.id, r.data.id)
    if (ch.ok) setChapters(ch.data)
    setView('manga')
  }, [activeSource, inElectron])

  const handleOpenChapter = useCallback(async (chapter: Chapter) => {
    if (!inElectron || !activeSource) return
    setCurrentChapter(chapter)
    setPagesLoading(true)
    setReviewText('')
    setVoiceoverSegments([])
    setDownloadResult(null)
    setRenderResult(null)
    setError(null)
    const r = await window.api!.plugins.getPages(activeSource.id, chapter.id)
    setPagesLoading(false)
    if (!r.ok) { setError(r.error); return }
    const ref = refererFor(activeSource.id, chapter.id)
    if (ref) await window.api!.chapter.registerReferer(r.data.map(p => p.url), ref)
    setPages(r.data)
    setView('reader')
  }, [activeSource, inElectron, refererFor])

  const handleDownload = useCallback(async () => {
    if (!inElectron || pages.length === 0 || !currentChapter) return
    setDownloading(true)
    setDownloadResult(null)
    setDownloadProgress({ done: 0, total: pages.length, file: '' })
    const ref = refererFor(activeSourceId, currentChapter.id)
    const r = await window.api!.chapter.download({
      pageUrls: pages.map(p => p.url),
      referer: ref || undefined,
      mangaSlug: currentManga?.title || 'untitled',
      chapterSlug: `ch-${currentChapter.number}${currentChapter.title ? '-' + currentChapter.title : ''}`
    })
    setDownloading(false)
    if (!r.ok) { setError(r.error); return }
    setDownloadResult({ dir: r.data.dir, count: r.data.localPaths.length })
  }, [inElectron, pages, currentChapter, currentManga, activeSourceId, refererFor])

  // Image fetch helper (re-used by review + voiceover)
  const fetchImagesAsBase64 = async (): Promise<{ base64: string; mimeType: string }[]> => {
    const out: { base64: string; mimeType: string }[] = []
    const ref = currentChapter ? refererFor(activeSourceId, currentChapter.id) : undefined
    for (const p of pages) {
      if (p.url.startsWith('file://')) continue
      const r = await window.api!.image.fetch(p.url, ref || undefined)
      if (!r.ok) continue
      out.push({ base64: r.base64, mimeType: r.contentType })
    }
    return out
  }

  const handleReview = useCallback(async () => {
    if (!inElectron || pages.length === 0) return
    if (routerStatus === 'offline') { setError('9router offline'); return }
    setReviewing(true)
    setError(null)
    setReviewText('')
    setOutputTab('review')
    const images = await fetchImagesAsBase64()
    const r = await (window.api as any).ai.review({
      model: selectedModel,
      images,
      language: reviewLanguage,
      style: reviewStyle,
      maxPages,
      mangaTitle: currentManga?.title,
      chapterTitle: currentChapter ? `Ch ${currentChapter.number}` : undefined
    })
    setReviewing(false)
    if (!r.ok) { setError(r.error); return }
    setReviewText(r.data.text)
  }, [pages, selectedModel, routerStatus, reviewLanguage, reviewStyle, maxPages, currentManga, currentChapter, inElectron, activeSourceId])

  const handleGenerateVoiceover = useCallback(async () => {
    if (!inElectron || pages.length === 0) return
    if (routerStatus === 'offline') { setError('9router offline'); return }
    setGeneratingVoiceover(true)
    setError(null)
    setVoiceoverSegments([])
    setOutputTab('voiceover')
    const images = await fetchImagesAsBase64()
    const r = await window.api!.ai.voiceoverScript({
      model: selectedModel,
      images,
      language: reviewLanguage,
      mangaTitle: currentManga?.title,
      chapterTitle: currentChapter ? `Ch ${currentChapter.number}` : undefined
    })
    setGeneratingVoiceover(false)
    if (!r.ok) { setError(r.error); return }
    setVoiceoverSegments(r.data.segments)
  }, [pages, selectedModel, routerStatus, reviewLanguage, currentManga, currentChapter, inElectron, activeSourceId])

  const handleEditSegment = (idx: number, text: string) => {
    setVoiceoverSegments(prev => prev.map((s, i) => i === idx ? { ...s, text } : s))
  }

  const handleTtsTest = useCallback(async (overrideText?: string) => {
    if (!inElectron) return
    const defaults: Record<ReviewLanguage, string> = {
      vi: 'Xin chào sếp, đây là test giọng Charon đọc tiếng Việt.',
      th: 'สวัสดีครับ ทดสอบเสียงพากย์',
      en: 'Hello, this is a voice test.',
      ko: '안녕하세요, 음성 테스트입니다.',
      ja: 'こんにちは、音声テストです。'
    }
    const text = overrideText?.trim().slice(0, 2000) || defaults[reviewLanguage]
    setTtsTesting(true)
    if (ttsAudioUrl?.startsWith('blob:')) { URL.revokeObjectURL(ttsAudioUrl); setTtsAudioUrl(null) }
    const bcp47 = BCP47_MAP[reviewLanguage]
    const r = await window.api!.tts.speak({
      text: `Read in ${reviewLanguage === 'vi' ? 'Vietnamese' : reviewLanguage}: ${text}`,
      voice: ttsVoice, model: ttsModel, language: bcp47
    })
    setTtsTesting(false)
    if (!r.ok) { setError(r.error); return }
    const bin = atob(r.data.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    setTtsAudioUrl(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })))
  }, [inElectron, reviewLanguage, ttsVoice, ttsModel, ttsAudioUrl])

  const handleTtsDemo = () => {
    const v = ttsVoices.find(x => x.key === ttsVoice)
    if (!v) return
    if (ttsAudioUrl?.startsWith('blob:')) URL.revokeObjectURL(ttsAudioUrl)
    setTtsAudioUrl(v.demoUrl)
  }

  const handlePlaySegment = (idx: number) => {
    const seg = voiceoverSegments[idx]
    if (!seg) return
    setPlayingSegmentIdx(idx)
    handleTtsTest(seg.text).finally(() => setPlayingSegmentIdx(null))
  }

  const handleRenderVideo = useCallback(async () => {
    if (!inElectron || !currentChapter) return
    if (voiceoverSegments.length === 0) { setError('Tạo voiceover trước'); return }
    if (routerStatus === 'offline') { setError('9router offline'); return }
    setRendering(true)
    setRenderResult(null)
    setRenderProgress({ phase: 'download', msg: 'Bắt đầu...' })
    setError(null)
    const bcp47 = BCP47_MAP[reviewLanguage]
    const ref = refererFor(activeSourceId, currentChapter.id)
    const r = await window.api!.video.render({
      pageUrls: pages.map(p => p.url),
      referer: ref || undefined,
      segments: voiceoverSegments,
      voice: ttsVoice,
      model: ttsModel,
      language: bcp47,
      mangaSlug: currentManga?.title || 'untitled',
      chapterSlug: `ch-${currentChapter.number}${currentChapter.title ? '-' + currentChapter.title : ''}`
    })
    setRendering(false)
    if (!r.ok) { setError(r.error); return }
    setRenderResult({ outPath: r.data.outPath, segments: r.data.segments, ttsHits: r.data.ttsHits, bytes: r.data.bytes })
  }, [inElectron, pages, voiceoverSegments, routerStatus, currentChapter, currentManga, reviewLanguage, activeSourceId, ttsVoice, ttsModel, refererFor])

  const handleOpenVideoFolder = async () => {
    if (renderResult) await window.api!.video.openFolder(renderResult.outPath)
  }

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#0a0a0b' }}>
      <header className="border-b px-6 py-3 flex items-center justify-between shrink-0" style={{ backgroundColor: '#111114', borderColor: '#27272a' }}>
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-sm text-zinc-400 hover:text-zinc-100">← Home</button>
          <div>
            <h1 className="font-semibold text-sm">Quick Reader (legacy)</h1>
            <p className="text-xs text-zinc-500">Paste link → đọc → review → render. Không lưu workspace.</p>
          </div>
        </div>
      </header>

      {error && (
        <div className="px-6 py-2 border-b text-sm flex items-center justify-between" style={{ backgroundColor: 'rgba(244,63,94,0.08)', borderColor: 'rgba(244,63,94,0.3)', color: '#fda4af' }}>
          <span>{error}</span>
          <button className="text-xs hover:text-rose-100" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="flex-1 grid grid-cols-[260px_1fr_380px] gap-0 overflow-hidden">
        {/* SIDEBAR */}
        <aside className="border-r flex flex-col overflow-hidden" style={{ backgroundColor: '#111114', borderColor: '#27272a' }}>
          <div className="p-4 border-b" style={{ borderColor: '#27272a' }}>
            <h2 className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold mb-3 flex items-center justify-between">
              <span>Nguồn</span>
              <span className="text-zinc-600">{sources.length} plugin</span>
            </h2>
            <div className="space-y-1">
              {sources.map(s => (
                <button key={s.id} onClick={() => setActiveSourceId(s.id)}
                  className="w-full text-left px-3 py-2 rounded text-sm transition-colors"
                  style={{
                    backgroundColor: s.id === activeSourceId ? 'rgba(244,63,94,0.12)' : 'transparent',
                    color: s.id === activeSourceId ? '#f43f5e' : '#d4d4d8',
                    borderColor: s.id === activeSourceId ? 'rgba(244,63,94,0.3)' : 'transparent',
                    borderWidth: '1px'
                  }}>
                  {s.name}
                  {!s.capabilities.search && <span className="block text-[10px] text-zinc-600">Chỉ mở local</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="p-4 flex-1 overflow-y-auto space-y-3">
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Paste link hoặc tìm</label>
            <input
              className="w-full rounded px-3 py-2 text-sm outline-none"
              style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
              placeholder="https://... hoặc tên truyện"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
              disabled={searching}
            />
            <p className="text-[10px] text-zinc-600 leading-relaxed">
              URL <code className="text-zinc-500">/chapter/...</code> → mở reader. URL <code className="text-zinc-500">/title/...</code> → manga. Text → search.
            </p>
            <button onClick={handleSearch} disabled={searching || !query.trim()}
              className="w-full py-2 rounded text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: '#f43f5e' }}>
              {searching ? 'Đang xử lý...' : 'Mở / Search'}
            </button>
            {activeSource?.capabilities.openLocal && (
              <button onClick={handleOpenLocal} className="w-full py-2 rounded text-sm" style={{ borderColor: '#27272a', borderWidth: '1px', color: '#d4d4d8' }}>
                Mở folder manga...
              </button>
            )}
          </div>
        </aside>

        {/* MAIN PANE */}
        <section className="overflow-y-auto" style={{ backgroundColor: '#0a0a0b' }}>
          {view === 'idle' && <IdleState />}
          {view === 'results' && <ResultsGrid results={searchResults} onOpen={handleOpenManga} />}
          {view === 'manga' && currentManga && (
            <MangaDetail
              manga={currentManga}
              chapters={chapters}
              chapterFilter={chapterFilter}
              setChapterFilter={setChapterFilter}
              activeSource={activeSource}
              onOpenChapter={handleOpenChapter}
              onBack={() => setView('results')}
            />
          )}
          {view === 'reader' && currentChapter && (
            <ReaderView
              chapter={currentChapter}
              pages={pages}
              pagesLoading={pagesLoading}
              downloading={downloading}
              downloadProgress={downloadProgress}
              downloadResult={downloadResult}
              hasVoiceover={voiceoverSegments.length > 0}
              routerOnline={routerStatus === 'online'}
              rendering={rendering}
              renderProgress={renderProgress}
              renderResult={renderResult}
              onBack={() => setView('manga')}
              onDownload={handleDownload}
              onRender={handleRenderVideo}
              onOpenVideoFolder={handleOpenVideoFolder}
            />
          )}
        </section>

        {/* RIGHT: Review/Voiceover + TTS */}
        <aside className="border-l flex flex-col overflow-hidden" style={{ backgroundColor: '#111114', borderColor: '#27272a' }}>
          <ReviewPanel
            routerStatus={routerStatus}
            visionModels={visionModels}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            maxPages={maxPages}
            setMaxPages={setMaxPages}
            pageCount={pages.length}
            reviewLanguage={reviewLanguage}
            setReviewLanguage={setReviewLanguage}
            reviewStyle={reviewStyle}
            setReviewStyle={setReviewStyle}
            canReview={view === 'reader' && pages.length > 0}
            reviewing={reviewing}
            reviewText={reviewText}
            generatingVoiceover={generatingVoiceover}
            voiceoverSegments={voiceoverSegments}
            outputTab={outputTab}
            setOutputTab={setOutputTab}
            playingSegmentIdx={playingSegmentIdx}
            onReview={handleReview}
            onGenerateVoiceover={handleGenerateVoiceover}
            onEditSegment={handleEditSegment}
            onPlaySegment={handlePlaySegment}
          />
          <TtsPanel
            voices={ttsVoices}
            voice={ttsVoice}
            setVoice={setTtsVoice}
            testing={ttsTesting}
            audioUrl={ttsAudioUrl}
            onDemo={handleTtsDemo}
            onTest={() => handleTtsTest()}
            language={reviewLanguage}
          />
        </aside>
      </div>
    </div>
  )
}

// ─── Sub-components (kept inline for compact rebuild) ────────────────────

function IdleState() {
  return (
    <div className="h-full flex items-center justify-center text-center p-12">
      <div className="max-w-md">
        <div className="text-5xl mb-4 opacity-30">📚</div>
        <h2 className="text-lg font-medium mb-2 text-zinc-100">Bắt đầu</h2>
        <p className="text-sm text-zinc-500">Paste link manga ở sidebar trái → search hoặc mở folder local → click manga → đọc → review/render.</p>
      </div>
    </div>
  )
}

function ResultsGrid({ results, onOpen }: { results: MangaResult[]; onOpen: (m: MangaResult) => void }) {
  return (
    <div className="p-6">
      <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-4">{results.length} kết quả</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {results.map(m => (
          <button key={m.id} onClick={() => onOpen(m)}
            className="text-left rounded-lg overflow-hidden group transition-colors"
            style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px' }}>
            <div className="aspect-[2/3] overflow-hidden" style={{ backgroundColor: '#0a0a0b' }}>
              {m.cover ? <img src={m.cover} alt="" loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                : <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs">No cover</div>}
            </div>
            <div className="p-3">
              <h3 className="text-sm font-medium line-clamp-2 text-zinc-100">{m.title}</h3>
              {m.status && <span className="inline-block mt-2 text-[10px] px-2 py-0.5 rounded-full text-zinc-500" style={{ backgroundColor: '#0a0a0b' }}>{m.status}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function MangaDetail({ manga, chapters, chapterFilter, setChapterFilter, activeSource, onOpenChapter, onBack }: {
  manga: MangaResult
  chapters: Chapter[]
  chapterFilter: string
  setChapterFilter: (l: string) => void
  activeSource?: SourceInfo
  onOpenChapter: (c: Chapter) => void
  onBack: () => void
}) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button onClick={onBack} className="text-sm text-zinc-500 hover:text-zinc-100 mb-4">← Kết quả</button>
      <div className="flex gap-6 mb-6">
        {manga.cover && <img src={manga.cover} className="w-48 aspect-[2/3] object-cover rounded-lg" style={{ borderColor: '#27272a', borderWidth: '1px' }} />}
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-zinc-100 mb-2">{manga.title}</h1>
          {manga.altTitles?.length ? <p className="text-sm text-zinc-500 mb-3">{manga.altTitles.slice(0, 3).join(' • ')}</p> : null}
          {manga.authors?.length ? <p className="text-xs text-zinc-500 mb-2">By {manga.authors.join(', ')}</p> : null}
          {manga.description && <p className="text-sm text-zinc-300 line-clamp-6">{manga.description}</p>}
        </div>
      </div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm uppercase tracking-wide text-zinc-500">{chapters.length} chương</h2>
        {activeSource?.id === 'mangadex' && (
          <select className="rounded px-2 py-1 text-xs outline-none w-32" style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
            value={chapterFilter} onChange={e => setChapterFilter(e.target.value)}>
            <option value="en">English</option><option value="vi">Tiếng Việt</option>
            <option value="zh">中文</option><option value="ja">日本語</option><option value="ko">한국어</option>
          </select>
        )}
      </div>
      <div className="rounded-lg max-h-[60vh] overflow-y-auto" style={{ backgroundColor: '#18181b', borderColor: '#27272a', borderWidth: '1px' }}>
        {chapters.length === 0 ? <div className="p-6 text-center text-sm text-zinc-500">Không có chương với filter này</div>
          : chapters.map(c => (
            <button key={c.id} onClick={() => onOpenChapter(c)}
              className="w-full text-left px-4 py-3 flex items-center justify-between transition-colors hover:bg-zinc-900/60"
              style={{ borderTopWidth: '1px', borderColor: '#27272a' }}>
              <div>
                <span className="text-sm font-medium text-zinc-100">Ch {c.number}</span>
                {c.title && <span className="text-sm text-zinc-300 ml-2">— {c.title}</span>}
              </div>
              <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                {c.pageCount && <span>{c.pageCount}p</span>}
                {c.scanlationGroup && <span className="max-w-[180px] truncate">{c.scanlationGroup}</span>}
                <span className="uppercase">{c.language}</span>
              </div>
            </button>
          ))}
      </div>
    </div>
  )
}

function ReaderView(props: {
  chapter: Chapter
  pages: Page[]
  pagesLoading: boolean
  downloading: boolean
  downloadProgress: { done: number; total: number; file: string } | null
  downloadResult: { dir: string; count: number } | null
  hasVoiceover: boolean
  routerOnline: boolean
  rendering: boolean
  renderProgress: VideoProgress | null
  renderResult: { outPath: string; segments: number; ttsHits: number; bytes: number } | null
  onBack: () => void
  onDownload: () => void
  onRender: () => void
  onOpenVideoFolder: () => void
}) {
  const { chapter, pages, pagesLoading, downloading, downloadProgress, downloadResult,
    hasVoiceover, routerOnline, rendering, renderProgress, renderResult,
    onBack, onDownload, onRender, onOpenVideoFolder } = props

  return (
    <div className="relative">
      <div className="sticky top-0 z-10 backdrop-blur px-6 py-3 flex items-center gap-4 border-b" style={{ backgroundColor: 'rgba(17,17,20,0.95)', borderColor: '#27272a' }}>
        <button onClick={onBack} className="text-sm text-zinc-500 hover:text-zinc-100">← Chương</button>
        <div className="text-sm flex-1 min-w-0 truncate text-zinc-100">
          <span className="font-medium">Ch {chapter.number}</span>
          {chapter.title && <span className="text-zinc-500"> — {chapter.title}</span>}
        </div>
        <span className="text-xs text-zinc-500 shrink-0">{pages.length} trang</span>
        <button onClick={onDownload} disabled={downloading || pages.length === 0}
          className="text-xs shrink-0 py-1.5 px-3 rounded disabled:opacity-50"
          style={{ borderColor: '#27272a', borderWidth: '1px', color: '#d4d4d8' }}>
          {downloading ? (downloadProgress ? `Tải ${downloadProgress.done}/${downloadProgress.total}...` : 'Tải...')
            : downloadResult ? `${downloadResult.count} ✓` : 'Tải về'}
        </button>
        <button onClick={onRender} disabled={rendering || !hasVoiceover || !routerOnline || pages.length === 0}
          className="text-xs shrink-0 py-1.5 px-3 rounded text-white font-medium disabled:opacity-50"
          style={{ backgroundColor: '#f43f5e' }}
          title={!hasVoiceover ? 'Tạo voiceover trước' : !routerOnline ? '9router offline' : 'Render MP4'}>
          {rendering ? phaseShort(renderProgress) : renderResult ? '🎬 ✓' : '🎬 Render'}
        </button>
      </div>

      {(rendering || renderResult || renderProgress?.phase === 'error') && (
        <div className="px-6 py-2 border-b text-xs" style={{ backgroundColor: 'rgba(17,17,20,0.6)', borderColor: '#27272a' }}>
          {rendering && renderProgress && (
            <div className="flex items-center gap-3">
              <span className="text-zinc-300 shrink-0 font-medium">{phaseLabel(renderProgress.phase)}</span>
              {typeof renderProgress.i === 'number' && typeof renderProgress.total === 'number' && (
                <>
                  <div className="flex-1 h-1.5 rounded overflow-hidden" style={{ backgroundColor: '#27272a' }}>
                    <div className="h-full transition-all" style={{ width: `${(renderProgress.i / Math.max(1, renderProgress.total)) * 100}%`, backgroundColor: '#f43f5e' }} />
                  </div>
                  <span className="text-zinc-500 shrink-0 font-mono">{renderProgress.i}/{renderProgress.total}</span>
                </>
              )}
            </div>
          )}
          {!rendering && renderResult && (
            <div className="flex items-center gap-3">
              <p className="text-emerald-300 flex-1">🎬 MP4 {(renderResult.bytes / 1048576).toFixed(1)} MB · {renderResult.segments} segments · cache {renderResult.ttsHits}</p>
              <button onClick={onOpenVideoFolder} className="text-[11px] py-1 px-2 rounded" style={{ borderColor: '#27272a', borderWidth: '1px', color: '#d4d4d8' }}>📁 Folder</button>
            </div>
          )}
        </div>
      )}

      {(downloading || downloadResult) && (
        <div className="px-6 py-2 border-b text-xs" style={{ backgroundColor: 'rgba(17,17,20,0.4)', borderColor: '#27272a' }}>
          {downloading && downloadProgress && (
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded overflow-hidden" style={{ backgroundColor: '#27272a' }}>
                <div className="h-full transition-all" style={{ width: `${(downloadProgress.done / downloadProgress.total) * 100}%`, backgroundColor: '#f43f5e' }} />
              </div>
              <span className="text-zinc-500 shrink-0 font-mono">{downloadProgress.done}/{downloadProgress.total}</span>
            </div>
          )}
          {!downloading && downloadResult && (
            <p className="text-emerald-300">Đã tải {downloadResult.count} trang về <code className="text-zinc-400 text-[10px]">{downloadResult.dir}</code></p>
          )}
        </div>
      )}

      {pagesLoading && <div className="p-12 text-center text-sm text-zinc-500">Đang load...</div>}
      <div className="max-w-[900px] mx-auto py-4 space-y-2">
        {pages.map(p => <img key={p.index} src={p.url} loading="lazy" className="w-full block" alt={`Page ${p.index + 1}`} />)}
      </div>
    </div>
  )
}

function ReviewPanel(props: any) {
  const { routerStatus, visionModels, selectedModel, setSelectedModel, maxPages, setMaxPages, pageCount,
    reviewLanguage, setReviewLanguage, reviewStyle, setReviewStyle, canReview, reviewing, reviewText,
    generatingVoiceover, voiceoverSegments, outputTab, setOutputTab, playingSegmentIdx,
    onReview, onGenerateVoiceover, onEditSegment, onPlaySegment } = props
  const statusPill = {
    unknown: { label: '...', cls: '#52525b' },
    online: { label: 'Online', cls: '#10b981' },
    offline: { label: 'Offline', cls: '#f43f5e' }
  }[routerStatus as 'unknown' | 'online' | 'offline']

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="p-4 border-b" style={{ borderColor: '#27272a' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">AI Review</h2>
          <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: statusPill.cls, borderColor: statusPill.cls, borderWidth: '1px' }}>
            9router · {statusPill.label}
          </span>
        </div>

        <label className="block text-[10px] uppercase tracking-wide text-zinc-500 font-semibold mb-1">Model</label>
        <select className="w-full rounded px-2 py-1.5 text-xs outline-none mb-2" style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
          value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
          {visionModels.length === 0 && <option value="">Auto fallback</option>}
          {visionModels.map((m: string) => <option key={m} value={m}>{m}</option>)}
        </select>

        <label className="block text-[10px] uppercase tracking-wide text-zinc-500 font-semibold mt-3 mb-1">Ngôn ngữ</label>
        <div className="grid grid-cols-5 gap-1 mb-2">
          {(['vi','th','en','ko','ja'] as const).map(l => (
            <button key={l} onClick={() => setReviewLanguage(l)}
              className="py-1.5 text-[11px] rounded transition-colors"
              style={{
                backgroundColor: reviewLanguage === l ? 'rgba(244,63,94,0.12)' : '#0a0a0b',
                color: reviewLanguage === l ? '#f43f5e' : '#a1a1aa',
                borderColor: reviewLanguage === l ? 'rgba(244,63,94,0.3)' : '#27272a',
                borderWidth: '1px'
              }}>
              {l === 'vi' ? 'VN' : l === 'th' ? 'TH' : l === 'en' ? 'EN' : l === 'ko' ? '한국' : '日本'}
            </button>
          ))}
        </div>

        <label className="block text-[10px] uppercase tracking-wide text-zinc-500 font-semibold mt-3 mb-1">Phong cách</label>
        <div className="grid grid-cols-2 gap-1 mb-3">
          {(['recap','review'] as const).map(s => (
            <button key={s} onClick={() => setReviewStyle(s)}
              className="py-1.5 text-[11px] rounded transition-colors"
              style={{
                backgroundColor: reviewStyle === s ? 'rgba(244,63,94,0.12)' : '#0a0a0b',
                color: reviewStyle === s ? '#f43f5e' : '#a1a1aa',
                borderColor: reviewStyle === s ? 'rgba(244,63,94,0.3)' : '#27272a',
                borderWidth: '1px'
              }}>
              {s === 'recap' ? 'Recap kịch tính' : 'Review điểm'}
            </button>
          ))}
        </div>

        <div className="mb-3">
          <div className="flex items-baseline justify-between">
            <label className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Trang gửi AI</label>
            <span className="text-xs text-zinc-500">{pageCount > 0 ? `${Math.min(maxPages, pageCount)} / ${pageCount}` : maxPages}</span>
          </div>
          <input type="range" min={5} max={200} step={5} value={maxPages} onChange={e => setMaxPages(Number(e.target.value))} className="w-full" style={{ accentColor: '#f43f5e' }} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button onClick={onReview} disabled={!canReview || reviewing || routerStatus === 'offline'}
            className="text-xs py-1.5 rounded text-white font-medium disabled:opacity-50" style={{ backgroundColor: '#f43f5e' }}>
            {reviewing ? 'Đang review...' : 'Review'}
          </button>
          <button onClick={onGenerateVoiceover} disabled={!canReview || generatingVoiceover || routerStatus === 'offline'}
            className="text-xs py-1.5 rounded disabled:opacity-50" style={{ borderColor: '#27272a', borderWidth: '1px', color: '#d4d4d8' }}>
            {generatingVoiceover ? 'Đang gen...' : 'Voiceover'}
          </button>
        </div>
      </div>

      <div className="flex border-b" style={{ borderColor: '#27272a' }}>
        <button onClick={() => setOutputTab('review')}
          className="flex-1 py-2 text-xs font-medium transition-colors"
          style={{ color: outputTab === 'review' ? '#f43f5e' : '#71717a', borderBottomColor: outputTab === 'review' ? '#f43f5e' : 'transparent', borderBottomWidth: '2px' }}>
          📄 Review {reviewText && <span className="text-[9px] text-emerald-400">●</span>}
        </button>
        <button onClick={() => setOutputTab('voiceover')}
          className="flex-1 py-2 text-xs font-medium transition-colors"
          style={{ color: outputTab === 'voiceover' ? '#f43f5e' : '#71717a', borderBottomColor: outputTab === 'voiceover' ? '#f43f5e' : 'transparent', borderBottomWidth: '2px' }}>
          🎙 Voiceover {voiceoverSegments.length > 0 && <span className="text-[9px] text-emerald-400">●{voiceoverSegments.length}</span>}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {outputTab === 'review' && (
          <div className="p-4 text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
            {reviewText || <span className="text-zinc-600 italic text-xs">{reviewing ? 'AI đang đọc...' : 'Bấm Review để bắt đầu'}</span>}
          </div>
        )}
        {outputTab === 'voiceover' && (
          <div className="p-3">
            {voiceoverSegments.length === 0
              ? <p className="text-zinc-600 italic text-xs p-2">{generatingVoiceover ? 'AI đang chia segments...' : 'Bấm Voiceover để gen'}</p>
              : <div className="space-y-2">
                  {voiceoverSegments.map((seg: VoiceoverSegment, idx: number) => (
                    <div key={idx} className="rounded p-2" style={{ backgroundColor: 'rgba(10,10,11,0.6)', borderColor: '#27272a', borderWidth: '1px' }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-zinc-500 font-mono">#{idx + 1} · panels {seg.panelStart}{seg.panelEnd !== seg.panelStart ? `–${seg.panelEnd}` : ''}</span>
                        <button onClick={() => onPlaySegment(idx)} disabled={playingSegmentIdx !== null}
                          className="text-[10px] px-2 py-0.5 rounded disabled:opacity-50"
                          style={{ borderColor: '#27272a', borderWidth: '1px', color: '#d4d4d8', backgroundColor: '#18181b' }}>
                          {playingSegmentIdx === idx ? '...' : '▶ Đọc'}
                        </button>
                      </div>
                      <textarea value={seg.text} onChange={e => onEditSegment(idx, e.target.value)} rows={3}
                        className="w-full text-xs leading-relaxed resize-none rounded px-2 py-1 outline-none"
                        style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }} />
                    </div>
                  ))}
                </div>}
          </div>
        )}
      </div>
    </div>
  )
}

function TtsPanel(props: any) {
  const { voices, voice, setVoice, testing, audioUrl, onDemo, onTest, language } = props
  const langLabel = { vi: 'tiếng Việt', th: 'tiếng Thái', en: 'tiếng Anh', ko: 'tiếng Hàn', ja: 'tiếng Nhật' }[language as ReviewLanguage]
  return (
    <div className="border-t p-4 space-y-2 shrink-0" style={{ borderColor: '#27272a' }}>
      <h2 className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">Voice TTS (Gemini)</h2>
      <select className="w-full rounded px-2 py-1.5 text-xs outline-none" style={{ backgroundColor: '#0a0a0b', borderColor: '#27272a', borderWidth: '1px', color: '#e4e4e7' }}
        value={voice} onChange={e => setVoice(e.target.value)}>
        {voices.length === 0 && <option value="">Loading...</option>}
        {voices.map((v: any) => <option key={v.key} value={v.key}>{v.label}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={onDemo} disabled={voices.length === 0} className="text-xs py-1.5 rounded disabled:opacity-50" style={{ borderColor: '#27272a', borderWidth: '1px', color: '#d4d4d8' }}>
          ▶ Demo Google
        </button>
        <button onClick={onTest} disabled={testing} className="text-xs py-1.5 rounded text-white font-medium disabled:opacity-50" style={{ backgroundColor: '#f43f5e' }}>
          {testing ? '...' : 'Đọc thử'}
        </button>
      </div>
      {audioUrl && <audio controls src={audioUrl} className="w-full h-8" />}
      <p className="text-[10px] text-zinc-600 leading-relaxed">
        ▶ Demo = sample EN cố định. Đọc thử = gen từ review text ({langLabel}), Gemini Preview có variance.
      </p>
    </div>
  )
}

function phaseLabel(phase?: VideoProgress['phase']): string {
  switch (phase) {
    case 'download': return '⬇ Tải panels'
    case 'tts': return '🎙 Voice TTS'
    case 'render': return '🎞 Render clips'
    case 'concat': return '🔗 Ghép MP4'
    case 'done': return '✓ Xong'
    case 'error': return '❌ Lỗi'
    default: return ''
  }
}
function phaseShort(p: VideoProgress | null): string {
  if (!p) return '...'
  if (typeof p.i === 'number' && typeof p.total === 'number') return `${p.phase} ${p.i}/${p.total}`
  return p.phase
}
