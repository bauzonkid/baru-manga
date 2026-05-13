/**
 * Full-screen license auth gate. Shown when `license.status()` reports
 * the user has no valid key on disk. Same pattern as Baru-YTB.
 *
 * Key flow:
 *   1. User pastes a key issued by yohomin admin panel
 *   2. Renderer calls window.api.license.setKey(key)
 *   3. Main process verifies with yohomin server, returns status
 *   4. On 'ok' → call onSuccess to unlock main app
 *   5. On error → show error message keyed off `lastStatus`
 */

import { useEffect, useState } from 'react'

export interface LicenseStatus {
  configured: boolean
  bypass?: boolean
  maskedKey?: string | null
  label?: string | null
  lastStatus?: 'ok' | 'not_found' | 'device_mismatch' | 'revoked' | 'unreachable' | 'unknown'
  lastError?: string | null
  lastChecked?: string
}

interface LicenseGateProps {
  initialStatus?: LicenseStatus | null
  onSuccess: (status: LicenseStatus) => void
}

export function LicenseGate({ initialStatus, onSuccess }: LicenseGateProps) {
  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<string>('')

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api) return
    window.api.license?.deviceId().then((r: any) => {
      if (r.ok) setDeviceId(r.data.deviceId)
    })
    // Surface any stored "last error" from the persisted status so user
    // sees why they're seeing the gate (e.g. revoked from previous boot).
    if (initialStatus?.lastStatus && initialStatus.lastStatus !== 'unknown' && initialStatus.lastStatus !== 'ok') {
      setError(messageFor(initialStatus.lastStatus, initialStatus.lastError))
    }
  }, [initialStatus])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const k = keyInput.trim()
    if (!k || busy) return

    setBusy(true)
    setError(null)

    if (typeof window === 'undefined' || !window.api?.license) {
      setError('Electron API không khả dụng (đang ở browser preview).')
      setBusy(false)
      return
    }

    const r = await window.api.license.setKey(k)
    setBusy(false)

    if (!r.ok) {
      setError(r.error || 'Không xác định')
      return
    }
    const status = r.data as LicenseStatus
    if (status.configured && status.lastStatus === 'ok') {
      onSuccess(status)
      return
    }
    setError(messageFor(status.lastStatus, status.lastError))
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-[10%] -top-[10%] h-[40vw] w-[40vw] rounded-full bg-accent/[0.06] blur-[120px]" />
        <div className="absolute -bottom-[10%] -right-[10%] h-[30vw] w-[30vw] rounded-full bg-accent/[0.04] blur-[100px]" />
      </div>

      <main className="w-full max-w-[440px]">
        <div className="flex flex-col gap-6 rounded-2xl border border-border bg-panel p-10 shadow-2xl">
          <header className="flex flex-col items-center gap-3 text-center">
            <div className="w-16 h-16 rounded-2xl bg-accent flex items-center justify-center text-3xl font-bold text-white">
              M
            </div>
            <h1 className="text-2xl font-bold">Baru-Manga</h1>
            <p className="text-sm text-muted leading-relaxed">
              Đọc manga đa nguồn → AI review → render video recap.<br />
              Nhập license key để bắt đầu.
            </p>
          </header>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label htmlFor="license-key" className="label">License Key</label>
              <input
                id="license-key"
                type="text"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                disabled={busy}
                className="input font-mono text-sm"
              />
            </div>

            {error && (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/[0.08] px-3 py-2 text-xs text-rose-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!keyInput.trim() || busy}
              className="btn-primary w-full py-3"
            >
              {busy ? 'Đang xác thực...' : 'Đăng nhập'}
            </button>
          </form>

          <div className="h-px w-full bg-border" />

          <footer className="flex flex-col gap-3 text-center">
            <p className="text-xs text-muted leading-relaxed">
              Chưa có key? Liên hệ <a href="https://t.me/usubaruu" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">@usubaruu</a> trên Telegram.
              Key bind với máy này — không cần nhập lại sau khi login.
            </p>
            {deviceId && (
              <p className="text-[10px] font-mono text-muted">
                Device: {deviceId.slice(0, 8)}…{deviceId.slice(-4)}
              </p>
            )}
          </footer>
        </div>
      </main>
    </div>
  )
}

function messageFor(status: string | undefined, err: string | null | undefined): string {
  switch (status) {
    case 'not_found':
      return 'Key không tồn tại. Kiểm tra lại hoặc liên hệ admin.'
    case 'device_mismatch':
      return 'Key đã bind máy khác. Admin reset device hoặc cấp key mới.'
    case 'revoked':
      return 'Key đã bị thu hồi. Liên hệ admin để cấp key mới.'
    case 'unreachable':
      return 'Server license tạm thời không phản hồi. Thử lại sau ít giây.'
    default:
      return err ? `Lỗi: ${err}` : 'Không xác thực được key.'
  }
}
