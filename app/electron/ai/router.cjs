/**
 * Shared 9router client — reused by main.cjs IPC handlers AND by plugins
 * that want AI assistance (e.g. universal.cjs AI fallback for chapter
 * scraping). Keep this thin: just the HTTP call. Prompt logic stays in
 * callers so each use-case can tune temperature, max_tokens, etc.
 */

const ROUTER_BASE = process.env.NINEROUTER_BASE || 'https://yohomin.com/v1'
const API_KEY = process.env.NINEROUTER_API_KEY
  || process.env.BARU_API_KEY
  || 'sk-yohomin-9router-bypass'

async function callRouter(model, body) {
  return fetch(`${ROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ ...body, model })
  })
}

module.exports = { callRouter, ROUTER_BASE }
