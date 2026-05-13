import { useEffect, useState } from 'react'
import type { Chapter, MangaResult, Page } from './types/plugin'
import { LicenseGate, type LicenseStatus } from './LicenseGate'
import Studio from './views/Studio'
import LegacyReader from './views/LegacyReader'

// ─── IPC surface types ──────────────────────────────────────────────────
//
// Each view component imports this Api interface via `window.api`. Keep the
// shape thin — views compose IPC calls themselves rather than App.tsx
// drilling props down. Avoids the 1500-line god-component the legacy reader
// turned into.

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface VoiceoverSegment {
  text: string
  panelStart: number
  panelEnd: number
  /**
   * AI-picked panel indices within [panelStart..panelEnd] that are the
   * KEY visual beats viewers see on screen. Strictly increasing, deduped,
   * subset of the range. 1–5 panels per segment.
   * Backend sanitize falls back to a 3-panel even sample when AI omits.
   */
  keyPanels?: number[]
}

export interface VideoProgress {
  phase: 'download' | 'tts' | 'render' | 'concat' | 'done' | 'error'
  i?: number
  total?: number
  msg?: string
  cached?: boolean
  hash?: string
  outPath?: string
  error?: string
}

interface Api {
  plugins: {
    list: () => Promise<{ id: string; name: string; capabilities: { search: boolean; openLocal: boolean } }[]>
    search: (pluginId: string, query: string) => Promise<IpcResult<MangaResult[]>>
    openLocal: (pluginId: string) => Promise<IpcResult<MangaResult | null>>
    getManga: (pluginId: string, id: string) => Promise<IpcResult<MangaResult>>
    getChapters: (pluginId: string, mangaId: string, opts?: { lang?: string }) => Promise<IpcResult<Chapter[]>>
    getPages: (pluginId: string, chapterId: string) => Promise<IpcResult<Page[]>>
    openByUrl: (url: string) => Promise<IpcResult<
      | { pluginId: string; kind: 'manga'; manga: MangaResult }
      | { pluginId: string; kind: 'chapter'; manga: MangaResult | null; chapter: Chapter }
    >>
    openUserFolder: () => Promise<IpcResult<{ dir: string }>>
  }
  image: {
    fetch: (url: string, referer?: string) => Promise<{ ok: true; contentType: string; base64: string } | { ok: false; error: string }>
  }
  chapter: {
    registerReferer: (pageUrls: string[], referer: string) => Promise<IpcResult<{ hosts: string[]; referer: string }> | { ok: false }>
    download: (opts: { pageUrls: string[]; referer?: string; mangaSlug: string; chapterSlug: string; workspaceId?: string }) => Promise<IpcResult<{ dir: string; localPaths: string[] }>>
    readLocalAsBase64: (paths: string[]) => Promise<IpcResult<{ base64: string; mimeType: string }[]>>
    openDownloadsFolder: (opts?: { workspaceId?: string; mangaSlug?: string }) => Promise<IpcResult<{ dir: string }>>
    onDownloadProgress: (cb: (info: { i: number; total: number; file: string; cached: boolean }) => void) => () => void
  }
  tts: {
    meta: () => Promise<IpcResult<{
      voices: { key: string; label: string; demoUrl: string }[]
      models: { key: string; label: string }[]
      defaultVoice: string
      defaultModel: string
    }>>
    speak: (opts: { text: string; voice: string; model: string; stylePrompt?: string; language?: string; savePath?: string }) =>
      Promise<IpcResult<{ bytes: number; base64: string; savedTo: string | null; model: string; voice: string }>>
  }
  ai: {
    ping: () => Promise<IpcResult<{ count: number; base: string }>>
    listModels: () => Promise<IpcResult<{ all: string[]; visionCapable: string[] }>>
    voiceoverScript: (opts: {
      model?: string
      images: { base64: string; mimeType: string }[]
      language: string
      mangaTitle?: string
      chapterTitle?: string
      style?: 'recap' | 'critic' | 'funny' | 'serious'
    }) => Promise<IpcResult<{
      segments: VoiceoverSegment[]
      model: string
      pagesUsed: number
      pagesTotal: number
    }>>
  }
  video: {
    render: (opts: {
      pageUrls: string[]
      referer?: string
      segments: VoiceoverSegment[]
      voice: string
      model: string
      language: string
      mangaSlug: string
      chapterSlug: string
    }) => Promise<IpcResult<{
      outPath: string
      segments: number
      ttsHits: number
      ttsCalls: number
      clipsDir: string
      bytes: number
    }>>
    renderBatch: (opts: {
      chapters: { chapterSlug: string; pageUrls: string[]; segments: VoiceoverSegment[] }[]
      referer?: string
      voice: string
      model: string
      language: string
      mangaSlug: string
      workspaceId?: string
      subtitleEnabled?: boolean
      subtitleStyle?: {
        fontSize?: number
        position?: 'top' | 'middle' | 'bottom'
        color?: string
        boxOpacity?: number
        showBox?: boolean
        yOffset?: number
      }
    }) => Promise<IpcResult<{
      outPath: string
      chapters: number
      segments: number
      ttsHits: number
      ttsCalls: number
      bytes: number
      timings: { chapterIdx: number; chapterSlug: string; segmentIdx: number; startSec: number; endSec: number; text: string; panelStart: number; panelEnd: number }[]
      totalDuration: number
    }>>
    overlaySubtitle: (opts: {
      workspaceId?: string
      baseMp4Path: string
      timings: { startSec: number; endSec: number; text: string }[]
      subtitleStyle: { fontSize?: number; position?: 'top' | 'middle' | 'bottom'; boxOpacity?: number; showBox?: boolean }
      mangaSlug: string
    }) => Promise<IpcResult<{ outPath: string; srtPath: string; bytes: number }>>
    openFolder: (videoPath: string) => Promise<IpcResult<unknown>>
    onProgress: (cb: (info: VideoProgress) => void) => () => void
  }
  license: {
    status: () => Promise<IpcResult<LicenseStatus>>
    setKey: (key: string) => Promise<IpcResult<LicenseStatus>>
    clear: () => Promise<IpcResult<{ configured: boolean; lastStatus: string }>>
    deviceId: () => Promise<IpcResult<{ deviceId: string }>>
  }
  workspace: {
    list: () => Promise<IpcResult<{
      id: string; title: string; cover: string | null
      source: { pluginId: string; mangaId: string; url?: string } | null
      chapterCount: number; renderedCount: number; createdAt: string; updatedAt: string
    }[]>>
    get: (id: string) => Promise<IpcResult<any>>
    create: (input: any) => Promise<IpcResult<any>>
    update: (id: string, patch: any) => Promise<IpcResult<any>>
    delete: (id: string) => Promise<IpcResult<{ removed: boolean }>>
    upsertChapter: (workspaceId: string, chapter: any) => Promise<IpcResult<any>>
    removeChapter: (workspaceId: string, chapterId: string) => Promise<IpcResult<any>>
    scanPages: (workspaceId: string, chapters: { id: string; number: string }[]) => Promise<IpcResult<Record<string, string[]>>>
    saveSegments: (workspaceId: string, chapterSlug: string, segments: VoiceoverSegment[]) => Promise<IpcResult<{ path: string }>>
    loadSegments: (workspaceId: string, chapters: { id: string; number: string }[]) => Promise<IpcResult<Record<string, VoiceoverSegment[]>>>
  }
}

declare global {
  interface Window {
    api?: Api
  }
}

type Route =
  | { kind: 'studio' }
  | { kind: 'legacy' }

export default function App() {
  const inElectron = typeof window !== 'undefined' && !!window.api

  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [licenseChecking, setLicenseChecking] = useState(true)
  const [route, setRoute] = useState<Route>({ kind: 'studio' })

  useEffect(() => {
    if (!inElectron || !window.api?.license) {
      // Browser preview — auto-bypass so UI can be tested without Electron.
      setLicenseStatus({ configured: true, bypass: true, label: 'Browser preview' } as LicenseStatus)
      setLicenseChecking(false)
      return
    }
    window.api.license.status().then(r => {
      if (r.ok) setLicenseStatus(r.data)
      else setLicenseStatus({ configured: false, lastStatus: 'unreachable', lastError: r.error })
      setLicenseChecking(false)
    })
  }, [inElectron])

  // ─── License gate ──────────────────────────────────────────────────────
  if (licenseChecking) {
    return (
      <div className="h-full flex items-center justify-center bg-bg">
        <div className="text-muted text-sm">Đang kiểm tra license...</div>
      </div>
    )
  }
  if (licenseStatus && !licenseStatus.configured) {
    return <LicenseGate initialStatus={licenseStatus} onSuccess={s => setLicenseStatus(s)} />
  }

  // ─── Routes ────────────────────────────────────────────────────────────
  if (route.kind === 'studio') {
    return <Studio onOpenLegacy={() => setRoute({ kind: 'legacy' })} />
  }
  // legacy
  return <LegacyReader onBack={() => setRoute({ kind: 'studio' })} />
}
