import { readFileSync } from '#fs'
import { join } from '#path'
import process from '#process'
import {
  DEFAULT_ARCHIVE_CONFIG,
  DEFAULT_ARCHIVE_FFMPEG_PATH,
  DEFAULT_ARCHIVE_FORMAT,
  DEFAULT_ARCHIVE_JS_RUNTIME,
  DEFAULT_ARCHIVE_MAX_ITEMS,
  DEFAULT_ARCHIVE_MAX_RETRIES,
  DEFAULT_ARCHIVE_POLL_SECONDS,
  DEFAULT_ARCHIVE_S3_CONFIG,
  DEFAULT_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES,
  DEFAULT_ARCHIVE_YT_DLP_EXTRA_ARGS,
  DEFAULT_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS,
  DEFAULT_ARCHIVE_YT_DLP_PATH,
  DEFAULT_LOCAL_MIRROR_POLL_SECONDS,
  DEFAULT_CLASSIFICATION_CONFIG,
  DEFAULT_TMDB_BASE_URL,
  DEFAULT_TMDB_LANGUAGE,
  DEFAULT_SEED_PIN_CONFIG,
  DEFAULT_RELAY_CONFIG,
  MAX_SEED_PIN_CONCURRENT,
  MAX_SEED_PIN_TRUSTED_CLIENTS,
  RELAY_CATALOG_FILENAME,
  RELAY_CLASSIFICATION_FILENAME,
  RELAY_CREATORS_FILENAME,
  RELAY_TRUSTED_CLIENTS_FILENAME,
  RELAY_MODE_PRIVATE,
  RELAY_MODE_PUBLIC,
  RELAY_POLICY_ALLOWLIST,
  RELAY_POLICY_DISCOVERY,
  RELAY_STATUS_FILENAME,
  VALID_MODES,
  VALID_POLICIES
} from './constants.js'
import {
  companionConfigFromCli,
  companionConfigFromEnv,
  resolveCompanionConfig
} from './companion/config.js'
import { buildSourceId, classifySourceUrl } from './archive/source-id.js'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deepMerge(base, patch) {
  if (!isPlainObject(base)) return clone(patch)
  const result = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      result[key] = [...value]
      continue
    }
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMerge(base[key], value)
      continue
    }
    result[key] = value
  }
  return result
}

function splitCommaList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitCommaList(entry))
  }

  if (typeof value !== 'string') return []

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function splitShellArgs(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitShellArgs(entry))
  }
  if (typeof value !== 'string') return []

  const args = []
  let current = ''
  let quote = null
  let escaped = false

  for (const char of value.trim()) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaped) current += '\\'
  if (current) args.push(current)
  return args
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
  return undefined
}

function parseScalar(raw) {
  const value = raw.trim()

  if (value === '') return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (value === '[]') return []
  if (value === '{}') return {}
  if (/^-?\d+$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  return value
}

function normalizeYamlLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const hashIndex = line.indexOf('#')
      const withoutComment = hashIndex >= 0 ? line.slice(0, hashIndex) : line
      return withoutComment.replace(/\s+$/, '')
    })
    .filter((line) => line.trim().length > 0)
}

function parseYamlBlock(lines, startIndex = 0, indent = 0) {
  let collection = null
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index]
    const currentIndent = line.match(/^ */)[0].length

    if (currentIndent < indent) break
    if (currentIndent > indent) {
      throw new Error(`Invalid indentation near "${line.trim()}"`)
    }

    const trimmed = line.trim()

    if (trimmed.startsWith('- ')) {
      if (collection === null) collection = []
      if (!Array.isArray(collection)) throw new Error('Mixed YAML array/object indentation is not supported')

      const remainder = trimmed.slice(2).trim()
      if (remainder === '') {
        const [value, nextIndex] = parseYamlBlock(lines, index + 1, indent + 2)
        collection.push(value)
        index = nextIndex
        continue
      }

      collection.push(parseScalar(remainder))
      index += 1
      continue
    }

    if (collection === null) collection = {}
    if (Array.isArray(collection)) throw new Error('Mixed YAML array/object indentation is not supported')

    const separatorIndex = trimmed.indexOf(':')
    if (separatorIndex < 0) {
      throw new Error(`Invalid YAML line "${trimmed}"`)
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const remainder = trimmed.slice(separatorIndex + 1).trim()

    if (remainder === '') {
      const nextLine = lines[index + 1]
      if (nextLine) {
        const nextIndent = nextLine.match(/^ */)[0].length
        if (nextIndent > indent) {
          const [value, nextIndex] = parseYamlBlock(lines, index + 1, indent + 2)
          collection[key] = value
          index = nextIndex
          continue
        }
      }

      collection[key] = {}
      index += 1
      continue
    }

    collection[key] = parseScalar(remainder)
    index += 1
  }

  return [collection ?? {}, index]
}

function parseSimpleConfig(text) {
  const trimmed = text.trim()
  if (!trimmed) return {}

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }

  const lines = normalizeYamlLines(text)
  const [parsed] = parseYamlBlock(lines, 0, 0)
  return parsed
}

function readConfigFile(configPath) {
  if (!configPath) return {}
  const content = readFileSync(configPath, 'utf8')
  return parseSimpleConfig(content)
}

function storageFromEnv(env) {
  if (!env.PEARTUBE_STORAGE_PATH && !env.PEARTUBE_STORAGE_MAX_BYTES && !env.PEARTUBE_STORAGE_MIN_FREE_BYTES) {
    return null
  }
  const storage = {}
  if (env.PEARTUBE_STORAGE_PATH) storage.path = env.PEARTUBE_STORAGE_PATH
  if (env.PEARTUBE_STORAGE_MAX_BYTES) storage.maxBytes = Number(env.PEARTUBE_STORAGE_MAX_BYTES)
  if (env.PEARTUBE_STORAGE_MIN_FREE_BYTES) storage.minFreeBytes = Number(env.PEARTUBE_STORAGE_MIN_FREE_BYTES)
  return storage
}

function admissionFromEnv(env) {
  if (!env.PEARTUBE_ADMISSION_CHANNELS && !env.PEARTUBE_ADMISSION_OWNERS) return null
  const admission = {}
  if (env.PEARTUBE_ADMISSION_CHANNELS) admission.channels = splitCommaList(env.PEARTUBE_ADMISSION_CHANNELS)
  if (env.PEARTUBE_ADMISSION_OWNERS) admission.owners = splitCommaList(env.PEARTUBE_ADMISSION_OWNERS)
  return admission
}

function discoveryFromEnv(env) {
  if (!env.PEARTUBE_DISCOVERY_ENABLED && !env.PEARTUBE_DISCOVERY_SEED_DISCOVERED &&
      !env.PEARTUBE_DISCOVERY_MAX_CHANNELS && !env.PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER) {
    return null
  }
  const discovery = {}
  if (env.PEARTUBE_DISCOVERY_ENABLED) discovery.enabled = parseBoolean(env.PEARTUBE_DISCOVERY_ENABLED)
  if (env.PEARTUBE_DISCOVERY_SEED_DISCOVERED) discovery.seedDiscovered = parseBoolean(env.PEARTUBE_DISCOVERY_SEED_DISCOVERED)
  if (env.PEARTUBE_DISCOVERY_MAX_CHANNELS) discovery.maxChannels = Number(env.PEARTUBE_DISCOVERY_MAX_CHANNELS)
  if (env.PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER) {
    discovery.maxChannelsPerOwner = Number(env.PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER)
  }
  return discovery
}

function networkFromEnv(env) {
  if (!env.PEARTUBE_NETWORK_ANNOUNCE && !env.PEARTUBE_NETWORK_BOOTSTRAP) return null
  const network = {}
  if (env.PEARTUBE_NETWORK_ANNOUNCE) network.announce = parseBoolean(env.PEARTUBE_NETWORK_ANNOUNCE)
  if (env.PEARTUBE_NETWORK_BOOTSTRAP) network.bootstrap = env.PEARTUBE_NETWORK_BOOTSTRAP
  return network
}

function retentionFromEnv(env) {
  if (!env.PEARTUBE_RETENTION_PROTECT_PRIVATE && !env.PEARTUBE_RETENTION_PROTECT_ALLOWLIST) return null
  const retention = {}
  if (env.PEARTUBE_RETENTION_PROTECT_PRIVATE) {
    retention.protectPrivate = parseBoolean(env.PEARTUBE_RETENTION_PROTECT_PRIVATE)
  }
  if (env.PEARTUBE_RETENTION_PROTECT_ALLOWLIST) {
    retention.protectAllowlist = parseBoolean(env.PEARTUBE_RETENTION_PROTECT_ALLOWLIST)
  }
  return retention
}

function classificationFromEnv(env) {
  if (!env.PEARTUBE_TMDB_API_KEY && !env.PEARTUBE_TMDB_ENABLED &&
      !env.PEARTUBE_TMDB_LANGUAGE && !env.PEARTUBE_TMDB_BASE_URL) {
    return null
  }
  const tmdb = {}
  if (env.PEARTUBE_TMDB_API_KEY) tmdb.apiKey = env.PEARTUBE_TMDB_API_KEY
  if (env.PEARTUBE_TMDB_ENABLED) {
    const parsed = parseBoolean(env.PEARTUBE_TMDB_ENABLED)
    if (parsed !== undefined) tmdb.enabled = parsed
  }
  if (env.PEARTUBE_TMDB_LANGUAGE) tmdb.language = env.PEARTUBE_TMDB_LANGUAGE
  if (env.PEARTUBE_TMDB_BASE_URL) tmdb.baseUrl = env.PEARTUBE_TMDB_BASE_URL
  return { tmdb }
}

function archiveS3FromEnv(env) {
  if (!env.PEARTUBE_ARCHIVE_S3_ENDPOINT && !env.PEARTUBE_ARCHIVE_S3_BUCKET &&
      !env.PEARTUBE_ARCHIVE_S3_REGION && !env.PEARTUBE_ARCHIVE_S3_ACCESS_KEY_ID &&
      !env.PEARTUBE_ARCHIVE_S3_SECRET_ACCESS_KEY && !env.PEARTUBE_ARCHIVE_S3_PREFIX &&
      !env.PEARTUBE_ARCHIVE_S3_FORCE_PATH_STYLE && !env.PEARTUBE_ARCHIVE_S3_OFFLOAD &&
      !env.PEARTUBE_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES) {
    return null
  }
  const s3 = {}
  if (env.PEARTUBE_ARCHIVE_S3_ENDPOINT) s3.endpoint = env.PEARTUBE_ARCHIVE_S3_ENDPOINT
  if (env.PEARTUBE_ARCHIVE_S3_BUCKET) s3.bucket = env.PEARTUBE_ARCHIVE_S3_BUCKET
  if (env.PEARTUBE_ARCHIVE_S3_REGION) s3.region = env.PEARTUBE_ARCHIVE_S3_REGION
  if (env.PEARTUBE_ARCHIVE_S3_ACCESS_KEY_ID) s3.accessKeyId = env.PEARTUBE_ARCHIVE_S3_ACCESS_KEY_ID
  if (env.PEARTUBE_ARCHIVE_S3_SECRET_ACCESS_KEY) s3.secretAccessKey = env.PEARTUBE_ARCHIVE_S3_SECRET_ACCESS_KEY
  if (env.PEARTUBE_ARCHIVE_S3_PREFIX) s3.prefix = env.PEARTUBE_ARCHIVE_S3_PREFIX
  if (env.PEARTUBE_ARCHIVE_S3_FORCE_PATH_STYLE) s3.forcePathStyle = parseBoolean(env.PEARTUBE_ARCHIVE_S3_FORCE_PATH_STYLE)
  if (env.PEARTUBE_ARCHIVE_S3_OFFLOAD) s3.offload = parseBoolean(env.PEARTUBE_ARCHIVE_S3_OFFLOAD)
  if (env.PEARTUBE_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES) s3.offloadWindowBytes = Number(env.PEARTUBE_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES)
  return s3
}

function archiveLocalMirrorFromEnv(env) {
  if (!env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_ENABLED && !env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_PATH &&
      !env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_POLL && !env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_CHANNEL_NAME &&
      !env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_DESCRIPTION && !env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_RECURSIVE &&
      !env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_MAX_FILES) {
    return null
  }
  const localMirror = {}
  if (env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_ENABLED) localMirror.enabled = parseBoolean(env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_ENABLED)
  if (env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_PATH) localMirror.path = env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_PATH
  if (env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_POLL) localMirror.poll = Number(env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_POLL)
  if (env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_CHANNEL_NAME) localMirror.channelName = env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_CHANNEL_NAME
  if (env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_DESCRIPTION) localMirror.description = env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_DESCRIPTION
  if (env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_RECURSIVE) localMirror.recursive = parseBoolean(env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_RECURSIVE)
  if (env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_MAX_FILES) localMirror.maxFiles = Number(env.PEARTUBE_ARCHIVE_LOCAL_MIRROR_MAX_FILES)
  return localMirror
}

function archiveTorboxFromEnv(env) {
  if (!env.PEARTUBE_TORBOX_API_KEY && !env.PEARTUBE_TORBOX_CHUNK_BYTES) return null
  const torbox = {}
  if (env.PEARTUBE_TORBOX_API_KEY) torbox.apiKey = env.PEARTUBE_TORBOX_API_KEY
  if (env.PEARTUBE_TORBOX_CHUNK_BYTES) torbox.chunkBytes = Number(env.PEARTUBE_TORBOX_CHUNK_BYTES)
  return torbox
}

function archiveFromEnv(env) {
  const archive = {}
  if (env.PEARTUBE_ARCHIVE_UI_ENABLED) archive.uiEnabled = parseBoolean(env.PEARTUBE_ARCHIVE_UI_ENABLED)
  if (env.PEARTUBE_ARCHIVE_UI_HOST) archive.uiHost = env.PEARTUBE_ARCHIVE_UI_HOST
  if (env.PEARTUBE_ARCHIVE_UI_PORT) archive.uiPort = Number(env.PEARTUBE_ARCHIVE_UI_PORT)
  if (env.PEARTUBE_ARCHIVE_TMP_PATH) archive.tmpPath = env.PEARTUBE_ARCHIVE_TMP_PATH
  if (env.PEARTUBE_ARCHIVE_ENABLED) {
    const parsed = parseBoolean(env.PEARTUBE_ARCHIVE_ENABLED)
    if (parsed !== undefined) archive.enabled = parsed
  }
  if (env.PEARTUBE_ARCHIVE_POLL) archive.poll = Number(env.PEARTUBE_ARCHIVE_POLL)
  if (env.PEARTUBE_ARCHIVE_FORMAT) archive.format = env.PEARTUBE_ARCHIVE_FORMAT
  if (env.PEARTUBE_ARCHIVE_YT_DLP_PATH) archive.ytDlpPath = env.PEARTUBE_ARCHIVE_YT_DLP_PATH
  if (env.PEARTUBE_ARCHIVE_FFMPEG_PATH) archive.ffmpegPath = env.PEARTUBE_ARCHIVE_FFMPEG_PATH
  if (env.PEARTUBE_ARCHIVE_COOKIES_PATH) archive.cookiesPath = env.PEARTUBE_ARCHIVE_COOKIES_PATH
  if (env.PEARTUBE_ARCHIVE_JS_RUNTIME) archive.jsRuntime = env.PEARTUBE_ARCHIVE_JS_RUNTIME
  if (env.PEARTUBE_ARCHIVE_YT_DLP_EXTRA_ARGS) archive.ytDlpExtraArgs = splitShellArgs(env.PEARTUBE_ARCHIVE_YT_DLP_EXTRA_ARGS)
  if (env.PEARTUBE_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS) {
    archive.ytDlpRetryExtraArgs = String(env.PEARTUBE_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS)
      .split(/\s*\|\|\s*/)
      .map(splitShellArgs)
      .filter((args) => args.length)
  }
  if (env.PEARTUBE_ARCHIVE_SOURCES) {
    archive.sources = splitCommaList(env.PEARTUBE_ARCHIVE_SOURCES).map((url) => ({ url }))
  }
  const s3 = archiveS3FromEnv(env)
  if (s3) archive.s3 = s3
  const localMirror = archiveLocalMirrorFromEnv(env)
  if (localMirror) archive.localMirror = localMirror
  const torbox = archiveTorboxFromEnv(env)
  if (torbox) archive.torbox = torbox

  return Object.keys(archive).length ? archive : null
}

function configFromEnv(env = {}) {
  const config = {}

  if (env.PEARTUBE_MODE) config.mode = env.PEARTUBE_MODE
  if (env.PEARTUBE_POLICY) config.policy = env.PEARTUBE_POLICY
  const storage = storageFromEnv(env)
  if (storage) config.storage = storage
  const admission = admissionFromEnv(env)
  if (admission) config.admission = admission
  const discovery = discoveryFromEnv(env)
  if (discovery) config.discovery = discovery
  const network = networkFromEnv(env)
  if (network) config.network = network
  const retention = retentionFromEnv(env)
  if (retention) config.retention = retention
  if (env.PEARTUBE_LOG_LEVEL) {
    config.logging = { level: env.PEARTUBE_LOG_LEVEL }
  }
  if (env.PEARTUBE_RESEED_ENABLED) {
    const parsed = parseBoolean(env.PEARTUBE_RESEED_ENABLED)
    if (parsed !== undefined) config.reseed = { enabled: parsed }
  }
  const classification = classificationFromEnv(env)
  if (classification) config.classification = classification
  const archive = archiveFromEnv(env)
  if (archive) config.archive = archive

  Object.assign(config, companionConfigFromEnv(env))

  return config
}

function storageFromCli(cli) {
  if (!cli.storage && cli.maxBytes === undefined && cli.maxStorage === undefined && cli.minFreeBytes === undefined) {
    return null
  }
  const storage = {}
  if (cli.storage) storage.path = cli.storage
  if (cli.maxBytes !== undefined) storage.maxBytes = Number(cli.maxBytes)
  if (cli.maxStorage !== undefined) storage.maxBytes = Number(cli.maxStorage) * 1024 * 1024
  if (cli.minFreeBytes !== undefined) storage.minFreeBytes = Number(cli.minFreeBytes)
  return storage
}

function archiveFromCli(cli) {
  let archive = null
  if (cli.archive) archive = { ...cli.archive }

  if (cli.host || cli.port) {
    archive = archive || {}
    if (cli.host) archive.uiHost = cli.host
    if (cli.port) archive.uiPort = Number(cli.port)
  }

  if (cli.localMirrorPath || cli.localMirrorPoll || cli.localMirrorChannelName) {
    archive = archive || {}
    archive.localMirror = archive.localMirror || {}
    if (cli.localMirrorPath) {
      archive.localMirror.enabled = true
      archive.localMirror.path = cli.localMirrorPath
    }
    if (cli.localMirrorPoll) archive.localMirror.poll = Number(cli.localMirrorPoll)
    if (cli.localMirrorChannelName) archive.localMirror.channelName = cli.localMirrorChannelName
  }
  return archive
}

function configFromCli(cli = {}) {
  const config = {}

  const archive = archiveFromCli(cli)
  if (archive) config.archive = archive
  if (cli.mode) config.mode = cli.mode
  if (cli.policy) config.policy = cli.policy

  const storage = storageFromCli(cli)
  if (storage) config.storage = storage

  if (cli.channel || cli.owner) {
    config.admission = {}
    if (cli.channel) config.admission.channels = splitCommaList(cli.channel)
    if (cli.owner) config.admission.owners = splitCommaList(cli.owner)
  }

  if (cli.debug) {
    config.logging = { level: 'debug' }
  } else if (cli.logLevel) {
    config.logging = { level: cli.logLevel }
  }

  if (cli.noReseed) {
    config.reseed = { enabled: false }
  }

  Object.assign(config, companionConfigFromCli(cli))

  return config
}

function normalizeSource(rawSource, defaults) {
  if (!isPlainObject(rawSource)) {
    if (typeof rawSource === 'string') {
      rawSource = { url: rawSource }
    } else {
      throw new Error('archive.sources entries must be objects with a url')
    }
  }

  const url = typeof rawSource.url === 'string' ? rawSource.url.trim() : ''
  if (!url) throw new Error('archive.sources entries must include a url')

  const classified = classifySourceUrl(url)
  if (!classified.type) {
    throw new Error(`Unsupported archive source url "${url}"`)
  }

  const sourceId = buildSourceId(classified.type, classified.identifier)

  return {
    url: classified.normalizedUrl,
    type: classified.type,
    identifier: classified.identifier,
    kind: classified.kind,
    sourceId,
    label: typeof rawSource.label === 'string' && rawSource.label.trim()
      ? rawSource.label.trim()
      : null,
    format: typeof rawSource.format === 'string' && rawSource.format.trim()
      ? rawSource.format.trim()
      : defaults.format,
    maxItems: Number.isFinite(Number(rawSource.maxItems))
      ? Number(rawSource.maxItems)
      : defaults.maxItems
  }
}

// A challenge cadence has to be a whole number of milliseconds inside a sane
// band: below a second it is a hot loop against a peer, and past a day it is
// indistinguishable from never asking. Anything else is treated as unset so
// the backend default applies.
const MIN_CHALLENGE_MS = 1_000
const MAX_CHALLENGE_MS = 24 * 60 * 60 * 1000

function boundedChallengeMs(value) {
  if (value === undefined || value === null || value === '') return undefined
  const ms = Number(value)
  if (!Number.isSafeInteger(ms) || ms < MIN_CHALLENGE_MS || ms > MAX_CHALLENGE_MS) return undefined
  return ms
}

// S3 block offload keeps only a bounded resident window on the relay volume,
// so enabling it makes the bucket load bearing. Refuse incomplete credentials
// rather than silently filling the volume.
const REQUIRED_S3_OFFLOAD_FIELDS = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']

function boundedOffloadWindowBytes(value) {
  const bytes = Number(value)
  if (!Number.isSafeInteger(bytes) || bytes < 0) return DEFAULT_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES
  return bytes
}

function resolveArchiveS3Config(rawS3) {
  const merged = deepMerge(DEFAULT_ARCHIVE_S3_CONFIG, isPlainObject(rawS3) ? rawS3 : {})

  for (const field of ['endpoint', 'bucket', 'region', 'accessKeyId', 'secretAccessKey', 'prefix']) {
    merged[field] = typeof merged[field] === 'string' ? merged[field].trim() : ''
  }
  if (!merged.region) merged.region = DEFAULT_ARCHIVE_S3_CONFIG.region
  merged.forcePathStyle = Boolean(merged.forcePathStyle)
  merged.offload = Boolean(merged.offload)

  merged.offloadWindowBytes = boundedOffloadWindowBytes(merged.offloadWindowBytes)

  if (merged.offload) {
    const missing = REQUIRED_S3_OFFLOAD_FIELDS.filter((field) => !merged[field])
    if (missing.length) {
      throw new Error(`archive.s3.offload is true but archive.s3 is incomplete: missing ${missing.join(', ')}`)
    }
  }

  return merged
}


function resolveArchiveTooling(merged) {
  merged.ytDlpPath = typeof merged.ytDlpPath === 'string' && merged.ytDlpPath.trim()
    ? merged.ytDlpPath.trim()
    : DEFAULT_ARCHIVE_YT_DLP_PATH

  merged.ffmpegPath = typeof merged.ffmpegPath === 'string' && merged.ffmpegPath.trim()
    ? merged.ffmpegPath.trim()
    : DEFAULT_ARCHIVE_FFMPEG_PATH

  merged.cookiesPath = typeof merged.cookiesPath === 'string' && merged.cookiesPath.trim()
    ? merged.cookiesPath.trim()
    : null

  merged.jsRuntime = typeof merged.jsRuntime === 'string' && merged.jsRuntime.trim()
    ? merged.jsRuntime.trim()
    : DEFAULT_ARCHIVE_JS_RUNTIME

  merged.ytDlpExtraArgs = Array.isArray(merged.ytDlpExtraArgs)
    ? merged.ytDlpExtraArgs.map((arg) => String(arg).trim()).filter(Boolean)
    : splitShellArgs(String(merged.ytDlpExtraArgs || ''))
  if (!merged.ytDlpExtraArgs.length) merged.ytDlpExtraArgs = [...DEFAULT_ARCHIVE_YT_DLP_EXTRA_ARGS]

  if (Array.isArray(merged.ytDlpRetryExtraArgs)) {
    merged.ytDlpRetryExtraArgs = merged.ytDlpRetryExtraArgs
      .map((entry) => Array.isArray(entry) ? entry.map((arg) => String(arg).trim()).filter(Boolean) : splitShellArgs(String(entry || '')))
      .filter((entry) => entry.length)
  } else {
    const retryArgs = splitShellArgs(String(merged.ytDlpRetryExtraArgs || ''))
    merged.ytDlpRetryExtraArgs = retryArgs.length ? [retryArgs] : []
  }
  if (!merged.ytDlpRetryExtraArgs.length) {
    merged.ytDlpRetryExtraArgs = DEFAULT_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS.map((entry) => [...entry])
  }
}

function resolveArchiveSources(rawSources, sourceDefaults, enabled) {
  const sources = Array.isArray(rawSources) ? rawSources : []
  const seenSourceIds = new Set()
  const resolved = sources.map((entry) => {
    const normalized = normalizeSource(entry, sourceDefaults)
    if (seenSourceIds.has(normalized.sourceId)) {
      throw new Error(`Duplicate archive source: ${normalized.sourceId}`)
    }
    seenSourceIds.add(normalized.sourceId)
    return normalized
  })

  if (enabled && resolved.length === 0) {
    throw new Error('archive.enabled is true but archive.sources is empty')
  }
  return resolved
}

function resolveLocalMirrorConfig(rawLocalMirror) {
  const localMirror = isPlainObject(rawLocalMirror) ? rawLocalMirror : {}
  const resolved = {
    enabled: Boolean(localMirror.enabled),
    path: typeof localMirror.path === 'string' && localMirror.path.trim() ? localMirror.path.trim() : null,
    poll: Number(localMirror.poll),
    channelName: typeof localMirror.channelName === 'string' && localMirror.channelName.trim()
      ? localMirror.channelName.trim()
      : 'Local Drive Mirror',
    description: typeof localMirror.description === 'string' ? localMirror.description : '',
    recursive: localMirror.recursive !== false,
    maxFiles: Number(localMirror.maxFiles)
  }
  if (!Number.isFinite(resolved.poll) || resolved.poll <= 0) {
    resolved.poll = DEFAULT_LOCAL_MIRROR_POLL_SECONDS
  }
  if (!Number.isFinite(resolved.maxFiles) || resolved.maxFiles <= 0) {
    resolved.maxFiles = DEFAULT_ARCHIVE_MAX_ITEMS
  }
  if (resolved.enabled && !resolved.path) {
    throw new Error('archive.localMirror.enabled is true but archive.localMirror.path is empty')
  }
  return resolved
}

function resolveArchiveConfig(rawArchive, { storagePath }) {
  const merged = deepMerge(DEFAULT_ARCHIVE_CONFIG, isPlainObject(rawArchive) ? rawArchive : {})

  merged.enabled = Boolean(merged.enabled)

  merged.poll = Number(merged.poll)
  if (!Number.isFinite(merged.poll) || merged.poll <= 0) {
    merged.poll = DEFAULT_ARCHIVE_POLL_SECONDS
  }

  merged.format = typeof merged.format === 'string' && merged.format.trim()
    ? merged.format.trim()
    : DEFAULT_ARCHIVE_FORMAT

  resolveArchiveTooling(merged)

  merged.maxRetries = Number(merged.maxRetries)
  if (!Number.isFinite(merged.maxRetries) || merged.maxRetries < 0) {
    merged.maxRetries = DEFAULT_ARCHIVE_MAX_RETRIES
  }

  merged.budgetReservePercent = Number(merged.budgetReservePercent)
  if (!Number.isFinite(merged.budgetReservePercent) || merged.budgetReservePercent < 0 || merged.budgetReservePercent > 50) {
    merged.budgetReservePercent = DEFAULT_ARCHIVE_CONFIG.budgetReservePercent
  }

  merged.maxItems = Number(merged.maxItems)
  if (!Number.isFinite(merged.maxItems) || merged.maxItems <= 0) {
    merged.maxItems = DEFAULT_ARCHIVE_MAX_ITEMS
  }

  // Legacy archive.maxDirectDownloadBytes is no longer a policy surface.
  // File-size limits are storage policy, not archive downloader policy, so
  // normalize every value to the no-cap sentinel.
  merged.maxDirectDownloadBytes = 0

  if (typeof merged.tmpPath !== 'string' || !merged.tmpPath) {
    merged.tmpPath = join(storagePath, 'archive-tmp')
  }

  merged.uiEnabled = Boolean(merged.uiEnabled)
  merged.uiHost = typeof merged.uiHost === 'string' && merged.uiHost
    ? merged.uiHost
    : '127.0.0.1'
  merged.uiPort = Number(merged.uiPort)
  if (!Number.isFinite(merged.uiPort) || merged.uiPort <= 0) {
    throw new Error('archive.uiPort must be a positive number')
  }

  const sourceDefaults = {
    format: merged.format,
    maxItems: merged.maxItems
  }

  merged.sources = resolveArchiveSources(merged.sources, sourceDefaults, merged.enabled)
  merged.localMirror = resolveLocalMirrorConfig(merged.localMirror)

  // How often this relay challenges the archivists holding its content, and
  // how long it waits for a proof. Left unset the backend picks its own
  // defaults; an operator who wants custody confirmed sooner than every five
  // minutes - or anyone trying to prove mirroring works at all - had no way to
  // ask for it, because these never reached the backend that already accepts
  // them. Out-of-range values are dropped rather than clamped, so a typo does
  // not quietly become a hot loop against every peer.
  merged.challengeIntervalMs = boundedChallengeMs(merged.challengeIntervalMs)
  merged.challengeTimeoutMs = boundedChallengeMs(merged.challengeTimeoutMs)

  merged.s3 = resolveArchiveS3Config(merged.s3)

  return merged
}

function resolveClassificationConfig(rawClassification) {
  const merged = deepMerge(DEFAULT_CLASSIFICATION_CONFIG, isPlainObject(rawClassification) ? rawClassification : {})
  const tmdb = isPlainObject(merged.tmdb) ? merged.tmdb : {}
  const apiKey = typeof tmdb.apiKey === 'string' ? tmdb.apiKey.trim() : ''
  return {
    tmdb: {
      apiKey,
      enabled: Boolean(tmdb.enabled) && Boolean(apiKey),
      baseUrl: typeof tmdb.baseUrl === 'string' && tmdb.baseUrl.trim() ? tmdb.baseUrl.trim() : DEFAULT_TMDB_BASE_URL,
      language: typeof tmdb.language === 'string' && tmdb.language.trim() ? tmdb.language.trim() : DEFAULT_TMDB_LANGUAGE
    }
  }
}

function resolveSeedPinConfig(rawSeedPin) {
  if (!isPlainObject(rawSeedPin)) throw new Error('seedPin must be an object')
  const merged = deepMerge(DEFAULT_SEED_PIN_CONFIG, rawSeedPin)
  if (typeof merged.enabled !== 'boolean') {
    throw new Error('seedPin.enabled must be a boolean')
  }
  if (typeof merged.maxBytes !== 'number' ||
      !Number.isSafeInteger(merged.maxBytes) ||
      merged.maxBytes <= 0) {
    throw new Error('seedPin.maxBytes must be a positive safe integer; use seedPin.enabled=false to disable')
  }
  if (typeof merged.maxConcurrent !== 'number' ||
      !Number.isSafeInteger(merged.maxConcurrent) ||
      merged.maxConcurrent <= 0 ||
      merged.maxConcurrent > MAX_SEED_PIN_CONCURRENT) {
    throw new Error(`seedPin.maxConcurrent must be an integer between 1 and ${MAX_SEED_PIN_CONCURRENT}`)
  }
  if (typeof merged.retentionDays !== 'number' ||
      !Number.isSafeInteger(merged.retentionDays) ||
      merged.retentionDays < 0 ||
      merged.retentionDays > Math.floor(Number.MAX_SAFE_INTEGER / 86400000)) {
    throw new Error('seedPin.retentionDays must be a bounded non-negative safe integer')
  }
  if (!Array.isArray(merged.trustedClients) ||
      merged.trustedClients.length > MAX_SEED_PIN_TRUSTED_CLIENTS) {
    throw new Error(`seedPin.trustedClients must be an array of at most ${MAX_SEED_PIN_TRUSTED_CLIENTS} identity keys`)
  }
  const trustedClients = []
  const seen = new Set()
  for (const value of merged.trustedClients) {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error('seedPin.trustedClients entries must be exact 32-byte identity public keys')
    }
    const identityPublicKey = value.toLowerCase()
    if (seen.has(identityPublicKey)) continue
    seen.add(identityPublicKey)
    trustedClients.push(identityPublicKey)
  }
  return {
    enabled: merged.enabled,
    maxBytes: merged.maxBytes,
    maxConcurrent: merged.maxConcurrent,
    retentionDays: merged.retentionDays,
    trustedClients,
  }
}

function resolveRelayModeAndPolicy(config, requestedMode, requestedPolicy) {
  config.mode = config.mode || RELAY_MODE_PUBLIC
  if (config.mode === RELAY_MODE_PRIVATE && requestedMode === RELAY_MODE_PRIVATE && requestedPolicy === undefined) {
    config.policy = RELAY_POLICY_ALLOWLIST
  } else {
    config.policy = config.policy || (config.mode === RELAY_MODE_PRIVATE ? RELAY_POLICY_ALLOWLIST : RELAY_POLICY_DISCOVERY)
  }

  if (!VALID_MODES.includes(config.mode)) {
    throw new Error(`Invalid relay mode "${config.mode}"`)
  }

  if (!VALID_POLICIES.includes(config.policy)) {
    throw new Error(`Invalid relay policy "${config.policy}"`)
  }

  if (config.mode === RELAY_MODE_PRIVATE && config.policy !== RELAY_POLICY_ALLOWLIST) {
    throw new Error('private mode only supports allowlist policy')
  }
}

function resolveRelayStorageAndAdmission(config) {
  config.storage = deepMerge(DEFAULT_RELAY_CONFIG.storage, config.storage || {})
  config.storage.maxBytes = Number(config.storage.maxBytes)
  if (!Number.isFinite(config.storage.maxBytes) || config.storage.maxBytes <= 0) {
    throw new Error('storage.maxBytes must be a positive number')
  }
  config.storage.minFreeBytes = Number(config.storage.minFreeBytes)
  if (!Number.isFinite(config.storage.minFreeBytes) || config.storage.minFreeBytes < 0) {
    config.storage.minFreeBytes = 0
  }

  config.admission = deepMerge(DEFAULT_RELAY_CONFIG.admission, config.admission || {})
  config.admission.channels = splitCommaList(config.admission.channels)
  config.admission.owners = splitCommaList(config.admission.owners)
}

function resolveRelayDiscovery(config) {
  config.discovery = deepMerge(DEFAULT_RELAY_CONFIG.discovery, config.discovery || {})
  config.discovery.enabled = config.mode === RELAY_MODE_PUBLIC && config.policy === RELAY_POLICY_DISCOVERY
    ? config.discovery.enabled !== false
    : false
  config.discovery.seedDiscovered = config.discovery.seedDiscovered !== false
  config.discovery.maxChannels = Number(config.discovery.maxChannels)
  config.discovery.maxChannelsPerOwner = Number(config.discovery.maxChannelsPerOwner)

  if (!Number.isFinite(config.discovery.maxChannels) || config.discovery.maxChannels < 0) {
    throw new Error('discovery.maxChannels must be a non-negative number')
  }

  if (!Number.isFinite(config.discovery.maxChannelsPerOwner) || config.discovery.maxChannelsPerOwner < 0) {
    throw new Error('discovery.maxChannelsPerOwner must be a non-negative number')
  }
}

function resolveRelayCompanion(input, env, config) {
  const explicitCompanionPort = Boolean(
    input?.companion?.hasExplicitPort ||
    input?.companion?.port !== undefined ||
    env?.PEARTUBE_COMPANION_PORT !== undefined
  )
  const explicitCompanionAuth = input?.companion?.auth !== undefined
    ? parseBoolean(input.companion.auth, false)
    : (env?.PEARTUBE_COMPANION_AUTH !== undefined
      ? parseBoolean(env.PEARTUBE_COMPANION_AUTH, false)
      : Boolean(input?.companion?.sharedSecret || env?.PEARTUBE_COMPANION_SHARED_SECRET))
  return resolveCompanionConfig(config.companion, {
    storagePath: config.storage.path,
    hasExplicitPort: explicitCompanionPort,
    auth: explicitCompanionAuth
  })
}

export function resolveRelayConfig(input = {}, { env = process.env || {} } = {}) {
  const requestedMode = input.mode
  const requestedPolicy = input.policy
  let config = deepMerge(clone(DEFAULT_RELAY_CONFIG), configFromEnv(env))
  config = deepMerge(config, input)

  resolveRelayModeAndPolicy(config, requestedMode, requestedPolicy)
  resolveRelayStorageAndAdmission(config)
  resolveRelayDiscovery(config)

  config.seedPin = resolveSeedPinConfig(config.seedPin)
  config.network = deepMerge(DEFAULT_RELAY_CONFIG.network, config.network || {})
  config.logging = deepMerge(DEFAULT_RELAY_CONFIG.logging, config.logging || {})
  config.companion = resolveRelayCompanion(input, env, config)

  config.reseed = { enabled: (config.reseed || {}).enabled !== false }
  config.archive = resolveArchiveConfig(config.archive, { storagePath: config.storage.path })
  config.classification = resolveClassificationConfig(config.classification)

  const runtimeDbPath = join(config.storage.path, 'db')
  config.paths = {
    catalog: join(runtimeDbPath, RELAY_CATALOG_FILENAME),
    status: join(runtimeDbPath, RELAY_STATUS_FILENAME),
    creators: join(runtimeDbPath, RELAY_CREATORS_FILENAME),
    classification: join(runtimeDbPath, RELAY_CLASSIFICATION_FILENAME),
    trustedClients: join(runtimeDbPath, RELAY_TRUSTED_CLIENTS_FILENAME),
    corestore: join(config.storage.path, 'corestore'),
    archiveTmpPath: config.archive.tmpPath
  }

  config.env = {
    configPath: env.PEARTUBE_CONFIG || null
  }

  return config
}

export async function loadRelayConfig(cli = {}, { env = process.env || {} } = {}) {
  const configPath = cli.config || env.PEARTUBE_CONFIG || null
  const fileConfig = configPath ? readConfigFile(configPath) : {}
  const envConfig = configFromEnv(env)
  const cliConfig = configFromCli(cli)

  const merged = deepMerge(deepMerge(fileConfig, envConfig), cliConfig)
  const config = resolveRelayConfig(merged, { env })

  if (configPath) {
    config.paths.config = configPath
  }

  return config
}

function renderAdmissionLines(admission) {
  const lines = ['admission:']
  if (admission?.channels?.length) {
    lines.push('  channels:')
    for (const channel of admission.channels) {
      lines.push(`    - ${channel}`)
    }
  } else {
    lines.push('  channels: []')
  }

  if (admission?.owners?.length) {
    lines.push('  owners:')
    for (const owner of admission.owners) {
      lines.push(`    - ${owner}`)
    }
  } else {
    lines.push('  owners: []')
  }
  return lines
}

function renderSeedPinLines(rawSeedPin) {
  const seedPin = rawSeedPin || DEFAULT_SEED_PIN_CONFIG
  const lines = [
    'seedPin:',
    `  enabled: ${seedPin.enabled}`,
    `  maxBytes: ${seedPin.maxBytes}`,
    `  maxConcurrent: ${seedPin.maxConcurrent}`,
    `  retentionDays: ${seedPin.retentionDays}`
  ]
  if (seedPin.trustedClients?.length) {
    lines.push('  trustedClients:')
    for (const identityPublicKey of seedPin.trustedClients) {
      lines.push(`    - ${identityPublicKey}`)
    }
  } else {
    lines.push('  trustedClients: []')
  }
  return lines
}

function renderCompanionLines(rawCompanion) {
  const companion = rawCompanion || DEFAULT_RELAY_CONFIG.companion
  return [
    'companion:',
    `  enabled: ${companion.enabled !== false}`,
    `  host: ${companion.host || '127.0.0.1'}`,
    `  port: ${companion.port ?? 8175}`,
    `  client: ${companion.client || 'client'}`,
    `  publisherId: ${companion.publisherId || companion.client || 'client'}`,
    `  scopes: ${(companion.scopes || ['*']).join(',')}`,
    `  maxBodyBytes: ${companion.maxBodyBytes ?? 1048576}`,
    `  maxClockSkewMs: ${companion.maxClockSkewMs ?? 30000}`,
    `  maxNonces: ${companion.maxNonces ?? 4096}`,
    '  # Set sharedSecret with PEARTUBE_COMPANION_SHARED_SECRET; secrets are never rendered.'
  ]
}

function renderArchiveLines(rawArchive) {
  const archive = rawArchive || DEFAULT_ARCHIVE_CONFIG
  const lines = [
    'archive:',
    `  uiEnabled: ${Boolean(archive.uiEnabled)}`,
    `  uiHost: ${archive.uiHost || '127.0.0.1'}`,
    `  uiPort: ${archive.uiPort || 8174}`,
    `  tmpPath: ${archive.tmpPath || './peartube-relay/archive-tmp'}`,
    `  enabled: ${Boolean(archive.enabled)}`,
    `  poll: ${archive.poll || DEFAULT_ARCHIVE_POLL_SECONDS}`,
    `  maxItems: ${archive.maxItems || DEFAULT_ARCHIVE_MAX_ITEMS}`,
    `  maxRetries: ${archive.maxRetries ?? DEFAULT_ARCHIVE_MAX_RETRIES}`,
    `  format: "${archive.format || DEFAULT_ARCHIVE_FORMAT}"`
  ]
  const localMirror = archive.localMirror || {}
  lines.push(
    '  localMirror:',
    `    enabled: ${Boolean(localMirror.enabled)}`,
    `    path: ${localMirror.path || ''}`,
    `    poll: ${localMirror.poll || DEFAULT_LOCAL_MIRROR_POLL_SECONDS}`,
    `    channelName: "${localMirror.channelName || 'Local Drive Mirror'}"`,
    `    description: "${localMirror.description || ''}"`,
    `    recursive: ${localMirror.recursive !== false}`,
    `    maxFiles: ${localMirror.maxFiles || DEFAULT_ARCHIVE_MAX_ITEMS}`
  )
  if (Array.isArray(archive.sources) && archive.sources.length) {
    lines.push('  sources:')
    for (const source of archive.sources) {
      lines.push(`    - url: ${source.url}`)
      if (source.label) lines.push(`      label: ${source.label}`)
    }
  } else {
    lines.push('  sources: []')
  }
  return lines
}

export function renderExampleConfig(config = DEFAULT_RELAY_CONFIG) {
  const lines = [
    `mode: ${config.mode}`,
    `policy: ${config.policy}`,
    'storage:',
    `  path: ${config.storage.path}`,
    `  maxBytes: ${config.storage.maxBytes}`
  ]

  lines.push(...renderAdmissionLines(config.admission))
  lines.push(...renderSeedPinLines(config.seedPin))

  lines.push(
    'discovery:',
    `  enabled: ${config.discovery.enabled}`,
    `  seedDiscovered: ${config.discovery.seedDiscovered !== false}`,
    `  maxChannels: ${config.discovery.maxChannels}`,
    `  maxChannelsPerOwner: ${config.discovery.maxChannelsPerOwner}`
  )

  lines.push(
    'reseed:',
    `  enabled: ${config.reseed?.enabled !== false}`
  )

  lines.push(...renderCompanionLines(config.companion))
  lines.push(...renderArchiveLines(config.archive))

  const classification = config.classification || DEFAULT_CLASSIFICATION_CONFIG
  const tmdb = classification.tmdb || {}
  lines.push(
    'classification:',
    '  tmdb:',
    `    enabled: ${Boolean(tmdb.enabled)}`,
    `    apiKey: "${tmdb.apiKey || ''}"`,
    `    baseUrl: ${tmdb.baseUrl || DEFAULT_TMDB_BASE_URL}`,
    `    language: ${tmdb.language || DEFAULT_TMDB_LANGUAGE}`
  )

  lines.push(
    'logging:',
    `  level: ${config.logging.level}`,
    ''
  )

  return lines.join('\n')
}
