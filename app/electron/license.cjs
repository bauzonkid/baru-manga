/**
 * License auth — yohomin.com integration.
 *
 * Same pattern as Baru-YTB (baru_api/settings_routes.py) but native Node
 * inside the Electron main process (no Python backend in Baru-Manga).
 *
 * Endpoint: GET https://yohomin.com/api/baru-manga/license/{key}?device_id={uuid}
 *   Success: { ok: true, label, ... }
 *   Failure: HTTP 4xx with { error: "license_not_found" | "device_mismatch" | "revoked" | ... }
 *
 * Persistence layout under <userData>:
 *   device_id        — UUID v4, generated once, survives reinstalls
 *   license.json     — { key, label, lastStatus, lastChecked, maskedKey }
 *
 * Dev bypass: set env BARU_DEV_BYPASS_LICENSE=1 (Baru-Manga.bat does this).
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const LICENSE_SERVER_BASE = process.env.BARU_LICENSE_SERVER || 'https://yohomin.com'
const APP_SLUG = 'baru-manga'  // distinguishes from baru-ytb on the same admin panel
const TIMEOUT_MS = 8000

function deviceIdPath(userData) {
  return path.join(userData, 'device_id')
}

function licenseFilePath(userData) {
  return path.join(userData, 'license.json')
}

/**
 * Stable per-machine UUID. Generated once on first call, persisted to disk.
 * Survives reinstall (userData isn't wiped). NOT derived from hardware so a
 * legit RAM/SSD swap won't lock the user out — just userData clear does.
 */
function getDeviceId(userData) {
  const p = deviceIdPath(userData)
  try {
    const existing = fs.readFileSync(p, 'utf-8').trim()
    if (existing) return existing
  } catch { /* not present */ }
  const id = crypto.randomUUID()
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, id, 'utf-8')
  } catch { /* in-memory fallback only this session */ }
  return id
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return key
  return key.slice(0, 8) + '…'
}

function readLicense(userData) {
  try {
    return JSON.parse(fs.readFileSync(licenseFilePath(userData), 'utf-8'))
  } catch { return null }
}

function writeLicense(userData, data) {
  const p = licenseFilePath(userData)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
}

function clearLicense(userData) {
  try { fs.unlinkSync(licenseFilePath(userData)) } catch { /* ignore */ }
}

/**
 * Verify a key against the license server. Returns:
 *   { status: 'ok',            label }
 *   { status: 'not_found',     error }
 *   { status: 'device_mismatch', error, boundPrefix? }
 *   { status: 'revoked',       error }
 *   { status: 'unreachable',   error }  — transient network / 5xx / Cloudflare
 *   { status: 'unknown',       error }
 */
async function verifyKey(key, userData) {
  const deviceId = getDeviceId(userData)
  const url = `${LICENSE_SERVER_BASE}/api/${APP_SLUG}/license/${encodeURIComponent(key)}?device_id=${encodeURIComponent(deviceId)}`
  let res
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Baru-Manga/license-client', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    return { status: 'unreachable', error: e.message || 'network error' }
  }

  let body = {}
  try {
    const text = await res.text()
    body = text ? JSON.parse(text) : {}
  } catch { /* non-JSON response — body stays {} */ }

  if (res.ok && body.ok === true) {
    return { status: 'ok', label: body.label || null }
  }
  const err = body.error || `http_${res.status}`
  if (res.status === 404 || err === 'license_not_found') {
    return { status: 'not_found', error: err }
  }
  if (err && err.includes('device_mismatch')) {
    return { status: 'device_mismatch', error: err, boundPrefix: body.bound_prefix }
  }
  if (res.status === 403 || (err && err.includes('revoked'))) {
    return { status: 'revoked', error: err }
  }
  if (res.status >= 500 && res.status < 600) {
    return { status: 'unreachable', error: err }
  }
  return { status: 'unknown', error: err }
}

/**
 * Get current license status for the UI. Auto-revalidates against server on
 * every call (cheap — single API hit). The result is cached to disk so the
 * UI shows a stale-OK if the server is briefly down.
 */
async function getStatus(userData) {
  if (process.env.BARU_DEV_BYPASS_LICENSE === '1') {
    return {
      configured: true,
      bypass: true,
      maskedKey: 'DEV-BYPASS',
      label: 'Dev (NINEROUTER_BASE override)',
      lastStatus: 'ok',
      lastChecked: new Date().toISOString()
    }
  }

  const stored = readLicense(userData)
  if (!stored || !stored.key) {
    return { configured: false, lastStatus: 'unknown' }
  }

  const result = await verifyKey(stored.key, userData)
  const next = {
    ...stored,
    maskedKey: maskKey(stored.key),
    lastStatus: result.status,
    lastError: result.error || null,
    lastChecked: new Date().toISOString()
  }
  if (result.label) next.label = result.label
  // Don't delete on transient errors — only on revoke / not_found.
  if (result.status === 'revoked' || result.status === 'not_found' || result.status === 'device_mismatch') {
    // Keep on disk for UI to display the masked key + error,
    // but tagged so app.tsx renders the gate.
    next.configured = false
  } else {
    next.configured = true
  }
  writeLicense(userData, next)
  // Hide raw key from the renderer payload.
  const { key, ...safe } = next
  void key
  return safe
}

/** User pasted a new key. Verify + persist on success. */
async function setKey(rawKey, userData) {
  const key = String(rawKey || '').trim()
  if (!key) throw new Error('empty_key')

  const result = await verifyKey(key, userData)
  const record = {
    key,
    maskedKey: maskKey(key),
    label: result.label || null,
    lastStatus: result.status,
    lastError: result.error || null,
    lastChecked: new Date().toISOString(),
    configured: result.status === 'ok'
  }
  if (result.status === 'ok') {
    writeLicense(userData, record)
  }
  const { key: _k, ...safe } = record
  void _k
  return safe
}

function clear(userData) {
  clearLicense(userData)
  return { configured: false, lastStatus: 'unknown' }
}

module.exports = { getStatus, setKey, clear, getDeviceId, verifyKey, maskKey }
