import { DEFAULT_COMPANION_CONFIG } from '../constants.js'

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

function routeScopes (value) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const scopes = entries.map(scope => String(scope).trim()).filter(Boolean)
  if (scopes.length === 0 || scopes.length > 32 || new Set(scopes).size !== scopes.length ||
      scopes.some(scope => scope !== '*' && !/^[a-z][a-z0-9.-]{0,63}$/.test(scope))) {
    throw new Error('companion.scopes must contain 1 to 32 unique route scopes')
  }
  return scopes
}

export function companionConfigFromEnv (env = {}) {
  const config = {}
  if (has(env, 'PEARTUBE_COMPANION_ENABLED')) config.enabled = env.PEARTUBE_COMPANION_ENABLED
  if (has(env, 'PEARTUBE_COMPANION_AUTH')) config.auth = env.PEARTUBE_COMPANION_AUTH
  if (has(env, 'PEARTUBE_COMPANION_HOST')) config.host = env.PEARTUBE_COMPANION_HOST
  if (has(env, 'PEARTUBE_COMPANION_PORT')) {
    config.port = env.PEARTUBE_COMPANION_PORT
    config.hasExplicitPort = true
  }
  if (has(env, 'PEARTUBE_COMPANION_CLIENT')) config.client = env.PEARTUBE_COMPANION_CLIENT
  if (has(env, 'PEARTUBE_COMPANION_PUBLISHER_ID')) config.publisherId = env.PEARTUBE_COMPANION_PUBLISHER_ID
  if (has(env, 'PEARTUBE_COMPANION_SCOPES')) config.scopes = env.PEARTUBE_COMPANION_SCOPES
  if (has(env, 'PEARTUBE_COMPANION_SHARED_SECRET')) config.sharedSecret = env.PEARTUBE_COMPANION_SHARED_SECRET
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_ORIGIN')) config.sourceOrigin = env.PEARTUBE_COMPANION_SOURCE_ORIGIN
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_CLIENT')) config.sourceClient = env.PEARTUBE_COMPANION_SOURCE_CLIENT
  if (has(env, 'PEARTUBE_COMPANION_SOURCE_SHARED_SECRET')) config.sourceSharedSecret = env.PEARTUBE_COMPANION_SOURCE_SHARED_SECRET
  if (has(env, 'PEARTUBE_COMPANION_MAX_BODY_BYTES')) config.maxBodyBytes = env.PEARTUBE_COMPANION_MAX_BODY_BYTES
  if (has(env, 'PEARTUBE_COMPANION_MAX_CLOCK_SKEW_MS')) config.maxClockSkewMs = env.PEARTUBE_COMPANION_MAX_CLOCK_SKEW_MS
  if (has(env, 'PEARTUBE_COMPANION_MAX_NONCES')) config.maxNonces = env.PEARTUBE_COMPANION_MAX_NONCES
  return Object.keys(config).length ? { companion: config } : {}
}

export function companionConfigFromCli (cli = {}) {
  const config = cli.companion && typeof cli.companion === 'object'
    ? { ...cli.companion }
    : {}
  const fields = {
    companionEnabled: 'enabled',
    companionAuth: 'auth',
    companionHost: 'host',
    companionPort: 'port',
    companionClient: 'client',
    companionPublisherId: 'publisherId',
    companionScopes: 'scopes',
    companionSharedSecret: 'sharedSecret',
    companionSourceOrigin: 'sourceOrigin',
    companionSourceClient: 'sourceClient',
    companionSourceSharedSecret: 'sourceSharedSecret',
    companionMaxBodyBytes: 'maxBodyBytes',
    companionMaxClockSkewMs: 'maxClockSkewMs',
    companionMaxNonces: 'maxNonces'
  }
  if (has(cli, 'companionPort')) config.hasExplicitPort = true
  for (const [source, target] of Object.entries(fields)) {
    if (has(cli, source)) config[target] = cli[source]
  }
  return Object.keys(config).length ? { companion: config } : {}
}

export function resolveCompanionConfig (raw = {}, options = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULT_COMPANION_CONFIG, ...source }
  config.hasExplicitPort = Boolean(options.hasExplicitPort || source.hasExplicitPort)
  config.enabled = parseBoolean(config.enabled, DEFAULT_COMPANION_CONFIG.enabled)
  config.auth = options.auth !== undefined
    ? parseBoolean(options.auth, DEFAULT_COMPANION_CONFIG.auth)
    : (source.auth !== undefined ? parseBoolean(source.auth, DEFAULT_COMPANION_CONFIG.auth) : DEFAULT_COMPANION_CONFIG.auth)
  // The machine API is HTTP-only. Keep transport in the resolved state as a
  // protocol fact for status responses, not as an operator-selectable branch.
  config.transport = 'tcp'
  delete config.socketPath
  config.host = typeof config.host === 'string' && config.host.trim()
    ? config.host.trim()
    : DEFAULT_COMPANION_CONFIG.host
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(config.host.toLowerCase())) {
    throw new Error('companion TCP transport must bind to loopback because it does not provide TLS')
  }
  config.port = Number(config.port)
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('companion.port must be an integer from 0 through 65535')
  }
  config.client = typeof config.client === 'string' ? config.client.trim() : ''
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.client)) {
    throw new Error('companion.client must be 1 to 128 identifier characters')
  }
  config.publisherId = config.publisherId == null || config.publisherId === ''
    ? config.client
    : String(config.publisherId).trim()
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(config.publisherId)) {
    throw new Error('companion.publisherId must be 1 to 128 identifier characters')
  }
  config.scopes = routeScopes(config.scopes)
  config.sharedSecret = typeof config.sharedSecret === 'string' ? config.sharedSecret : ''
  if (config.sharedSecret && !/^[a-f0-9]{64}$/.test(config.sharedSecret)) {
    throw new Error('companion.sharedSecret must be 64 lowercase hexadecimal characters')
  }
  if (config.auth && config.enabled && !config.sharedSecret) {
    throw new Error('companion.sharedSecret is required when companion auth is enabled')
  }
  config.sourceOrigin = typeof config.sourceOrigin === 'string' && config.sourceOrigin.trim()
    ? config.sourceOrigin.trim().replace(/\/+$/, '')
    : ''
  config.sourceClient = typeof config.sourceClient === 'string' && config.sourceClient.trim()
    ? config.sourceClient.trim()
    : 'peartube-companion'
  config.sourceSharedSecret = typeof config.sourceSharedSecret === 'string' && config.sourceSharedSecret.trim()
    ? config.sourceSharedSecret.trim()
    : config.sharedSecret
  config.maxBodyBytes = positiveInteger(config.maxBodyBytes, undefined, 'companion.maxBodyBytes')
  config.maxClockSkewMs = positiveInteger(config.maxClockSkewMs, undefined, 'companion.maxClockSkewMs')
  config.maxNonces = positiveInteger(config.maxNonces, undefined, 'companion.maxNonces')
  return config
}
