/**
 * Chapter stepper — 3 sequential steps to render a video.
 *
 *   Step 1 — Read & Voiceover    (compact reader + AI gen + edit segments)
 *   Step 2 — Voice & Style       (pick voice + per-segment test)
 *   Step 3 — Render & Output     (one-click full pipeline + result)
 *
 * Each step persists state to the workspace via workspace:upsertChapter so
 * leaving the stepper and coming back resumes where the user left off.
 *
 * State machine: workspace.chapters[i].status drives which step opens:
 *   pending   → Step 1
 *   voiceover → Step 2 (segments already saved)
 *   rendered  → Step 3 result (with re-render option)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

interface ChapterEntry {
  id: string
  number: string
  title?: string
  language?: string
  pageCount?: number
  status: 'pending' | 'voiceover' | 'rendered' | 'error'
  segments?: VoiceoverSegment[]
  mp4Path?: string | null
  ttsHits?: number
  renderedAt?: string | null
}

interface Workspace {
  id: string
  title: string
  cover: string | null
  source: { pluginId: string; mangaId: string; url?: string } | null
  defaults: { voice: string; model: string; language: string; style?: string }
  chapters: ChapterEntry[]
}

interface VoiceoverSegment {
  text: string
  panelStart: number
  panelEnd: number
}

interface VideoProgress {
  phase: 'download' | 'tts' | 'render' | 'concat' | 'done' | 'error'
  i?: number
  total?: number
  msg?: string
  cached?: boolean
  error?: string
}

interface StepperViewProps {
  wsId: string
  chapterId: string
  onBack: () => void
}

type StepIdx = 0 | 1 | 2

export default function StepperView({ wsId, chapterId, onBack }: StepperViewProps) {
  const [ws, setWs] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Loaded pages from plugin (URLs for AI gen + ffmpeg input).
  const [pages, setPages] = useState<{ url: string; index: number }[]>([])
  const [pagesLoading, setPagesLoading] = useState(false)

  // Voiceover segments — edit-able local copy.
  const [segments, setSegments] = useState<VoiceoverSegment[]>([])
  const [generatingVoiceover, setGeneratingVoiceover] = useState(false)

  // Voice settings — inherit from workspace defaults but allow per-chapter override.
  const [voice, setVoice] = useState<string>('Charon')
  const [language, setLanguage] = useState<string>('vi')

  // Render state.
  const [rendering, setRendering] = useState(false)
  const [renderProgress, setRenderProgress] = useState<VideoProgress | null>(null)
  const [renderOutPath, setRenderOutPath] = useState<string | null>(null)

  const [step, setStep] = useState<StepIdx>(0)

  const chapter: ChapterEntry | undefined = useMemo(
    () => ws?.chapters.find(c => c.id === chapterId),
    [ws, chapterId]
  )

  // Load workspace + chapter on mount. Pick step from chapter.status.
  useEffect(() => {
    if (!window.api?.workspace) return
    window.api.workspace.get(wsId).then(r => {
      setLoading(false)
      if (!r.ok || !r.data) { setError(r.error || 'Workspace không tồn tại'); return }
      setWs(r.data)
      const c: ChapterEntry | undefined = r.data.chapters.find((x: ChapterEntry) => x.id === chapterId)
      if (!c) { setError('Chapter không có trong workspace'); return }
      setVoice(r.data.defaults.voice)
      setLanguage(r.data.defaults.language)
      if (c.segments && c.segments.length > 0) setSegments(c.segments)
      if (c.mp4Path) setRenderOutPath(c.mp4Path)
      if (c.status === 'rendered') setStep(2)
      else if (c.status === 'voiceover') setStep(1)
      else setStep(0)
    })
  }, [wsId, chapterId])

  // Listen to render progress.
  useEffect(() => {
    if (!window.api?.video) return
    return window.api.video.onProgress(info => setRenderProgress(info))
  }, [])

  // Lazy-fetch pages when entering step 0 or when needed.
  const ensurePages = useCallback(async () => {
    if (pages.length > 0 || !ws?.source || !window.api?.plugins) return pages
    setPagesLoading(true)
    const r = await window.api.plugins.getPages(ws.source.pluginId, chapterId)
    setPagesLoading(false)
    if (!r.ok) { setError(r.error); return [] }
    setPages(r.data)
    return r.data
  }, [pages, ws, chapterId])

  useEffect(() => { if (step === 0 && ws) ensurePages() }, [step, ws, ensurePages])

  const handleGenerateVoiceover = async () => {
    if (!ws || !window.api?.image || !window.api?.ai || !window.api?.chapter) return
    const pgs = await ensurePages()
    if (pgs.length === 0) return
    setGeneratingVoiceover(true)
    setError(null)

    // Register referer for hotlink-protected CDNs.
    const sourceUrl = ws.source?.url
    let referer: string | undefined
    if (sourceUrl) {
      try { referer = new URL(sourceUrl).origin + '/' } catch { /* ignore */ }
    } else if (ws.source?.pluginId === 'mangadex') {
      referer = 'https://mangadex.org/'
    }
    if (referer) await window.api.chapter.registerReferer(pgs.map(p => p.url), referer)

    // Fetch every page → base64.
    const images: { base64: string; mimeType: string }[] = []
    for (const p of pgs) {
      if (p.url.startsWith('file://')) continue
      const r = await window.api.image.fetch(p.url, referer)
      if (!r.ok) continue
      images.push({ base64: r.base64, mimeType: r.contentType })
    }

    const r = await window.api.ai.voiceoverScript({
      images,
      language: language as any,
      mangaTitle: ws.title,
      chapterTitle: chapter ? `Ch ${chapter.number}${chapter.title ? ' — ' + chapter.title : ''}` : undefined
    })
    setGeneratingVoiceover(false)
    if (!r.ok) { setError(r.error); return }
    setSegments(r.data.segments)
    // Persist to workspace
    if (chapter && window.api.workspace) {
      await window.api.workspace.upsertChapter(wsId, {
        ...chapter,
        segments: r.data.segments,
        status: 'voiceover'
      })
    }
  }

  const handleEditSegment = (idx: number, text: string) => {
    setSegments(prev => prev.map((s, i) => i === idx ? { ...s, text } : s))
  }

  const handleSaveSegments = async () => {
    if (!chapter || !window.api?.workspace) return
    await window.api.workspace.upsertChapter(wsId, { ...chapter, segments, status: 'voiceover' })
  }

  const handleRender = async () => {
    if (!ws || !chapter || !window.api?.video || !window.api?.workspace) return
    if (segments.length === 0) { setError('Chưa có voiceover. Quay lại Step 1.'); return }
    const pgs = await ensurePages()
    if (pgs.length === 0) return

    setRendering(true)
    setRenderOutPath(null)
    setRenderProgress({ phase: 'download', msg: 'Bắt đầu...' })
    setError(null)

    const bcp47 = ({ vi: 'vi-VN', th: 'th-TH', en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' } as Record<string, string>)[language] || 'en-US'
    const sourceUrl = ws.source?.url
    let referer: string | undefined
    if (sourceUrl) { try { referer = new URL(sourceUrl).origin + '/' } catch { /* ignore */ } }
    else if (ws.source?.pluginId === 'mangadex') referer = 'https://mangadex.org/'

    const r = await window.api.video.render({
      pageUrls: pgs.map(p => p.url),
      referer,
      segments,
      voice,
      model: ws.defaults.model,
      language: bcp47,
      mangaSlug: ws.title,
      chapterSlug: `ch-${chapter.number}${chapter.title ? '-' + chapter.title : ''}`
    })
    setRendering(false)
    if (!r.ok) { setError(r.error); return }
    setRenderOutPath(r.data.outPath)
    await window.api.workspace.upsertChapter(wsId, {
      ...chapter,
      segments,
      mp4Path: r.data.outPath,
      ttsHits: r.data.ttsHits,
      renderedAt: new Date().toISOString(),
      status: 'rendered'
    })
  }

  const handleOpenFolder = async () => {
    if (!renderOutPath || !window.api?.video) return
    await window.api.video.openFolder(renderOutPath)
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center bg-bg text-muted text-sm">Đang load...</div>
  }
  if (!ws || !chapter) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-bg gap-3">
        <div className="text-rose-400">{error || 'Không có dữ liệu'}</div>
        <button onClick={onBack} className="btn-ghost text-sm py-2 px-4">← Series</button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Top bar */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-panel/40">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onBack} className="text-sm text-muted hover:text-zinc-100 shrink-0">← Series</button>
          <div className="min-w-0">
            <h1 className="font-semibold text-sm truncate">{ws.title}</h1>
            <p className="text-xs text-muted truncate">Ch {chapter.number}{chapter.title ? ' — ' + chapter.title : ''}</p>
          </div>
        </div>

        {/* Stepper indicator */}
        <div className="flex items-center gap-2 text-xs">
          {(['Voiceover', 'Voice', 'Render'] as const).map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <button
                onClick={() => setStep(i as StepIdx)}
                className={`px-3 py-1.5 rounded-full transition-colors ${
                  step === i
                    ? 'bg-accent text-white'
                    : (step > i ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-panel text-muted border border-border')
                }`}
              >
                {step > i ? '✓ ' : ''}{i + 1}. {label}
              </button>
              {i < 2 && <span className="text-muted">→</span>}
            </div>
          ))}
        </div>
      </header>

      {error && (
        <div className="px-6 py-2 bg-rose-500/10 border-b border-rose-500/30 text-sm text-rose-300 flex items-center justify-between">
          <span>{error}</span>
          <button className="text-xs hover:text-rose-100" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <main className="flex-1 overflow-hidden flex">
        {/* Step 1 — Voiceover */}
        {step === 0 && (
          <Step1Voiceover
            pages={pages}
            pagesLoading={pagesLoading}
            segments={segments}
            generating={generatingVoiceover}
            referer={ws.source?.pluginId === 'mangadex' ? 'https://mangadex.org/' : (ws.source?.url ? (new URL(ws.source.url).origin + '/') : '')}
            onGenerate={handleGenerateVoiceover}
            onEdit={handleEditSegment}
            onSave={handleSaveSegments}
            onNext={() => setStep(1)}
          />
        )}

        {step === 1 && (
          <Step2Voice
            voice={voice}
            setVoice={setVoice}
            language={language}
            setLanguage={setLanguage}
            segments={segments}
            wsDefault={ws.defaults}
            onSaveDefaults={async () => {
              if (!window.api?.workspace) return
              await window.api.workspace.update(wsId, {
                defaults: { ...ws.defaults, voice, language }
              })
            }}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <Step3Render
            rendering={rendering}
            renderProgress={renderProgress}
            outPath={renderOutPath}
            chapter={chapter}
            onRender={handleRender}
            onOpenFolder={handleOpenFolder}
            onBack={() => setStep(1)}
          />
        )}
      </main>
    </div>
  )
}

// ─── Step 1: Voiceover ────────────────────────────────────────────────────

function Step1Voiceover(props: {
  pages: { url: string; index: number }[]
  pagesLoading: boolean
  segments: VoiceoverSegment[]
  generating: boolean
  referer: string
  onGenerate: () => void
  onEdit: (idx: number, text: string) => void
  onSave: () => void
  onNext: () => void
}) {
  const { pages, pagesLoading, segments, generating, onGenerate, onEdit, onSave, onNext } = props
  return (
    <>
      {/* Left: compact reader */}
      <div className="w-[360px] border-r border-border overflow-y-auto bg-panel/20">
        {pagesLoading ? (
          <div className="p-6 text-center text-sm text-muted">Đang load panels...</div>
        ) : (
          <div className="space-y-1 p-2">
            {pages.map(p => (
              <img key={p.index} src={p.url} loading="lazy" className="w-full block rounded" alt={`Page ${p.index + 1}`} />
            ))}
          </div>
        )}
      </div>

      {/* Right: AI voiceover */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Step 1 — Voiceover script</h2>
            <button
              onClick={onGenerate}
              disabled={generating || pages.length === 0}
              className="btn-primary text-sm py-2 px-4"
            >
              {generating ? 'Đang gen...' : segments.length > 0 ? '↻ Re-gen voiceover' : '🎙 Tạo voiceover (AI)'}
            </button>
          </div>

          {segments.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted bg-panel border border-border rounded-lg">
              Chưa có script. Bấm <strong>Tạo voiceover</strong> để AI đọc {pages.length} panels và viết.
            </div>
          ) : (
            <>
              <p className="text-xs text-muted mb-3">{segments.length} segments — chỉnh text trước khi sang Step 2.</p>
              <div className="space-y-2">
                {segments.map((seg, idx) => (
                  <div key={idx} className="bg-panel border border-border rounded p-3">
                    <div className="text-[10px] text-muted font-mono mb-1">
                      #{idx + 1} · panels {seg.panelStart}{seg.panelEnd !== seg.panelStart ? `–${seg.panelEnd}` : ''}
                    </div>
                    <textarea
                      value={seg.text}
                      onChange={e => onEdit(idx, e.target.value)}
                      rows={3}
                      className="input text-xs leading-relaxed resize-none w-full"
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-4 justify-end">
                <button onClick={onSave} className="btn-ghost text-sm py-2 px-4">💾 Lưu chỉnh sửa</button>
                <button onClick={onNext} className="btn-primary text-sm py-2 px-4">Next: Voice →</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Step 2: Voice & Style ────────────────────────────────────────────────

function Step2Voice(props: {
  voice: string
  setVoice: (v: string) => void
  language: string
  setLanguage: (l: string) => void
  segments: VoiceoverSegment[]
  wsDefault: { voice: string; model: string; language: string }
  onSaveDefaults: () => void
  onBack: () => void
  onNext: () => void
}) {
  const { voice, setVoice, language, setLanguage, segments, wsDefault, onSaveDefaults, onBack, onNext } = props
  const [voices, setVoices] = useState<{ key: string; label: string; demoUrl: string }[]>([])
  const [demoUrl, setDemoUrl] = useState<string | null>(null)
  const [testingIdx, setTestingIdx] = useState<number | null>(null)
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api?.tts) return
    window.api.tts.meta().then(r => { if (r.ok) setVoices(r.data.voices) })
  }, [])

  const playDemo = () => {
    const v = voices.find(x => x.key === voice)
    if (v) setDemoUrl(v.demoUrl)
  }

  const testSegment = async (idx: number) => {
    if (!window.api?.tts) return
    const seg = segments[idx]
    if (!seg) return
    setTestingIdx(idx)
    if (testAudioUrl) URL.revokeObjectURL(testAudioUrl)
    const bcp47 = ({ vi: 'vi-VN', th: 'th-TH', en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' } as Record<string, string>)[language] || 'en-US'
    const r = await window.api.tts.speak({
      text: seg.text,
      voice,
      model: wsDefault.model,
      language: bcp47
    })
    setTestingIdx(null)
    if (!r.ok) return
    const bin = atob(r.data.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'audio/wav' })
    setTestAudioUrl(URL.createObjectURL(blob))
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        <h2 className="text-lg font-semibold mb-4">Step 2 — Voice & ngôn ngữ</h2>

        <div className="bg-panel border border-border rounded-lg p-4 mb-4 space-y-3">
          <div>
            <label className="label">Voice (30 giọng Gemini)</label>
            <div className="flex gap-2">
              <select className="input flex-1" value={voice} onChange={e => setVoice(e.target.value)}>
                {voices.length === 0 && <option value="">Loading...</option>}
                {voices.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
              </select>
              <button className="btn-ghost text-xs py-2 px-3 shrink-0" onClick={playDemo}>▶ Demo Google</button>
            </div>
            <p className="text-[10px] text-muted mt-1">Demo Google = sample tiếng Anh chính thức, deterministic, không variance.</p>
          </div>

          <div>
            <label className="label">Ngôn ngữ output</label>
            <div className="grid grid-cols-5 gap-1">
              {(['vi', 'th', 'en', 'ko', 'ja'] as const).map(l => (
                <button
                  key={l}
                  onClick={() => setLanguage(l)}
                  className={`py-1.5 text-[11px] rounded border transition-colors ${
                    language === l
                      ? 'bg-accent/15 border-accent/40 text-accent'
                      : 'bg-bg border-border text-muted hover:text-zinc-100'
                  }`}
                >
                  {l === 'vi' ? 'VN' : l === 'th' ? 'TH' : l === 'en' ? 'EN' : l === 'ko' ? '한국' : '日本'}
                </button>
              ))}
            </div>
          </div>

          <button onClick={onSaveDefaults} className="btn-ghost w-full text-xs py-1.5">
            💾 Lưu làm default cho bộ này
          </button>
        </div>

        {demoUrl && (
          <div className="mb-4">
            <p className="text-[10px] text-muted mb-1">Demo Google ({voice}):</p>
            <audio controls src={demoUrl} className="w-full h-8" />
          </div>
        )}

        <h3 className="text-sm font-medium mb-2">Thử từng segment</h3>
        <p className="text-[10px] text-muted mb-3">
          Click "▶ Đọc thử" — Gemini gen với voice + language hiện tại. Variance đôi chút (preview).
        </p>
        <div className="space-y-2 mb-4">
          {segments.map((seg, idx) => (
            <div key={idx} className="bg-panel border border-border rounded p-3 flex gap-3">
              <button
                onClick={() => testSegment(idx)}
                disabled={testingIdx !== null}
                className="btn-ghost text-xs py-1 px-2 shrink-0 self-start"
              >
                {testingIdx === idx ? '...' : '▶ Đọc'}
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-muted font-mono mb-0.5">#{idx + 1}</div>
                <p className="text-xs leading-relaxed line-clamp-3">{seg.text}</p>
              </div>
            </div>
          ))}
        </div>

        {testAudioUrl && <audio controls src={testAudioUrl} className="w-full h-8 mb-4" />}

        <div className="flex gap-2 justify-between">
          <button onClick={onBack} className="btn-ghost text-sm py-2 px-4">← Voiceover</button>
          <button onClick={onNext} className="btn-primary text-sm py-2 px-4">Next: Render →</button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 3: Render & Output ─────────────────────────────────────────────

function Step3Render(props: {
  rendering: boolean
  renderProgress: VideoProgress | null
  outPath: string | null
  chapter: ChapterEntry
  onRender: () => void
  onOpenFolder: () => void
  onBack: () => void
}) {
  const { rendering, renderProgress, outPath, chapter, onRender, onOpenFolder, onBack } = props

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        <h2 className="text-lg font-semibold mb-4">Step 3 — Render video</h2>

        {!outPath && !rendering && (
          <div className="bg-panel border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-muted mb-4">
              Em sẽ download panels → cache TTS từng segment → ffmpeg cinematic (blur BG + zoom panel + subtitle) → concat MP4.
            </p>
            <button onClick={onRender} className="btn-primary text-base py-3 px-8">
              🎬 Render video
            </button>
          </div>
        )}

        {rendering && renderProgress && (
          <div className="bg-panel border border-border rounded-lg p-6 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-zinc-300 font-medium">{phaseLabel(renderProgress.phase)}</span>
              {typeof renderProgress.i === 'number' && typeof renderProgress.total === 'number' && (
                <>
                  <div className="flex-1 h-2 bg-border rounded overflow-hidden">
                    <div className="h-full bg-accent transition-all" style={{ width: `${(renderProgress.i / Math.max(1, renderProgress.total)) * 100}%` }} />
                  </div>
                  <span className="text-muted font-mono text-xs">{renderProgress.i}/{renderProgress.total}</span>
                </>
              )}
            </div>
            {renderProgress.phase === 'tts' && (
              <p className="text-[10px] text-muted">Segment {renderProgress.i}: {renderProgress.cached ? 'cache hit ✓' : 'gen TTS...'}</p>
            )}
            {renderProgress.msg && <p className="text-[10px] text-muted">{renderProgress.msg}</p>}
          </div>
        )}

        {outPath && !rendering && (
          <div className="bg-panel border border-emerald-500/30 rounded-lg p-6">
            <div className="flex items-start gap-4">
              <span className="text-3xl">🎬</span>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-emerald-300 mb-1">Render xong!</h3>
                <p className="text-xs text-muted mb-3 break-all font-mono">{outPath}</p>
                {chapter.renderedAt && (
                  <p className="text-[10px] text-muted mb-3">
                    Rendered: {new Date(chapter.renderedAt).toLocaleString('vi-VN', { hour12: false })} ·
                    {' '}TTS cache: {chapter.ttsHits ?? 0} hits
                  </p>
                )}
                <video controls src={`file:///${outPath.replace(/\\/g, '/')}`} className="w-full rounded mb-3" />
                <div className="flex gap-2">
                  <button onClick={onOpenFolder} className="btn-ghost text-xs py-2 px-3">📁 Mở folder</button>
                  <button onClick={onRender} className="btn-ghost text-xs py-2 px-3">↻ Re-render</button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-between mt-4">
          <button onClick={onBack} className="btn-ghost text-sm py-2 px-4">← Voice</button>
        </div>
      </div>
    </div>
  )
}

function phaseLabel(phase: VideoProgress['phase'] | undefined): string {
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
