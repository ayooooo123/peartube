// Thin client for the home-media publisher agent (peartube-relay library surface).
// Phase 3 adapter: paired apps call HRPC library-* methods; the host backend
// proxies to the co-installed agent over HTTP when PEARTUBE_LIBRARY_AGENT_URL
// (or opts.endpoint) is set. No agent → honest disabled responses, never throw.

const DEFAULT_TIMEOUT_MS = 15_000

function emptyStatus() {
  return {
    enabled: false,
    folders: 0,
    totalItems: 0,
    durableItems: 0,
    selfOnlyItems: 0,
    pendingApprovalItems: 0,
    failedItems: 0,
    bytes: 0,
    capBytes: 0,
    importsPaused: false,
    hiverelayDetected: false,
    hiverelayEndpoint: null
  }
}

export function createLibraryAgentClient({
  endpoint = globalThis?.process?.env?.PEARTUBE_LIBRARY_AGENT_URL || null,
  fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const base = typeof endpoint === 'string' && endpoint.trim()
    ? endpoint.trim().replace(/\/+$/, '')
    : null

  async function request(path, { method = 'GET', body = null } = {}) {
    if (!base) return { ok: false, error: 'no-endpoint', status: 0, body: null }
    if (!fetchFn) return { ok: false, error: 'fetch-unavailable', status: 0, body: null }

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    if (timer?.unref) timer.unref()

    try {
      const headers = { accept: 'application/json' }
      if (body !== null) headers['content-type'] = 'application/json'
      const response = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller?.signal
      })
      const text = await response.text().catch(() => '')
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
      return { ok: response.ok, status: response.status, body: parsed, error: response.ok ? null : (parsed?.error || `http-${response.status}`) }
    } catch (err) {
      return { ok: false, status: 0, body: null, error: err?.message || String(err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    endpoint: base,

    async status() {
      if (!base) return emptyStatus()
      const result = await request('/library/status')
      if (!result.ok || !result.body) return { ...emptyStatus(), enabled: false }
      return {
        enabled: Boolean(result.body.enabled),
        folders: Number(result.body.folders || 0),
        totalItems: Number(result.body.totalItems || 0),
        durableItems: Number(result.body.durableItems || 0),
        selfOnlyItems: Number(result.body.selfOnlyItems || 0),
        pendingApprovalItems: Number(result.body.pendingApprovalItems || 0),
        failedItems: Number(result.body.failedItems || 0),
        bytes: Number(result.body.bytes || 0),
        capBytes: Number(result.body.capBytes || 0),
        importsPaused: Boolean(result.body.importsPaused),
        hiverelayDetected: Boolean(result.body.hiverelayDetected),
        hiverelayEndpoint: result.body.hiverelayEndpoint || null
      }
    },

    async scan() {
      if (!base) return { scanned: 0, imported: 0, skipped: 0, failed: 0, error: 'no-endpoint' }
      const result = await request('/library/scan', { method: 'POST', body: {} })
      if (!result.ok) return { scanned: 0, imported: 0, skipped: 0, failed: 0, error: result.error }
      return {
        scanned: Number(result.body?.scanned || 0),
        imported: Number(result.body?.imported || 0),
        skipped: Number(result.body?.skipped || 0),
        failed: Number(result.body?.failed || 0)
      }
    },

    async confirm(folderPath) {
      if (!base) return { confirmed: false, error: 'no-endpoint' }
      const result = await request('/library/confirm', { method: 'POST', body: { folderPath } })
      return { confirmed: Boolean(result.ok && result.body?.confirmed), error: result.ok ? null : result.error }
    },

    async unseed(target) {
      if (!base) return { unseeded: 0, error: 'no-endpoint' }
      const result = await request('/library/unseed', { method: 'POST', body: { target } })
      return {
        unseeded: Number(result.body?.unseeded || 0),
        state: result.body?.state || (result.ok ? 'unseeded' : 'error'),
        error: result.ok ? null : result.error
      }
    },

    async verify() {
      if (!base) return { verified: 0, failures: 0, error: 'no-endpoint' }
      const result = await request('/library/verify', { method: 'POST', body: {} })
      return {
        verified: Number(result.body?.verified || 0),
        failures: Number(result.body?.failures || 0),
        error: result.ok ? null : result.error
      }
    }
  }
}

export { emptyStatus }
