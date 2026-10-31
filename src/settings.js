import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// Relay settings: settings.json (set from the UI) wins, then an env var, then the default. settings.json is a private
// file beside jobs.json (0600), never in the Corestore. Secrets (HiveRelay API keys, tokens inside URLs) are
// write-only: views carry a redacted label and a `#n` ref that keeps the stored value on update. `null` clears a
// saved value, so the env var or default applies again. `live` settings apply in place; the rest reopen the node.
const HEX64 = /^[0-9a-f]{64}$/
const HOST = /^[a-z0-9.:[\]-]{1,253}$/i
const csv = s => String(s).split(',').map(x => x.trim()).filter(Boolean)
const flag = s => s === '1' || s === 'true'

const SPEC = {
  streamHost: { env: 'PEARTUBE_STREAM_HOST', type: 'host', def: '127.0.0.1' },
  streamPort: { env: 'PEARTUBE_STREAM_PORT', type: 'port', def: 8175 },
  lan: { env: 'PEARTUBE_LAN_HOST', type: 'bool', def: false, live: true, fromEnv: s => Boolean(s) },
  lanHost: { env: 'PEARTUBE_LAN_HOST', type: 'host', def: '', live: true },
  dhtPort: { env: 'PEARTUBE_DHT_PORT', type: 'port', def: 0 },
  bootstrap: { env: 'PEARTUBE_BOOTSTRAP', type: 'hosts', def: [] },
  relayThrough: { env: 'PEARTUBE_RELAY_THROUGH', type: 'keys', def: [] },
  privateRouting: { env: 'PEARTUBE_PRIVATE_ROUTING', type: 'bool', def: false, fromEnv: s => Boolean(s) },
  privateGuard: { env: 'PEARTUBE_PRIVATE_GUARD', type: 'bool', def: false, live: true, fromEnv: flag },
  privateGuardPort: { env: 'PEARTUBE_PRIVATE_GUARD_PORT', type: 'port', def: 0, live: true },
  tracker: { env: 'PEARTUBE_TRACKER', type: 'key', def: '' },
  allowedPeers: { env: 'PEARTUBE_ALLOWED_PEERS', type: 'keys', def: [], live: true },
  publishChannel: { env: 'PEARTUBE_PUBLISH_CHANNEL', type: 'bool', def: true, fromEnv: s => s !== '0' },
  directory: { env: 'PEARTUBE_DIRECTORY', type: 'bool', def: false, live: true, fromEnv: s => Boolean(s) },
  acquireConcurrency: { env: 'PEARTUBE_ACQUIRE_CONCURRENCY', type: 'number', def: 4, min: 1, max: 32, live: true },
  watchDir: { env: 'PEARTUBE_WATCH_DIR', type: 'path', def: '', live: true },
  feeds: { env: 'PEARTUBE_MIRROR_FEEDS', type: 'urls', def: [], live: true },
  replicate: { env: 'PEARTUBE_REPLICATE', type: 'bool', def: false, live: true, fromEnv: s => Boolean(s) && s !== '0' && s !== 'false' },
  replicateSources: { env: 'PEARTUBE_REPLICATE', type: 'keys', def: [], live: true, fromEnv: s => flag(s) ? [] : csv(s.toLowerCase()) },
  replicateFreeGb: { env: 'PEARTUBE_REPLICATE_FREE_GB', type: 'number', def: 20, min: 0, max: 1e6, live: true },
  replicateMbps: { env: 'PEARTUBE_REPLICATE_MBPS', type: 'number', def: 80, min: 0, max: 1e5, live: true },
  hiverelays: { env: 'PEARTUBE_HIVERELAYS', type: 'urls', def: [] },
  hiverelayApiKey: { env: 'PEARTUBE_HIVERELAY_API_KEY', type: 'secret', def: '' },
  hiverelayDiscover: { env: 'PEARTUBE_HIVERELAY_DISCOVER', type: 'bool', def: false, fromEnv: s => Boolean(s) },
  hiverelayReplicas: { env: 'PEARTUBE_HIVERELAY_REPLICAS', type: 'number', def: 3, min: 1, max: 32 },
  hiverelayUploadMbps: { env: 'PEARTUBE_HIVERELAY_UPLOAD_MBPS', type: 'number', def: 50, min: 0, max: 1e5 },
  rechunk: { env: 'PEARTUBE_RECHUNK', type: 'bool', def: false, live: true, fromEnv: flag },
  cinemetaUrl: { env: 'PEARTUBE_CINEMETA_URL', type: 'url', def: 'https://v3-cinemeta.strem.io', live: true, empty: true }
}

function parseEnv (spec, raw) {
  if (spec.fromEnv) return spec.fromEnv(raw)
  if (spec.type === 'port' || spec.type === 'number') return Number(raw)
  if (spec.type === 'keys' || spec.type === 'hosts' || spec.type === 'urls') return csv(raw)
  return raw
}

function bad (key, why) {
  return Object.assign(new Error(`${key}: ${why}`), { status: 400 })
}

function validate (key, spec, value) {
  switch (spec.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw bad(key, 'must be true or false')
      return value
    case 'port':
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw bad(key, 'must be a port from 0 to 65535')
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) throw bad(key, `must be a number from ${spec.min} to ${spec.max}`)
      return value
    case 'host':
      if (typeof value !== 'string' || (value && !HOST.test(value))) throw bad(key, 'must be an IP address or host name')
      return value.trim()
    case 'key':
      if (typeof value !== 'string' || (value && !HEX64.test(value.toLowerCase()))) throw bad(key, 'must be a 64-character hex key')
      return value.toLowerCase()
    case 'path':
      if (typeof value !== 'string' || (value && !value.startsWith('/'))) throw bad(key, 'must be an absolute folder path')
      return value.trim()
    case 'secret':
      if (typeof value !== 'string' || value.length > 512) throw bad(key, 'must be text')
      return value
    case 'url':
      if (typeof value !== 'string' || (value && !/^https?:\/\/[^\s]+$/i.test(value))) throw bad(key, 'must be an http(s) URL')
      if (!value && !spec.empty) throw bad(key, 'is required')
      return value.replace(/\/+$/, '')
  }
  if (!Array.isArray(value) || value.length > 64) throw bad(key, 'must be a list')
  return value.map(item => {
    if (typeof item !== 'string') throw bad(key, 'items must be text')
    const v = item.trim()
    if (spec.type === 'keys' && !HEX64.test(v.toLowerCase())) throw bad(key, `${v.slice(0, 16)}… is not a 64-character hex key`)
    if (spec.type === 'hosts' && !/^[a-z0-9.:[\]-]+:\d{1,5}$/i.test(v)) throw bad(key, `${v} must be host:port`)
    if (spec.type === 'urls' && !/^https?:\/\/[^\s]+$/i.test(v)) throw bad(key, `${v.slice(0, 40)} is not an http(s) URL`)
    return spec.type === 'keys' ? v.toLowerCase() : v
  })
}

// What a view may show of a URL: scheme, host and path. Query strings, credentials and HiveRelay `=TOKEN` suffixes stay private.
function urlLabel (raw) {
  const plain = raw.replace(/=[^/=]*$/, '')
  try {
    const u = new URL(plain)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return 'link'
  }
}

export function createSettings (storage, env = {}) {
  const file = join(storage, 'settings.json')
  let saved = {}
  try { saved = JSON.parse(readFileSync(file, 'utf8')) || {} } catch {}

  const envSet = key => {
    const raw = env[SPEC[key].env]
    return raw !== undefined && raw !== ''
  }
  function read (key, from) {
    const spec = SPEC[key]
    if (Object.hasOwn(from, key)) return from[key]
    if (envSet(key)) return parseEnv(spec, env[spec.env])
    return spec.def
  }
  const get = key => read(key, saved)
  // What the running relay uses: the snapshot taken before its node opened. A failed reopen leaves keys in `restartNeeded`.
  const snapshot = () => Object.fromEntries(Object.keys(SPEC).map(k => [k, JSON.stringify(get(k))]))
  let applied = snapshot()
  const markApplied = snap => { applied = snap }

  function view () {
    const settings = {}
    for (const [key, spec] of Object.entries(SPEC)) {
      let value = get(key)
      const out = { type: spec.type, live: Boolean(spec.live), source: Object.hasOwn(saved, key) ? 'file' : (envSet(key) ? 'env' : 'default'), env: spec.env, envSet: envSet(key) }
      if (spec.type === 'secret') {
        out.set = Boolean(value)
        value = ''
      } else if (spec.type === 'urls') {
        value = value.map((u, i) => ({ ref: '#' + i, label: urlLabel(u) }))
      }
      out.value = value
      settings[key] = out
    }
    const restartNeeded = Object.keys(SPEC).filter(k => !SPEC[k].live && JSON.stringify(get(k)) !== applied[k])
    return { settings, restartNeeded }
  }

  function update (patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('settings', 'body must be an object')
    const next = { ...saved }
    const changed = []
    for (const [key, raw] of Object.entries(patch)) {
      const spec = SPEC[key]
      if (!spec) throw bad(key, 'unknown setting')
      const before = JSON.stringify(read(key, next))
      if (raw === null) {
        delete next[key]
      } else {
        let value = raw
        // `#n` keeps a stored URL whose view was redacted.
        if (spec.type === 'urls' && Array.isArray(raw)) {
          const current = get(key)
          value = raw.map(item => typeof item === 'string' && /^#\d+$/.test(item) ? current[Number(item.slice(1))] : item).filter(v => v !== undefined)
        }
        next[key] = validate(key, spec, value)
      }
      if (JSON.stringify(read(key, next)) !== before) changed.push(key)
    }
    // The guard runs its own HyperDHT node beside the relay's: a fixed port both ask for would leave one deaf.
    const guardPort = read('privateGuardPort', next)
    if (read('privateGuard', next) && guardPort && guardPort === read('dhtPort', next) && (changed.includes('dhtPort') || changed.includes('privateGuardPort') || changed.includes('privateGuard'))) {
      throw bad(changed.includes('dhtPort') ? 'dhtPort' : 'privateGuardPort', 'the peer port and the guard port must differ')
    }
    if (JSON.stringify(next) !== JSON.stringify(saved)) {
      writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 })
      renameSync(file + '.tmp', file)
      saved = next
    }
    return { changed, ...view() }
  }

  // A value the running relay already uses (the tracker it founded): saved so the next start keeps it, no restart flagged.
  function remember (key, value) {
    if (Object.hasOwn(saved, key)) return
    update({ [key]: value })
    applied[key] = JSON.stringify(get(key))
  }

  const isLive = key => Boolean(SPEC[key]?.live)
  return { get, view, update, remember, snapshot, markApplied, isLive, file }
}
