// Thin HTTP client for a PearTube relay's archive console (archive-console.js).
//
// The relay is the always-on seeder: it downloads, archives, seeds, and
// publishes the bytes itself, so `peartube add` in relay mode just POSTs a URL
// and polls the job to completion. No local backend, identity, or durability
// handshake is involved.
//
// Contract (archive-console.js):
//   POST /archive   form: url, channelName, title, description, publish,
//                         invidiousInstance   -> 303 (enqueue, fire-and-forget)
//   POST /creators  form: url, label, publish -> 303
//   GET  /jobs      -> { jobs: [{ id, status, channelName, title, error,
//                                 channelKey?, videoId?, ... }] } (newest first)
//   GET  /discover.json?q=&type=&page= -> { items: [...] }
//   GET  /health    -> { ok: true }

const DEFAULT_POLL_INTERVAL_MS = 1000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'released', 'skipped'])

export class RelayClientError extends Error {
  constructor (message, { code, status } = {}) {
    super(message)
    this.name = 'RelayClientError'
    this.exitCode = 2
    if (code) this.code = code
    if (status !== undefined) this.status = status
  }
}

export function normalizeRelayUi (value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new RelayClientError(`Invalid relay UI address: ${value}`, { code: 'ERR_PEARTUBE_RELAY_UI' })
  }
  return `${url.protocol}//${url.host}`
}

function isEnqueueOk (res) {
  return res.ok || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.status === 0
}

export function createRelayClient (baseUrl, { fetch: fetchImpl, clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } } = {}) {
  const base = normalizeRelayUi(baseUrl)
  if (!base) throw new RelayClientError('A relay UI address is required', { code: 'ERR_PEARTUBE_RELAY_UI' })
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw new RelayClientError('fetch is unavailable in this runtime')

  async function postForm (path, fields) {
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue
      body.set(key, String(value))
    }
    let res
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'manual'
      })
    } catch (cause) {
      throw new RelayClientError(`Cannot reach relay at ${base}: ${cause?.message || cause}`, { code: 'ERR_PEARTUBE_RELAY_UNREACHABLE' })
    }
    if (!isEnqueueOk(res)) {
      throw new RelayClientError(`Relay rejected ${path} (HTTP ${res.status})`, { code: 'ERR_PEARTUBE_RELAY_HTTP', status: res.status })
    }
  }

  async function getJson (path) {
    let res
    try {
      res = await doFetch(`${base}${path}`, { headers: { accept: 'application/json' } })
    } catch (cause) {
      throw new RelayClientError(`Cannot reach relay at ${base}: ${cause?.message || cause}`, { code: 'ERR_PEARTUBE_RELAY_UNREACHABLE' })
    }
    if (!res.ok) throw new RelayClientError(`Relay ${path} failed (HTTP ${res.status})`, { code: 'ERR_PEARTUBE_RELAY_HTTP', status: res.status })
    return res.json()
  }

  async function listJobs () {
    const data = await getJson('/jobs')
    return Array.isArray(data?.jobs) ? data.jobs : []
  }

  return {
    base,
    listJobs,
    async health () {
      return getJson('/health')
    },
    async discover ({ query = '', type = 'movie', page = 1 } = {}) {
      const params = new URLSearchParams({ q: query, type, page: String(page) })
      return getJson(`/discover.json?${params.toString()}`)
    },
    async addCreator ({ url, label = '', publish = true } = {}) {
      await postForm('/creators', { url, label, publish: publish ? 'true' : 'false' })
      return { ok: true }
    },
    // Snapshot job ids, enqueue, then poll for the newly-created job (makeJobId is
    // non-deterministic and /jobs omits the url, so identity-by-diff is the only
    // reliable correlation).
    async archiveAndWait ({ url, channelName, title, description, publish = true, invidiousInstance } = {}, { emit = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_INTERVAL_MS, wait = true } = {}) {
      const before = new Set((await listJobs()).map((job) => job.id))
      emit('Sending to relay…')
      await postForm('/archive', {
        url,
        channelName,
        title,
        description,
        invidiousInstance,
        publish: publish ? 'true' : 'false'
      })

      const findOurs = (jobs) => jobs.find((job) => job.id && !before.has(job.id)) || null
      let job = findOurs(await listJobs())
      if (!wait) return { job, status: job?.status || 'queued' }

      const deadline = clock.now() + timeoutMs
      let lastStatus = null
      while (clock.now() < deadline) {
        const jobs = await listJobs()
        job = findOurs(jobs) || job
        const status = job?.status || 'queued'
        if (status !== lastStatus) {
          emit(`Relay job ${status}${job?.title ? `: ${job.title}` : ''}`)
          lastStatus = status
        }
        if (job && TERMINAL_STATUSES.has(status)) return { job, status }
        await clock.sleep(pollMs)
      }
      return { job, status: job?.status || 'queued', timedOut: true }
    }
  }
}
