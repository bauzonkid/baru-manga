# Baru-Manga — Bộ nguyên tắc & Quy trình

Tài liệu sống cho tool. Liệt kê:
- Pipeline 7 step
- Nguyên tắc em ép AI (voiceover gen, panel detect, plugin scrape)
- Logic render + subtitle
- Layout workspace folder
- **Chỗ chỉnh sửa từng rule (UI hoặc code)**

> File này nằm cạnh `plugins/` để dễ tìm. Em update file mỗi khi đổi behavior tool. Sếp đọc đây khi cần biết tool đang làm gì + đổi ở đâu.

---

## Pipeline 6 step

| # | Step | Input | Output |
|---|---|---|---|
| 1 | Nguồn manga | URL hoặc workspace cũ | Workspace JSON + chapter list |
| 2 | Chọn chapter | Workspace + skip rule | Selected chapter IDs |
| 3 | Tải ảnh | Selected chapter | `<ws>/pages/<ch>/page_NNN.jpg` |
| 3.5 | Tách panels (optional) | Pages downloaded | `<ws>/pages/<ch>/_panels/panel_NNN.jpg` |
| 4 | Voiceover | Pages (or panels) + AI | Segments `<ws>/voiceover/<ch>.json` |
| 6 | Render silent | Pages + segments | `<ws>/videos/<slug>__multi__<stamp>.mp4` + timings JSON |
| 7 | Phụ đề + Final | Base MP4 + sub config | `<ws>/videos/<slug>__withsub__<stamp>.mp4` + `.srt` sidecar |

> **Step 5 (Giọng đọc) đã bỏ.** Tool gen video silent (không tiếng). Sếp import vô CapCut để gen TTS theo segment text. Lý do: tránh phụ thuộc 9router TTS + Gemini voice quota, giữ tool nhẹ, sếp kiểm soát giọng + chỉnh sửa dễ hơn trong CapCut. Số step nhảy 4 → 6 vì giữ nguyên id sub/render cũ.

Auto-resume: load workspace → scan disk → jump tới step cao nhất đã làm.

---

## Step 4 Voiceover — nguyên tắc AI

### Default prompt rules (em hiện đang dùng)

```
- ${segCountClause} segments total, ordered by STORY CHRONOLOGY.
  Segment 1 = earliest beat, last segment = closing.
  Not every panel has to be covered — skip filler.
- keyPanels: ${stripCountClause}
  · Panel indices ANY value 0..${totalPanels - 1}
  · MUST scatter by VISUAL RHYTHM, NOT reading order
  · DO NOT pick [5,6,7] unless true action sequence
  · Typical: 1 close-up | 2 setup+payoff | 3 across chapter
  · Can repeat across segments if a panel is so important
  · Order keyPanels ascending within each segment
- VARY keyPanels count across segments (chapter 8 segs ≠ mỗi seg 3 panels)
- Each segment's text is 1–3 sentences. Duration ~ how long viewers
  look at that segment.
- ${persona}  ← (recap/critic/funny/serious)
```

### Strip count auto mode (\${stripCountClause})

Auto mode prompt ép AI **bias toward fewer** (1 or 2 strips) cho hầu hết segment. Chỉ pick 3+ khi scene thật sự cần. Tránh AI default cứng 3 ảnh liền nhau mọi segment.

### Placeholders backend tự substitute

| Placeholder | Resolved giá trị |
|---|---|
| `${segCountClause}` | "5 to 15" (theo ⚙ segmentsMin/Max) |
| `${stripCountClause}` | Auto: "1–5 strips" / Fixed: "EXACTLY N strips" |
| `${totalPanels}` | Số page chapter |
| `${persona}` | Block persona theo style preset |
| `${langName}` | "Vietnamese" / "English" / etc |

### Tunable trong UI

**Section 4 → ⚙ Cài đặt** mở modal:
- **Số segments** min/max (default 5–15)
- **Strip count / segment**: Auto (1–5) hoặc Cố định N
- **AI Temperature** (0.0–1.0, default 0.7)
- **Bộ nguyên tắc AI** — textarea sếp tự rewrite bullets
- **Thứ tự model** — drag reorder Gemini / OpenAI fallback chain

### Tunable trong code

| Mục | File | Line |
|---|---|---|
| DEFAULT_RULES_TEMPLATE backend | `electron/main.cjs` | trong `voiceoverPrompt()` |
| DEFAULT_VOICEOVER_RULES frontend | `src/views/Studio.tsx` | constants top |
| Persona presets | `electron/main.cjs` | `personaByStyle` object |
| VISION_FALLBACK chain | `electron/main.cjs` | const top |
| DEFAULT_GEMINI_MODELS / DEFAULT_OPENAI_MODELS | `src/views/Studio.tsx` | constants top |

### Backend sanitize (sau khi AI trả về)

- keyPanels: dedupe + sort + clamp `[0, N-1]`
- Cap max:
  - Fixed mode → cap = sếp set
  - Auto mode → cap = 5
- Fallback nếu AI rỗng: 1 panel giữa chapter
- panelStart/End derive từ `min/max(keyPanels)` (cho UI editor)

---

## Step 3.5 Tách panels — nguyên tắc

### 2 mode

**A. AI Vision (default)**
- Gửi từng strip qua Gemini Vision (batch 30 strips/call)
- Prompt asks bbox panels: `{ pages: [{ panels: [{ yTopPct, yBottomPct }] }] }`
- ffmpeg crop theo bbox → `panel_NNN.jpg`
- Cost ~$0.005/page (free tier OK với Gemini AI Studio)

**B. CV whitespace (free)**
- vstack all strips → 1 PNG dài
- Scan row brightness → tìm gap (whiteThreshold default 230, minGap 15px)
- Page boundary cuts ALWAYS contribute (mỗi seam giữa strip = 1 cut)
- Merge + dedupe cuts < 30px
- ffmpeg crop tại cuts

### Tunable

- Modal sẽ add sau (TODO). Hiện chỉ default thresholds in code.
- `electron/video/panelSplit.cjs` — params trong `splitChapterPanels()`

---

## Step 6 Render silent — nguyên tắc

### Pipeline mỗi segment

1. Lấy keyPanels từ segment → resolve sang local paths
2. **Duration estimate:** `clamp(text_chars / 12, 2.5, 12)` giây (tốc độ nói tiếng Việt cinematic narration)
3. **Single strip:** filter `[bg blur fill] + [fg fit decrease] + overlay center` → static letterbox
4. **Multi strip:** ffmpeg vstack → combined.png → cùng filter static letterbox
5. **No audio:** ffmpeg không có `-i audio`, không có `-c:a` flag → silent MP4
6. Concat segment clips → final base MP4
7. Per-segment timing (start/end sec) lưu vào `<base>.timings.json` cho Step 7

### Style cố định

- 1920×1080 @ 30fps
- Background blur `boxblur=20:5`
- Foreground fit `force_original_aspect_ratio=decrease`
- No zoom, no scroll, no pan (sếp pick static)
- libx264 preset medium, CRF 20
- No audio track (sếp sẽ add TTS trong CapCut)

### Tunable

- Hiện hardcode trong `electron/video/cinematic.cjs` `renderSegmentScroll()`
- Silent flag pass từ `video:renderBatch` → cinematic
- TODO: Section 6 ⚙ modal cho render mode picker (static/zoom-pan/scroll variants)
- TODO: Chars-per-second slider cho duration estimate (hiện hardcode 12 ch/s)

---

## Step 7 Phụ đề — nguyên tắc

### Subtitle split

Long narration split thành slot ngắn:
1. Pass 1: split sentence boundaries (`. ! ? …`)
2. Pass 2: nếu vẫn dài > maxChars → split clause (`, ; :`)
3. Pass 3: vẫn dài → hard split word

Mỗi chunk = 1 SRT entry. Timing chia đều theo audio segment duration.

### Tunable trong UI

**Section 7:**
- Preset: TikTok / YouTube / Cinema / Mini
- Font size 20–96
- Position: top / middle / bottom
- Background: đặc 85% / vừa 65% / mờ 40% / không nền
- Chia chữ: Ngắn 30 / Vừa 45 / Dài 60 / Rất dài 90 chars

### Render

- ffmpeg `subtitles=` filter với libass force_style
- Re-encode video, copy audio
- Output: `<ws>/videos/<slug>__withsub__<stamp>.mp4` + sidecar `.srt`

---

## Workspace folder layout

```
<userData>/Baru-Manga/
├── workspaces.json                   # metadata index
└── workspaces/
    └── <workspace-id>/
        ├── pages/
        │   ├── ch1/
        │   │   ├── page_001.jpg      # raw download
        │   │   ├── page_002.jpg
        │   │   └── _panels/          # optional Step 3.5 output
        │   │       ├── panel_001.jpg
        │   │       ├── panel_002.jpg
        │   │       └── _meta.json    # bboxes audit
        │   └── ch2/...
        ├── tts/<hash>.wav            # TTS cache, content-hashed
        ├── clips/<ch>/seg_NNN.mp4    # per-segment intermediates
        ├── voiceover/
        │   ├── ch1.json              # saved segments
        │   ├── ch2.json
        │   └── <stamp>.srt           # subtitle sidecar after Step 7
        └── videos/
            ├── <slug>__multi__<stamp>.mp4         # base render
            ├── <slug>__multi__<stamp>.timings.json
            └── <slug>__withsub__<stamp>.mp4       # final with sub
```

`scanPages` IPC prefer `_panels/` > raw `page_*.jpg` khi có. Downstream (voiceover, render) tự pick up panels nếu đã tách.

---

## Plugin system — cách thêm site

Xem `plugins/PLUGINS.md`. Tóm tắt:
- Built-in: `mangadex.cjs`, `universal.cjs` (heuristic + AI fallback), `local.cjs`
- User custom: `%APPDATA%/Baru-Manga/plugins/*.cjs` (override built-in cùng `id`)
- AI scrape fallback: `electron/ai/scrape.cjs` (Gemini đọc HTML khi heuristic fail)

---

## License flow

- License gate: `electron/license.cjs` + `src/LicenseGate.tsx`
- Server: yohomin.com (`BARU_LICENSE_SERVER` env override để dev)
- Device-bound UUID v4 persisted to `<userData>/device_id`
- Dev bypass: `BARU_DEV_BYPASS_LICENSE=1`

---

## Workflow rules em committed (sếp ràng buộc em)

1. Mỗi milestone = 1 message → ship → ASK sếp verify → mới tiếp
2. KHÔNG run parallel changes lớn cùng lúc
3. Backup trước rewrite > 100 dòng
4. KHÔNG dùng shiny tools (Stitch, etc) trước khi simple work
5. Clarify Vietnamese ambiguous phrases trước
6. Verify trong Electron window, không chỉ Node CLI smoke test
7. Tag agent + skill specialists inline mỗi response (CLAUDE.md TIER 0)
8. Feature có cost / AI API / native dep → ASK trước khi code
9. Mỗi edit → commit + push lên `main` (sếp test trên branch)
10. Tag release / GitHub Releases CHỈ khi sếp gõ "release"/"up"/"publish"

---

## Files quan trọng nhất

| Domain | File |
|---|---|
| IPC dispatcher | `electron/main.cjs` |
| AI prompts + sanitize | `electron/main.cjs` `voiceoverPrompt()` + handler |
| Render pipeline | `electron/video/cinematic.cjs` |
| Panel split | `electron/video/panelSplit.cjs` |
| Workspace storage | `electron/workspace.cjs` |
| Plugin loader | `electron/main.cjs` `loadPluginsFromDir()` |
| License check | `electron/license.cjs` |
| Studio UI | `src/views/Studio.tsx` |
| Default constants (rules, models) | `src/views/Studio.tsx` top + `electron/main.cjs` top |

---

## Roadmap (TODO)

- [ ] Section 6 ⚙ modal cho render mode picker (static / zoom-pan / scroll)
- [ ] Section 7 advanced: font color, outline thickness, animation
- [ ] Step 3.5 panel split: expose thresholds + AI/CV mode toggle UI rõ
- [ ] Settings page (license info + signout + output folder picker)
- [ ] Packaging: electron-builder NSIS + electron-updater + GitHub Releases
- [ ] BGM mixing (user upload MP3)
- [ ] Multi-voice (different characters)
