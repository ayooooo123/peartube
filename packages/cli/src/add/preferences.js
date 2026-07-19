export const ADD_PREFERENCE_DEFAULTS = Object.freeze({
  storagePath: '~/.peartube/content',
  tmdbApiKey: '',
  ytDlpPath: 'yt-dlp',
  ytDlpCookiesPath: '',
  searchLimit: 12,
  claimRetentionDays: 30
})

const HEX_64 = /^[0-9a-f]{64}$/

export function resolveAddPreferences ({ flags = {}, env = {}, config = {} } = {}) {
  const content = (config && typeof config.content === 'object' && config.content) || {}

  const tmdb = pickSecret([
    ['flag', flags.tmdbApiKey],
    ['env', env.TMDB_API_KEY],
    ['config', content.tmdbApiKey]
  ])

  const cookies = pickSecret([
    ['flag', flags.ytDlpCookiesPath],
    ['env', env.PEARTUBE_YTDLP_COOKIES],
    ['config', content.ytDlpCookiesPath]
  ])

  return {
    storagePath: firstString([flags.storage, content.storagePath], ADD_PREFERENCE_DEFAULTS.storagePath),
    tmdbApiKey: tmdb.value,
    tmdbApiKeySource: tmdb.source,
    ytDlpPath: firstString([flags.ytDlpPath, env.PEARTUBE_YTDLP_PATH, content.ytDlpPath], ADD_PREFERENCE_DEFAULTS.ytDlpPath),
    ytDlpCookiesPath: cookies.value,
    ytDlpCookiesPathSource: cookies.source,
    searchLimit: firstNumber([flags.searchLimit, content.searchLimit], ADD_PREFERENCE_DEFAULTS.searchLimit),
    claimRetentionDays: firstNumber([content.claimRetentionDays], ADD_PREFERENCE_DEFAULTS.claimRetentionDays),
    network: normalizeNetworkTrust(config.network)
  }
}

export function describeSecret (value) {
  return typeof value === 'string' && value.length > 0 ? 'configured' : 'not set'
}

export function redactPreferences (prefs) {
  return {
    storagePath: prefs.storagePath,
    tmdbApiKey: describeSecret(prefs.tmdbApiKey),
    tmdbApiKeySource: prefs.tmdbApiKeySource,
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
    trustedRelayKeys: normalizeHexList(source.trustedRelayKeys),
    blindPeerMirrors: normalizeHexList(source.blindPeerMirrors)
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

const SECRET_KEYS = ['tmdbApiKey', 'ytDlpCookiesPath']

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
