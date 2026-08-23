import { join } from '#path'
import { DEFAULT_COMPANION_CONFIG, MAX_SOURCE_CHUNK_BYTES } from '../constants.js'

function has (object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

function parseBoolean (value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function positiveInteger (value, fallback, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function exactOrigin (value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error('companion.sourceOrigin must be an exact HTTP(S) origin')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('companion.sourceOrigin must be an exact HTTP(S) origin')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('companion.sourceOrigin must be an exact HTTP(S) origin')
  }
  return parsed.origin
}

export function companionConfigFromEnv (env = {}) {
  const config = {}
  if (has(env, 'PEARTUBE_COMPANION_ENABLED')) config.enabled = env.PEARTUBE_COMPANION_ENABLED
  if (has(env, 'PEARTUBE_COMPANION_TRANSPORT')) config.transport = env.PEARTUBE_COMPANION_TRANSPORT
  if (has(env, 'PEARTUBE_COMPANION_SOCKET_PATH')) config.socketPath = env.PEARTUBE_COMPANION_SOCKET_PATH
  if (has(env, 'PEARTUBE_COMPANION_HOST')) config.host = env.PEARTUBE_COMPANION_HOST
  if (has(env, 'PEARTUBE_COMPANION_PORT')) config.port = env.PEARTUBE_COMPANION_PORT
  if (has(env, 'PEARTUBE_COMPANION_CLIENT')) config.client = env.PEARTUBE_COMPANION_CLIENT
  if (has(env, 'PEARTUBE_COMPANION_SHARED_SECRET')) config.sharedSecret = env.PEARTUBE_COMPANION_SHARED_SECRET
  if (has(env, 'PEARTUBE_COMPANION_MAX_BODY_BYTES')) config.maxBodyBytes = env.PEARTUBE_COMPANION_MAX_BODY_BYTES
  if (has(env, 'PEARTUBE_COMPANION_MAX_CLOCK_SKEW_MS')) config.maxClockSkewMs = env.PEARTUBE_COMPANION_MAX_CLOCK_SKEW_MS
  if (has(env, 'PEARTUBE_COMPANION_MAX_NONCES')) config.maxNonces = env.PEARTUBE_COMPANION_MAX_NONCES
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_ORIGIN')) config.sourceOrigin = env.PEARTUBE_COMPANION_SOURCE_ORIGIN
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_CLIENT')) config.sourceClient = env.PEARTUBE_COMPANION_SOURCE_CLIENT
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_SHARED_SECRET')) config.sourceSharedSecret = env.PEARTUBE_COMPANION_SOURCE_SHARED_SECRET
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_CHUNK_BYTES')) config.sourceChunkBytes = env.PEARTUBE_COMPANION_SOURCE_CHUNK_BYTES
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_REQUEST_TIMEOUT_MS')) config.sourceRequestTimeoutMs = env.PEARTUBE_COMPANION_SOURCE_REQUEST_TIMEOUT_MS
  return Object.keys(config).length ? { companion: config } : {}
}

export function companionConfigFromCli (cli = {}) {
  const config = cli.companion && typeof cli.companion === 'object'
    ? { ...cli.companion }
    : {}
  const fields = {
    companionEnabled: 'enabled',
    companionTransport: 'transport',
    companionSocketPath: 'socketPath',
    companionHost: 'host',
    companionPort: 'port',
    companionClient: 'client',
    companionSharedSecret: 'sharedSecret',
    companionMaxBodyBytes: 'maxBodyBytes',
    companionMaxClockSkewMs: 'maxClockSkewMs',
    companionMaxNonces: 'maxNonces',
    companionSourceOrigin: 'sourceOrigin',
    companionSourceClient: 'sourceClient',
    companionSourceSharedSecret: 'sourceSharedSecret',
    companionSourceChunkBytes: 'sourceChunkBytes',
    companionSourceRequestTimeoutMs: 'sourceRequestTimeoutMs'
  }
  for (const [source, target] of Object.entries(fields)) {
    if (has(cli, source)) config[target] = cli[source]
  }
  return Object.keys(config).length ? { companion: config } : {}
}

export function resolveCompanionConfig (raw = {}, { storagePath } = {}) {
  if (typeof storagePath !== 'string' || !storagePath.trim()) {
    throw new Error('storage.path is required to resolve companion configuration')
  }

  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULT_COMPANION_CONFIG, ...source }
  config.enabled = parseBoolean(config.enabled, DEFAULT_COMPANION_CONFIG.enabled)
  config.transport = typeof config.transport === 'string' ? config.transport.trim().toLowerCase() : ''
  if (config.transport !== 'unix' && config.transport !== 'tcp') {
    throw new Error('companion.transport must be "unix" or "tcp"')
  }

  config.socketPath = typeof config.socketPath === 'string' && config.socketPath.trim()
    ? config.socketPath.trim()
    : join(storagePath, '.pt', 's')
  config.host = typeof config.host === 'string' && config.host.trim()
    ? config.host.trim()
    : DEFAULT_COMPANION_CONFIG.host
  config.port = Number(config.port)
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('companion.port must be an integer from 0 through 65535')
  }
  config.client = typeof config.client === 'string' ? config.client.trim() : ''
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.client)) {
    throw new Error('companion.client must be 1 to 128 identifier characters')
  }
  config.sharedSecret = typeof config.sharedSecret === 'string' ? config.sharedSecret : ''
  if (config.sharedSecret && !/^[a-f0-9]{64}$/.test(config.sharedSecret)) {
    throw new Error('companion.sharedSecret must be 64 lowercase hexadecimal characters')
  }
  if (config.enabled && !config.sharedSecret) {
    throw new Error('companion.sharedSecret is required when the companion is enabled')
  }
  config.maxBodyBytes = positiveInteger(config.maxBodyBytes, undefined, 'companion.maxBodyBytes')
  config.maxClockSkewMs = positiveInteger(config.maxClockSkewMs, undefined, 'companion.maxClockSkewMs')
  config.maxNonces = positiveInteger(config.maxNonces, undefined, 'companion.maxNonces')
  config.sourceOrigin = exactOrigin(config.sourceOrigin)
  config.sourceClient = typeof config.sourceClient === 'string' ? config.sourceClient.trim() : ''
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.sourceClient)) {
    throw new Error('companion.sourceClient must be 1 to 128 identifier characters')
  }
  config.sourceSharedSecret = typeof config.sourceSharedSecret === 'string' && config.sourceSharedSecret
    ? config.sourceSharedSecret
    : config.sharedSecret
  if (config.sourceSharedSecret && !/^[a-f0-9]{64}$/.test(config.sourceSharedSecret)) {
    throw new Error('companion.sourceSharedSecret must be 64 lowercase hexadecimal characters')
  }
  if (config.sourceOrigin && !config.sourceSharedSecret) {
    throw new Error('companion.sourceSharedSecret is required when sourceOrigin is configured')
  }
  config.sourceChunkBytes = positiveInteger(config.sourceChunkBytes, undefined, 'companion.sourceChunkBytes')
  if (config.sourceChunkBytes > MAX_SOURCE_CHUNK_BYTES) {
    throw new Error(`companion.sourceChunkBytes must not exceed ${MAX_SOURCE_CHUNK_BYTES}`)
  }
  config.sourceRequestTimeoutMs = positiveInteger(config.sourceRequestTimeoutMs, undefined, 'companion.sourceRequestTimeoutMs')
  return config
}
