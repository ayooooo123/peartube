import { homedir } from 'node:os'

// Every credential an authority is read with, and the environment variable it
// is read from. This one table drives the preference key each credential lands
// under (`<authority><Option>` — the spelling `authoritySecretKey` expects from
// the metadata registry), the environment reads below, the redacted summary,
// and the usage text. MusicBrainz asks for a User-Agent, not a key, so it
// declares no credential at all.
export const AUTHORITY_CREDENTIALS = Object.freeze({
  tmdb: Object.freeze({ apiKey: 'TMDB_API_KEY' }),
  // TVDB's v4 login takes an optional subscriber PIN beside the key: keys
  // issued to a person need it, keys issued to a company do not.
  tvdb: Object.freeze({ apiKey: 'PEARTUBE_TVDB_API_KEY', pin: 'PEARTUBE_TVDB_PIN' }),
  musicbrainz: Object.freeze({})
})

export const CREDENTIAL_FIELDS = Object.freeze(
  Object.entries(AUTHORITY_CREDENTIALS).flatMap(([authority, options]) =>
    Object.entries(options).map(([option, envVar]) => Object.freeze({
      authority,
      // The name the provider factory takes this credential under.
      option,
      key: `${authority}${option[0].toUpperCase()}${option.slice(1)}`,
      envVar
    }))
  )
)

// The environment variables one authority is credentialed by, primary first.
// Empty for an authority that needs none.
export function credentialEnvVars (authority) {
  return CREDENTIAL_FIELDS.filter((field) => field.authority === authority).map((field) => field.envVar)
}

export const ADD_PREFERENCE_DEFAULTS = Object.freeze({
  storagePath: '~/.peartube/content',
  ...Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field.key, ''])),
  ytDlpPath: 'yt-dlp',
  ytDlpCookiesPath: '',
  searchLimit: 12,
  claimRetentionDays: 30
})

// Expand a leading ~ to the user's home directory. Storage/cookie paths default
// to ~-relative values; without this they create a literal "~" folder relative
// to the current working directory.
export function expandHome (value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return homedir() + value.slice(1)
  return value
}

const HEX_64 = /^[0-9a-f]{64}$/

export function resolveAddPreferences ({ flags = {}, env = {}, config = {} } = {}) {
  const content = (config && typeof config.content === 'object' && config.content) || {}

  // Every authority credential resolves the same way — flag, then environment,
  // then config — and reports where it came from without carrying the value.
  const credentials = {}
  for (const { key, envVar } of CREDENTIAL_FIELDS) {
    const picked = pickSecret([
      ['flag', flags[key]],
      ['env', env[envVar]],
      ['config', content[key]]
    ])
    credentials[key] = picked.value
    credentials[`${key}Source`] = picked.source
  }

  const cookies = pickSecret([
    ['flag', flags.ytDlpCookiesPath],
    ['env', env.PEARTUBE_YTDLP_COOKIES],
    ['config', content.ytDlpCookiesPath]
  ])

  // Trusted relay public keys authenticate bounded seed-pin and catalog
  // exchanges. Merge all configured sources, then validate and dedupe once.
  const configNetwork = (config && typeof config.network === 'object' && config.network) || {}
  const relayKeys = [
    ...asArray(flags.relay),
    ...splitList(env.PEARTUBE_RELAYS),
    ...asArray(configNetwork.trustedRelayKeys)
  ]
  return {
    storagePath: expandHome(firstString([flags.storage, content.storagePath], ADD_PREFERENCE_DEFAULTS.storagePath)),
    ...credentials,
    ytDlpPath: expandHome(firstString([flags.ytDlpPath, env.PEARTUBE_YTDLP_PATH, content.ytDlpPath], ADD_PREFERENCE_DEFAULTS.ytDlpPath)),
    ytDlpCookiesPath: expandHome(cookies.value),
    ytDlpCookiesPathSource: cookies.source,
    searchLimit: firstNumber([flags.searchLimit, content.searchLimit], ADD_PREFERENCE_DEFAULTS.searchLimit),
    claimRetentionDays: firstNumber([content.claimRetentionDays], ADD_PREFERENCE_DEFAULTS.claimRetentionDays),
    relayUi: firstString([flags.relayUi, env.PEARTUBE_RELAY_UI, content.relayUi], '') || null,
    network: normalizeNetworkTrust({ trustedRelayKeys: relayKeys })
  }
}

export function describeSecret (value) {
  return typeof value === 'string' && value.length > 0 ? 'configured' : 'not set'
}

export function redactPreferences (prefs) {
  return {
    storagePath: prefs.storagePath,
    ...Object.fromEntries(CREDENTIAL_FIELDS.flatMap(({ key }) => [
      [key, describeSecret(prefs[key])],
      [`${key}Source`, prefs[`${key}Source`] ?? null]
    ])),
    ytDlpPath: prefs.ytDlpPath,
    ytDlpCookiesPath: describeSecret(prefs.ytDlpCookiesPath),
    searchLimit: prefs.searchLimit,
    claimRetentionDays: prefs.claimRetentionDays,
    network: prefs.network
  }
}

export function normalizeNetworkTrust (network = {}) {
  const source = network && typeof network === 'object' ? network : {}
  return {
    trustedRelayKeys: normalizeHexList(source.trustedRelayKeys)
  }
}

export function updateContentConfig (text, patch = {}) {
  const source = typeof text === 'string' ? text : ''
  const lines = source.length > 0 ? source.split('\n') : []
  const block = locateContentBlock(lines)
  const existing = block ? parseContentBlock(lines, block) : {}
  const merged = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    merged[key] = value
  }

  const blockLines = ['content:', ...Object.entries(merged).map(([key, value]) => `  ${key}: ${value}`)]

  let next
  if (block) {
    next = [...lines.slice(0, block.start), ...blockLines, ...lines.slice(block.end)]
  } else {
    next = lines.length > 0 ? [...trimTrailingBlank(lines), ...blockLines] : [...blockLines]
  }

  const joined = next.join('\n') + '\n'
  return { text: joined, containsSecret: SECRET_KEYS.some((key) => nonEmpty(merged[key])) }
}

// Written into the content config with 0600 and never echoed back.
const SECRET_KEYS = [...CREDENTIAL_FIELDS.map((field) => field.key), 'ytDlpCookiesPath']

function locateContentBlock (lines) {
  const start = lines.findIndex((line) => /^content:\s*$/.test(line))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '' || /^\s/.test(line)) {
      end += 1
      continue
    }
    break
  }
  return { start, end }
}

function parseContentBlock (lines, block) {
  const out = {}
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = lines[index].match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/)
    if (match) out[match[1]] = match[2]
  }
  return out
}

function trimTrailingBlank (lines) {
  const copy = [...lines]
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop()
  return copy
}

function pickSecret (candidates) {
  for (const [source, value] of candidates) {
    if (nonEmpty(value)) return { value: String(value), source }
  }
  return { value: '', source: null }
}

function firstString (candidates, fallback) {
  for (const value of candidates) {
    if (nonEmpty(value)) return String(value)
  }
  return fallback
}

function firstNumber (candidates, fallback) {
  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function normalizeHexList (value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const hex = entry.trim().toLowerCase()
    if (!HEX_64.test(hex) || seen.has(hex)) continue
    seen.add(hex)
    out.push(hex)
  }
  return out
}

function nonEmpty (value) {
  return value !== undefined && value !== null && String(value).length > 0
}

function asArray (value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}

function splitList (value) {
  if (typeof value !== 'string') return []
  return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean)
}
