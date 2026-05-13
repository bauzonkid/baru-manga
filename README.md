# Baru-Manga Studio

Electron desktop app that turns manga chapters into AI-narrated cinematic MP4 recaps. Built for content creators making *manga解说* (manga commentary) videos for YouTube, TikTok, and Bilibili.

Paste a manga URL → pick chapters → AI generates voiceover script → Gemini TTS narrates → ffmpeg renders cinematic video with blurred background, panel zoom-in, and burned subtitles → batch concat into one MP4 ready to upload.

---

## What it does

| Step | Input | Output |
|------|-------|--------|
| 1 | Paste manga URL (any site) | Workspace with chapter list |
| 2 | Pick chapters (multi-select) + optionally skip junk pages | Filtered page set |
| 3 | "Gen voiceover" button | JSON segments mapping text → panel ranges |
| 4 | Pick TTS voice (30 Gemini voices) + language | Voice config persisted |
| 5 | "Render" button | Single MP4 covering all selected chapters |

Pipeline runs in the same window — no CLI, no scripts.

---

## Features

- **Multi-site support** via plugin system
  - Built-in: MangaDex (official API), Universal scraper (HTML heuristic + AI fallback), Local folder
  - Add custom sites: drop a `.cjs` adapter into `%APPDATA%/Baru-Manga/plugins/`
  - AI fallback (Gemini Flash) auto-extracts chapter lists when the heuristic fails
- **All-in-one pipeline UI** — left sidebar shows 5 steps; click step to navigate, status badge per step
- **Inline chapter reader** — preview pages without opening external viewer
- **Skip rule per chapter** — drop N pages from start / end (kills banner + next-chapter ads); click-to-exclude individual pages
- **AI voiceover** — Gemini 2.5 Flash Vision reads panels, outputs structured JSON segments with panel ranges
- **5 languages** — Vietnamese, Thai, English, Korean, Japanese
- **30 TTS voices** — Gemini 2.5 TTS via 9router (OpenAI-compatible proxy)
- **WAV cache** — same text+voice+model+language hashes to disk; edits to one segment don't re-TTS the rest
- **Cinematic render** — ffmpeg `filter_complex`: blurred BG + `zoompan` + subtitle burn, 1920×1080 @ 30fps
- **Multi-chapter concat** — render N chapters as one continuous MP4
- **Workspace persistence** — `<userData>/workspaces.json` per manga; resume across restarts
- **License gate** — device-bound keys verified against yohomin.com license server

---

## Tech stack

- Electron 33 + Vite 5 + React 18 + TypeScript + Tailwind 3
- ffmpeg (must be on PATH)
- Node 24
- 9router for LLM + TTS (default endpoint: `https://yohomin.com/v1`, dev override via `NINEROUTER_BASE` env)

---

## Running it (dev)

Requirements:
- Node 24
- ffmpeg on PATH
- (Dev) 9router on `localhost:20128` and Yohomin license server on `localhost:3457` — or skip license gate with `BARU_DEV_BYPASS_LICENSE=1`

```bash
cd app
npm install
npm run electron:dev
```

Or double-click `Baru-Manga.bat` on Windows (auto-sets dev env vars).

---

## Project layout

```
Baru-Manga/
├── Baru-Manga.bat                  Windows launcher (sets dev env, runs electron:dev)
├── HUONG_DAN.md                    Vietnamese user guide
└── app/
    ├── electron/                   Main process
    │   ├── main.cjs                IPC dispatcher
    │   ├── preload.cjs             contextBridge → window.api.*
    │   ├── license.cjs             yohomin.com license verification
    │   ├── workspace.cjs           workspaces.json persistence
    │   ├── ai/
    │   │   ├── router.cjs          Shared 9router client
    │   │   └── scrape.cjs          AI chapter scraper (universal fallback)
    │   ├── plugins/
    │   │   ├── mangadex.cjs        MangaDex API adapter
    │   │   ├── universal.cjs       HTML heuristic + AI fallback
    │   │   ├── local.cjs           Local folder reader
    │   │   ├── _template.example.cjs   Plugin skeleton (loader skips this)
    │   │   └── PLUGINS.md          Plugin authoring guide
    │   └── video/
    │       ├── cache.cjs           TTS WAV cache by content hash
    │       └── cinematic.cjs       ffmpeg filter_complex builder + concat
    └── src/                        Renderer
        ├── App.tsx                 Top-level router + IPC types
        ├── LicenseGate.tsx         License entry UI
        └── views/
            ├── Studio.tsx          All-in-one pipeline (Sections 1–5 with sidebar)
            └── LegacyReader.tsx    Quick reader (legacy 3-pane workflow)
```

---

## Adding a new site

The universal scraper handles most VN/EN manga sites via HTML heuristic + Gemini AI fallback. If a site needs a dedicated adapter (SPA, anti-bot, unusual URL patterns):

1. Open the Studio header → **📁 Plugins** button. The user plugins folder opens in Explorer; `_template.example.cjs` + `PLUGINS.md` are copied in on first open.
2. Copy `_template.example.cjs` → `your-site.cjs`.
3. Implement `parseUrl`, `getManga`, `getChapters`, `getPages`, `getChapter`.
4. Restart the app. Plugin auto-loads. User plugins override built-in by `id`.

Plugin shape:
```js
module.exports = {
  id: 'unique-id',
  name: 'Friendly name',
  capabilities: { search: false, openLocal: false },
  parseUrl(url),         // → null | { kind: 'manga' | 'chapter', id }
  getManga(id),          // → MangaResult
  getChapters(mangaId),  // → Chapter[]
  getPages(chapterId),   // → Page[]
  getChapter(url),       // → { chapter, mangaId }
  search(query)          // → MangaResult[]
}
```

---

## License

Code is open. The Studio gates access via a license key issued by the Yohomin admin panel — device-bound, verified per launch. For dev/contribution, set `BARU_DEV_BYPASS_LICENSE=1` in environment.
