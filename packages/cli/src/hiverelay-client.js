// Single swap-point module for HiveRelay integration (see
// docs/superpowers/specs/2026-07-24-peartube-seeder-spec.md). Everything the
// relay-facing side of the library does goes through this interface so the
// transport can move from the operator HTTP surface to the p2p-hiverelay-client
// SDK (publisher-signed seed-request.v3) or the future blind CORE.MIRROR path
// without touching config, CLI, or inventory semantics.
//
// Degradation contract: every method resolves (never throws) and a missing or
// unreachable relay yields { detected: false } / status 'self-only' — the
// library keeps seeding on its own and says so in status output.

const DEFAULT_PATHS = {
  wellKnown: '/.well-known/hiverelay.json',
  seedCore: '/seed-core',
  unseed: '/unseed'
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_DETECT_TTL_MS = 15_000

// Relay seed-core response tokens. Only an explicit positive means durable;
// anything else (denied, full, quota, empty/unknown body) is NOT treated as
// success — over-claiming durability is worse than under-claiming it.
const ACCEPTED_TOKENS = new Set(['accepted', 'seeded', 'durable', 'ok', 'success'])
const PENDING_TOKENS = new Set(['pending', 'review', 'queued', 'pending-approval'])

export function createHiveRelayClient({
  endpoint,
  authToken = null,
  seedRequest = {},
  paths = {},
  fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
  logger = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  detectTtlMs = DEFAULT_DETECT_TTL_MS,
  nowFn = () => Date.now()
} = {}) {
  const base = typeof endpoint === 'string' && endpoint.trim()
    ? endpoint.trim().replace(/\/+$/, '')
    : null
  const routes = { ...DEFAULT_PATHS, ...paths }
  const logDebug = (message, meta) => logger?.debug?.(message, meta)
  const logWarn = (message, meta) => logger?.warn?.(message, meta)

  let lastDetection = null

  function toKeyList(keys) {
    if (Array.isArray(keys)) return keys.filter(Boolean)
    if (keys instanceof Set) return [...keys].filter(Boolean)
    return []
  }

  async function request(path, { method = 'GET', body = null } = {}) {
    if (!base) return { ok: false, error: 'no-endpoint' }
    if (!fetchFn) return { ok: false, error: 'fetch-unavailable' }

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    if (timer?.unref) timer.unref()

    try {
      const headers = { accept: 'application/json' }
      if (body !== null) headers['content-type'] = 'application/json'
      if (authToken) headers.authorization = `Bearer ${authToken}`
      const response = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller?.signal
      })
      const text = await response.text().catch(() => '')
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
      return { ok: response.ok, status: response.status, body: parsed }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // Closure ref so methods never depend on `this` — the module is the safe
  // swap point and must survive being destructured.
  const client = {
    endpoint: base,

    async detect({ refresh = false } = {}) {
      // Re-probe when forced, when never probed, or when the cached result is
      // stale. This lets a relay that was down at startup recover mid-session
      // instead of being pinned unavailable forever.
      const fresh = lastDetection && !refresh &&
        (nowFn() - lastDetection.checkedAt) < detectTtlMs
      if (fresh) return lastDetection
      const result = await request(routes.wellKnown)
      lastDetection = result.ok
        ? { detected: true, info: result.body || {}, checkedAt: nowFn() }
        : { detected: false, error: result.error || `http-${result.status}`, checkedAt: nowFn() }
      if (!lastDetection.detected) {
        logDebug?.('[hiverelay-client] relay not detected', { endpoint: base, error: lastDetection.error })
      }
      return lastDetection
    },

    // Ask the relay to durably hold a set of opaque core keys. The relay never
    // learns what the cores contain — that is the service-contract boundary.
    async seedCores({ keys, maxStorageBytes = 0 } = {}) {
      const detection = await client.detect()
      if (!detection.detected) return { submitted: false, reason: 'relay-unavailable', results: [] }

      const results = []
      for (const key of toKeyList(keys)) {
        const result = await request(routes.seedCore, {
          method: 'POST',
          body: {
            key,
            type: 'media',
            durability: seedRequest.durability === 0 ? 0 : 1,
            ttlSeconds: Number(seedRequest.ttlSeconds) > 0 ? Number(seedRequest.ttlSeconds) : undefined,
            maxStorageBytes: Number(maxStorageBytes) > 0 ? Number(maxStorageBytes) : undefined,
            revocable: seedRequest.revocable !== false
          }
        })
        if (!result.ok) {
          results.push({ key, status: 'error', error: result.error || `http-${result.status}` })
          logWarn?.('[hiverelay-client] seed request failed', { key: String(key).slice(0, 16), error: result.error || result.status })
          continue
        }
        const token = String(result.body?.status || result.body?.state || '').toLowerCase()
        if (PENDING_TOKENS.has(token)) {
          results.push({ key, status: 'pending-approval' })
        } else if (ACCEPTED_TOKENS.has(token)) {
          results.push({ key, status: 'accepted' })
        } else {
          // 2xx with an unrecognized/empty body: we cannot confirm durability,
          // so do NOT claim it. Treated as error → caller falls back to
          // self-only rather than recording a false 'durable'.
          results.push({ key, status: 'error', error: `unexpected-response:${token || 'empty'}` })
          logWarn?.('[hiverelay-client] seed response not recognized as durable', { key: String(key).slice(0, 16), token: token || 'empty' })
        }
      }

      const submitted = results.some((entry) => entry.status !== 'error')
      return { submitted, results }
    },

    async unseedCores({ keys } = {}) {
      const detection = await client.detect()
      if (!detection.detected) return { withdrawn: false, reason: 'relay-unavailable', results: [] }

      const results = []
      for (const key of toKeyList(keys)) {
        const result = await request(routes.unseed, { method: 'POST', body: { key } })
        results.push({ key, status: result.ok ? 'withdrawn' : 'error', error: result.ok ? null : (result.error || `http-${result.status}`) })
        if (!result.ok) {
          logWarn?.('[hiverelay-client] unseed request failed', { key: String(key).slice(0, 16), error: result.error || result.status })
        }
      }

      return { withdrawn: results.some((entry) => entry.status === 'withdrawn'), results }
    }
  }

  return client
}
