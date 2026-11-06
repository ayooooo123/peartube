import { join } from 'node:path'
import { normalizeMnemonic, validateMnemonic } from './mnemonic.js'
import { HEX64, parseUri } from './protocol.js'

// The apps' settings.json, the same camelCase shape on the Mac, Android and iOS. Each app keeps the file; the
// worklet validates edits here and turns saved settings into node options, so the rules live once.
export const APP_SETTINGS_DEFAULTS = Object.freeze({
  tracker: '',
  mnemonic: '',
  sources: [],
  relayThrough: [],
  bootstrap: [],
  lanDiscovery: true,
  privateRouting: false,
  cacheMaxGb: 10
})

const list = (v, split) => (Array.isArray(v) ? v : String(v ?? '').split(split))
  .map(s => typeof s === 'object' && s ? s : String(s).trim())
  .filter(Boolean)
const isHostPort = s => {
  const i = s.lastIndexOf(':')
  const port = Number(s.slice(i + 1))
  return i > 0 && Number.isInteger(port) && port > 0 && port < 65536
}

// A followed channel as a settings field writes it: a 64-hex key, `channel:<key>` / `tracker:<key>`, a channel
// link, or a saved `{ key, alias }`.
function channelSpec (token) {
  if (typeof token === 'object') return { ...channelSpec(token.key), alias: String(token.alias || '') }
  const raw = String(token || '').trim()
  const short = raw.toLowerCase().match(/^(?:peartube:)?(?:channel|tracker):([0-9a-f]{64})$/)
  if (short) return { key: short[1], kind: 'channel', alias: '' }
  let parsed
  try { parsed = parseUri(raw) } catch { throw new Error(`Invalid key or peartube:// URI: ${raw}`) }
  if (parsed.action !== 'source') throw new Error(`Expected peartube://channel/..., got ${raw}`)
  return { key: parsed.key, kind: 'channel', alias: parsed.alias }
}

// Raw fields (from a settings form: text or lists) or a saved settings.json, as complete settings. Throws the first
// field error, worded for the user. A form must name at least one channel; a first-run settings.json names none.
export function normalizeAppSettings (raw = {}, { requireChannel = false } = {}) {
  const tracker = raw.tracker ? channelSpec(raw.tracker).key : ''
  const mnemonic = normalizeMnemonic(raw.mnemonic)
  if (mnemonic && !validateMnemonic(mnemonic)) throw new Error('Recovery phrase must be 12 or 24 English recovery words.')
  const sources = []
  for (const token of list(raw.sources, /[\r\n,]+/)) {
    const spec = channelSpec(token)
    if (spec.key !== tracker && !sources.some(s => s.key === spec.key)) sources.push(spec)
  }
  const relayThrough = list(raw.relayThrough, /[\s,]+/).map(k => String(k).toLowerCase())
  const badRelay = relayThrough.find(k => !HEX64.test(k))
  if (badRelay) throw new Error(`Relay key ${badRelay} is not 64 hex characters.`)
  const bootstrap = list(raw.bootstrap, /[\s,]+/).map(String)
  const badNode = bootstrap.find(n => !isHostPort(n))
  if (badNode) throw new Error(`Bootstrap node ${badNode} is not host:port.`)
  if (requireChannel && !tracker && !mnemonic && !sources.length) {
    throw new Error('Add a channel key, a 12-word recovery phrase, or a peartube://channel/ link.')
  }
  const cacheMaxGb = raw.cacheMaxGb === undefined || raw.cacheMaxGb === null || raw.cacheMaxGb === ''
    ? APP_SETTINGS_DEFAULTS.cacheMaxGb
    : Math.max(0, Math.floor(Number(raw.cacheMaxGb) || 0))
  return {
    tracker,
    mnemonic,
    sources,
    relayThrough,
    bootstrap,
    lanDiscovery: raw.lanDiscovery === undefined ? APP_SETTINGS_DEFAULTS.lanDiscovery : Boolean(raw.lanDiscovery),
    privateRouting: Boolean(raw.privateRouting),
    cacheMaxGb
  }
}

// The node folder under `trackers/` decides which identity.json a node opens: a fixed channel, a device linked by
// recovery phrase, or the platform's default folder (its name differs per app for historical reasons).
export function nodeOptions (settings, { trackersDir, defaultFolder }) {
  const folder = settings.tracker || (settings.mnemonic ? 'linked' : defaultFolder)
  return {
    storage: join(trackersDir, folder),
    tracker: settings.tracker || null,
    mnemonic: settings.mnemonic || null,
    join: Boolean(settings.mnemonic && !settings.tracker),
    sources: settings.sources,
    relayThrough: settings.relayThrough.length ? settings.relayThrough : null,
    bootstrap: settings.bootstrap.length ? settings.bootstrap : null,
    lan: settings.lanDiscovery,
    privateRouting: settings.privateRouting,
    cacheMaxGb: settings.cacheMaxGb
  }
}
