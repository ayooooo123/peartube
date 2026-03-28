import { readFileSync } from '#fs'
import { join } from '#path'
import {
  DEFAULT_RELAY_CONFIG,
  RELAY_CATALOG_FILENAME,
  RELAY_MODE_PRIVATE,
  RELAY_MODE_PUBLIC,
  RELAY_POLICY_ALLOWLIST,
  RELAY_POLICY_DISCOVERY,
  RELAY_STATUS_FILENAME,
  VALID_MODES,
  VALID_POLICIES
} from './constants.js'

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

function configFromEnv(env = {}) {
  const config = {}

  if (env.PEARTUBE_MODE) config.mode = env.PEARTUBE_MODE
  if (env.PEARTUBE_POLICY) config.policy = env.PEARTUBE_POLICY
  if (env.PEARTUBE_STORAGE_PATH || env.PEARTUBE_STORAGE_MAX_BYTES) {
    config.storage = {}
    if (env.PEARTUBE_STORAGE_PATH) config.storage.path = env.PEARTUBE_STORAGE_PATH
    if (env.PEARTUBE_STORAGE_MAX_BYTES) config.storage.maxBytes = Number(env.PEARTUBE_STORAGE_MAX_BYTES)
  }
  if (env.PEARTUBE_ADMISSION_CHANNELS || env.PEARTUBE_ADMISSION_OWNERS) {
    config.admission = {}
    if (env.PEARTUBE_ADMISSION_CHANNELS) config.admission.channels = splitCommaList(env.PEARTUBE_ADMISSION_CHANNELS)
    if (env.PEARTUBE_ADMISSION_OWNERS) config.admission.owners = splitCommaList(env.PEARTUBE_ADMISSION_OWNERS)
  }
  if (env.PEARTUBE_DISCOVERY_ENABLED || env.PEARTUBE_DISCOVERY_MAX_CHANNELS || env.PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER) {
    config.discovery = {}
    if (env.PEARTUBE_DISCOVERY_ENABLED) config.discovery.enabled = parseBoolean(env.PEARTUBE_DISCOVERY_ENABLED)
    if (env.PEARTUBE_DISCOVERY_MAX_CHANNELS) config.discovery.maxChannels = Number(env.PEARTUBE_DISCOVERY_MAX_CHANNELS)
    if (env.PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER) {
      config.discovery.maxChannelsPerOwner = Number(env.PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER)
    }
  }
  if (env.PEARTUBE_NETWORK_ANNOUNCE || env.PEARTUBE_NETWORK_BOOTSTRAP) {
    config.network = {}
    if (env.PEARTUBE_NETWORK_ANNOUNCE) config.network.announce = parseBoolean(env.PEARTUBE_NETWORK_ANNOUNCE)
    if (env.PEARTUBE_NETWORK_BOOTSTRAP) config.network.bootstrap = env.PEARTUBE_NETWORK_BOOTSTRAP
  }
  if (env.PEARTUBE_RETENTION_PROTECT_PRIVATE || env.PEARTUBE_RETENTION_PROTECT_ALLOWLIST) {
    config.retention = {}
    if (env.PEARTUBE_RETENTION_PROTECT_PRIVATE) {
      config.retention.protectPrivate = parseBoolean(env.PEARTUBE_RETENTION_PROTECT_PRIVATE)
    }
    if (env.PEARTUBE_RETENTION_PROTECT_ALLOWLIST) {
      config.retention.protectAllowlist = parseBoolean(env.PEARTUBE_RETENTION_PROTECT_ALLOWLIST)
    }
  }
  if (env.PEARTUBE_LOG_LEVEL) {
    config.logging = { level: env.PEARTUBE_LOG_LEVEL }
  }

  return config
}

function configFromCli(cli = {}) {
  const config = {}

  if (cli.mode) config.mode = cli.mode
  if (cli.policy) config.policy = cli.policy

  if (cli.storage || cli.maxBytes !== undefined || cli.maxStorage !== undefined) {
    config.storage = {}
    if (cli.storage) config.storage.path = cli.storage
    if (cli.maxBytes !== undefined) config.storage.maxBytes = Number(cli.maxBytes)
    if (cli.maxStorage !== undefined) config.storage.maxBytes = Number(cli.maxStorage) * 1024 * 1024
  }

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

  return config
}

export function resolveRelayConfig(input = {}, { env = process.env } = {}) {
  const requestedMode = input.mode
  const requestedPolicy = input.policy
  let config = deepMerge(clone(DEFAULT_RELAY_CONFIG), configFromEnv(env))
  config = deepMerge(config, input)

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

  config.storage = deepMerge(DEFAULT_RELAY_CONFIG.storage, config.storage || {})
  config.storage.maxBytes = Number(config.storage.maxBytes)

  if (!Number.isFinite(config.storage.maxBytes) || config.storage.maxBytes <= 0) {
    throw new Error('storage.maxBytes must be a positive number')
  }

  config.admission = deepMerge(DEFAULT_RELAY_CONFIG.admission, config.admission || {})
  config.admission.channels = splitCommaList(config.admission.channels)
  config.admission.owners = splitCommaList(config.admission.owners)

  config.discovery = deepMerge(DEFAULT_RELAY_CONFIG.discovery, config.discovery || {})
  config.discovery.enabled = config.mode === RELAY_MODE_PUBLIC && config.policy === RELAY_POLICY_DISCOVERY
    ? config.discovery.enabled !== false
    : false
  config.discovery.maxChannels = Number(config.discovery.maxChannels)
  config.discovery.maxChannelsPerOwner = Number(config.discovery.maxChannelsPerOwner)

  if (!Number.isFinite(config.discovery.maxChannels) || config.discovery.maxChannels < 0) {
    throw new Error('discovery.maxChannels must be a non-negative number')
  }

  if (!Number.isFinite(config.discovery.maxChannelsPerOwner) || config.discovery.maxChannelsPerOwner < 0) {
    throw new Error('discovery.maxChannelsPerOwner must be a non-negative number')
  }

  config.retention = deepMerge(DEFAULT_RELAY_CONFIG.retention, config.retention || {})
  config.network = deepMerge(DEFAULT_RELAY_CONFIG.network, config.network || {})
  config.logging = deepMerge(DEFAULT_RELAY_CONFIG.logging, config.logging || {})

  config.paths = {
    catalog: join(config.storage.path, RELAY_CATALOG_FILENAME),
    status: join(config.storage.path, RELAY_STATUS_FILENAME)
  }

  config.env = {
    configPath: env.PEARTUBE_CONFIG || null
  }

  return config
}

export async function loadRelayConfig(cli = {}, { env = process.env } = {}) {
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

export function renderExampleConfig(config = DEFAULT_RELAY_CONFIG) {
  const lines = [
    `mode: ${config.mode}`,
    `policy: ${config.policy}`,
    'storage:',
    `  path: ${config.storage.path}`,
    `  maxBytes: ${config.storage.maxBytes}`,
    'admission:'
  ]

  if (config.admission?.channels?.length) {
    lines.push('  channels:')
    for (const channel of config.admission.channels) {
      lines.push(`    - ${channel}`)
    }
  } else {
    lines.push('  channels: []')
  }

  if (config.admission?.owners?.length) {
    lines.push('  owners:')
    for (const owner of config.admission.owners) {
      lines.push(`    - ${owner}`)
    }
  } else {
    lines.push('  owners: []')
  }

  lines.push(
    'discovery:',
    `  enabled: ${config.discovery.enabled}`,
    `  maxChannels: ${config.discovery.maxChannels}`,
    `  maxChannelsPerOwner: ${config.discovery.maxChannelsPerOwner}`,
    'logging:',
    `  level: ${config.logging.level}`,
    ''
  )

  return lines.join('\n')
}
