# Baru-Manga — Cách dùng

## App chính: Manga Reader + AI Review (qua 9router, KHÔNG cần API key)

**Double-click `Baru-Manga.bat`** → mở Electron window có 3 phần:

1. **Sidebar trái** — chọn nguồn (MangaDex / Local Folder) + search bar
2. **Khu giữa** — list manga → manga detail → reader vertical scroll
3. **Sidebar phải** — AI Review panel với model picker + language + style

### Workflow:

1. Click **MangaDex** (mặc định) trong sidebar trái
2. Gõ tên manga (vd `Kagurabachi`) → bấm Search → grid kết quả hiện ra
3. Click 1 manga → xem detail + danh sách chương (có filter ngôn ngữ EN/VI/中文/日本)
4. Click chương → reader load tất cả trang
5. **Panel phải:**
   - **9router · Online** pill = backend OK
   - **Model**: chọn vision model (mặc định `gemini-3.1-flash-lite-preview`)
   - **Ngôn ngữ output**: VN / 中文 / EN / 日本
   - **Phong cách**: Recap kịch tính (HBO narrator) hoặc Review có chấm điểm (critic, /10)
   - Bấm **"Review chương này"** → output stream về panel

### Yêu cầu:

- **9router phải đang chạy** tại `localhost:20128` (kiểm tra: mở http://localhost:20128 trong browser)
- Internet để search MangaDex + load ảnh
- Node 18+ (Electron + Vite cần)

### 429 (rate limit)?

Tool tự fallback qua model khác trong list vision-capable. Sếp không phải làm gì, chờ vài giây.

---

## Tool legacy: render video MP4 từ folder PNG

**File `legacy-render-video.bat`** chạy Python pipeline cũ (`comic_processor/main.py`):
- Input: folder PNG manga
- Output: video MP4 có voice TTS + cinematic FX

**CẢNH BÁO**: Tool này KHÔNG đi qua 9router. Vẫn cần Gemini API key trực tiếp trong file `.env`. Nếu sếp dùng thì:

1. Tạo file `.env` tại `D:\uSubaru\Baru-Manga\` với nội dung:
   ```
   GEMINI_API_KEY=AIza...
   ```
2. Copy ảnh manga vào `comic_processor/comic_pages/page_001.png`, `page_002.png`...
3. Double-click `legacy-render-video.bat`

→ Em sẽ refactor tool này sang 9router sau khi sếp confirm cần.

---

## Cấu trúc folder

```
D:\uSubaru\Baru-Manga\
├── Baru-Manga.bat              ← TOOL CHÍNH (Electron + 9router)
├── legacy-render-video.bat     ← Tool cũ render MP4 (cần API key)
├── HUONG_DAN.md                ← File này
├── app\                        ← Electron + React + TS source
│   ├── electron\
│   │   ├── main.cjs            ← IPC + 9router proxy
│   │   ├── preload.cjs
│   │   └── plugins\
│   │       ├── mangadex.cjs    ← MangaDex API
│   │       └── local.cjs       ← Local folder reader
│   └── src\
│       ├── App.tsx             ← UI (Library + Reader + ReviewPanel)
│       └── types\plugin.ts
├── comic_processor\            ← Python pipeline (legacy)
├── .venv\                      ← Python venv (chỉ legacy tool cần)
└── run_headless.py             ← Wrapper Python cho legacy
```
