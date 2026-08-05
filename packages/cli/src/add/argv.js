import {
  ALL_COORDINATE_FLAGS,
  CONTENT_TYPES,
  coordinateCollision,
  coordinateRefusal,
  coordinateRequirement,
  coordinatesComplete,
  isQueryable,
  mediaShape,
  modeLabel,
  providerRefusal
} from './media-coordinates.js'

const COMMANDS = new Set(['add', 'config', 'get', 'help', 'search'])

const VALUE_FLAGS = new Map([
  ['--storage', 'storage'],
  ['--config', 'config'],
  ['--type', 'type'],
  ['--provider', 'provider'],
  ['--show-id', 'showId'],
  ['--season', 'season'],
  ['--episode', 'episode'],
  ['--movie-id', 'movieId'],
  ['--recording-id', 'recordingId'],
  ['--release-id', 'releaseId'],
  ['--title', 'title'],
  ['--channel-name', 'channelName'],
  ['--relay-ui', 'relayUi'],
  ['--invidious', 'invidious'],
  ['--output', 'output'],
  ['--rendition', 'rendition'],
  ['--limit', 'limit'],
  ['--kind', 'kind'],
  ['--timeout', 'timeout']
])

const BOOLEAN_FLAGS = new Map([
  ['--no-color', 'noColor'],
  ['--json', 'json'],
  ['--no-input', 'noInput'],
  ['--yes', 'yes'],
  ['--force', 'force'],
  ['--creator', 'creator'],
  ['--no-publish', 'noPublish'],
  ['--no-wait', 'noWait']
])

const REPEATABLE_FLAGS = new Map([
  ['--relay', 'relay'],
  ['--genre', 'genres']
])

const ADD_ONLY_FLAGS = [
  ['type', '--type'],
  ['provider', '--provider'],
  ...ALL_COORDINATE_FLAGS.map(([key, flag]) => [key, flag])
]

// Network commands read the swarm; add/config never take these, and the two
// network commands do not share each other's.
const SEARCH_ONLY_FLAGS = [
  ['limit', '--limit'],
  ['kind', '--kind'],
  ['genres', '--genre']
]
const GET_ONLY_FLAGS = [
  ['output', '--output'],
  ['rendition', '--rendition'],
  ['timeout', '--timeout']
]

export class PeartubeUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PeartubeUsageError'
    this.exitCode = 2
  }
}

function result(command, query, fetchUrl, flags, mode) {
  return { command, query, fetchUrl, flags, mode }
}

function canPrompt(options, flags) {
  if (flags.noInput) return false

  const stdinIsTTY = options.stdinIsTTY ?? options.stdin?.isTTY
  const stderrIsTTY = options.stderrIsTTY ?? options.stderr?.isTTY
  return Boolean(stdinIsTTY && stderrIsTTY)
}

function runtimeUrl(query) {
  if (!query) return null

  try {
    const url = new URL(query)
    return url.protocol === 'http:' || url.protocol === 'https:' ? query : null
  } catch {
    return null
  }
}

function setFlag(flags, name, key, value) {
  if (Object.hasOwn(flags, key)) {
    throw new PeartubeUsageError(`Duplicate argument ${name}`)
  }
  flags[key] = value
}

function parseFlagsAndPositionals(args) {
  const flags = {}
  const positionals = []
  let positionalOnly = false

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]

    if (positionalOnly || !token.startsWith('-')) {
      positionals.push(token)
      continue
    }

    if (token === '--') {
      positionalOnly = true
      continue
    }

    if (token === '--help' || token === '-h') {
      return { flags: { help: true }, positionals: [], help: true }
    }

    const equalsIndex = token.indexOf('=')
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex)
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1)

    const booleanKey = BOOLEAN_FLAGS.get(name)
    if (booleanKey) {
      if (inlineValue !== undefined) {
        throw new PeartubeUsageError(`${name} does not take a value`)
      }
      setFlag(flags, name, booleanKey, true)
      continue
    }

    const repeatableKey = REPEATABLE_FLAGS.get(name)
    if (repeatableKey) {
      let value = inlineValue
      if (value === undefined) {
        value = args[index + 1]
        if (value === undefined || value.startsWith('-')) {
          throw new PeartubeUsageError(`Missing value for ${name}`)
        }
        index += 1
      }
      if (value.length === 0) {
        throw new PeartubeUsageError(`Missing value for ${name}`)
      }
      if (!Array.isArray(flags[repeatableKey])) flags[repeatableKey] = []
      flags[repeatableKey].push(value)
      continue
    }

    const valueKey = VALUE_FLAGS.get(name)
    if (!valueKey) {
      throw new PeartubeUsageError(`Unknown argument ${token}`)
    }

    let value = inlineValue
    if (value === undefined) {
      value = args[index + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new PeartubeUsageError(`Missing value for ${name}`)
      }
      index += 1
    }
    if (value.length === 0) {
      throw new PeartubeUsageError(`Missing value for ${name}`)
    }

    setFlag(flags, name, valueKey, value)
  }

  if (flags.type) flags.type = flags.type.toLowerCase()
  if (flags.provider) flags.provider = flags.provider.toLowerCase()

  return { flags, positionals }
}

function refuse(message) {
  if (message) throw new PeartubeUsageError(message)
}

function validateScriptedSource(query, positionalCount) {
  if (!query) {
    throw new PeartubeUsageError('Scripted add requires one source URL or path')
  }
  if (positionalCount !== 1) {
    throw new PeartubeUsageError('Scripted add accepts exactly one source URL or path')
  }
}

function parseAdd(flags, positionals, options) {
  const query = positionals.length > 0 ? positionals.join(' ') : null
  const fetchUrl = runtimeUrl(query)
  const interactive = canPrompt(options, flags)

  if (flags.type && !CONTENT_TYPES.includes(flags.type)) {
    throw new PeartubeUsageError(`Unsupported content type "${flags.type}"; expected ${CONTENT_TYPES.map(type => `"${type}"`).join(', ')}`)
  }

  refuse(providerRefusal(flags.type, flags.provider))
  if (flags.type === undefined) refuse(coordinateCollision(flags))

  if (flags.type === 'video') {
    // No authority categorizes a direct video, so every media coordinate —
    // including the authority itself — is a contradiction rather than a hint.
    const stray = [['provider', '--provider'], ...ALL_COORDINATE_FLAGS].find(([key]) => Object.hasOwn(flags, key))
    if (stray) {
      throw new PeartubeUsageError(`Direct video mode does not accept ${stray[1]}`)
    }
    if (flags.yes) {
      validateScriptedSource(query, positionals.length)
      return result('add', query, fetchUrl, flags, 'scripted')
    }
    if (!interactive) {
      throw new PeartubeUsageError('Direct video mode requires --yes for non-interactive add')
    }
    return result('add', query, fetchUrl, flags, 'interactive')
  }

  if (mediaShape(flags.type)) {
    refuse(coordinateRefusal(flags.type, flags))

    const complete = coordinatesComplete(flags.type, flags)
    if (complete && flags.yes) {
      validateScriptedSource(query, positionals.length)
      return result('add', query, fetchUrl, flags, 'scripted')
    }
    if (complete && !interactive) {
      throw new PeartubeUsageError('Complete scripted coordinates require --yes')
    }
    // The picker browses TMDB alone. An authority it cannot ask must arrive
    // complete rather than be quietly resolved against the wrong catalogue.
    if (!interactive || (flags.provider && !isQueryable(flags.provider))) {
      throw new PeartubeUsageError(`${modeLabel(flags.type)} mode requires ${coordinateRequirement(flags.type)}`)
    }
    return result('add', query, fetchUrl, flags, 'interactive')
  }

  // A bare source URL is a complete add on its own: the relay classifies it,
  // and the direct path defaults it to a video. No --type/coordinates required.
  if (fetchUrl && (flags.yes || flags.relayUi)) {
    validateScriptedSource(query, positionals.length)
    return result('add', query, fetchUrl, flags, 'scripted')
  }

  if (!interactive) {
    throw new PeartubeUsageError('Non-interactive add requires --type and complete provider coordinates')
  }

  return result('add', query, fetchUrl, flags, 'interactive')
}

function rejectForeignFlags(flags, forbidden, command) {
  const found = forbidden.find(([key]) => Object.hasOwn(flags, key))
  if (found) {
    throw new PeartubeUsageError(`${found[1]} is only valid with ${command}`)
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PeartubeUsageError(`${name} must be a positive integer`)
  }
  return parsed
}

function parseSearch(flags, positionals) {
  rejectForeignFlags(flags, GET_ONLY_FLAGS, 'get')
  const query = positionals.join(' ').trim()
  if (!query) {
    throw new PeartubeUsageError('Search requires a query')
  }
  if (Object.hasOwn(flags, 'limit')) flags.limit = positiveInteger(flags.limit, '--limit')
  // Vocabulary belongs to the network command: an unknown genre is an honest
  // empty result, but a blank filter is a typo the caller should hear about.
  if (Object.hasOwn(flags, 'kind') && flags.kind.trim() === '') {
    throw new PeartubeUsageError('--kind requires a value')
  }
  if (Object.hasOwn(flags, 'genres') && flags.genres.some(genre => genre.trim() === '')) {
    throw new PeartubeUsageError('--genre requires a value')
  }
  return result('search', query, null, flags, 'scripted')
}

function parseGet(flags, positionals) {
  rejectForeignFlags(flags, SEARCH_ONLY_FLAGS, 'search')
  if (positionals.length === 0) {
    throw new PeartubeUsageError('Get requires one entity or publication id')
  }
  if (positionals.length > 1) {
    throw new PeartubeUsageError('Get accepts exactly one entity or publication id')
  }
  if (Object.hasOwn(flags, 'timeout')) flags.timeout = positiveInteger(flags.timeout, '--timeout')
  return result('get', positionals[0], null, flags, 'scripted')
}

export function parsePeartubeArgv(argv = [], options = {}) {
  if (!Array.isArray(argv)) {
    throw new PeartubeUsageError('Arguments must be an array')
  }

  const args = [...argv]
  if (args.length === 0) {
    return result('help', null, null, {}, 'scripted')
  }

  if (args[0] === '--help' || args[0] === '-h') {
    return result('help', null, null, { help: true }, 'scripted')
  }

  const command = args.shift()
  if (!COMMANDS.has(command)) {
    throw new PeartubeUsageError(`Unknown command "${command}"`)
  }
  if (command === 'help') {
    return result('help', null, null, {}, 'scripted')
  }

  const { flags, positionals, help = false } = parseFlagsAndPositionals(args)
  if (help) {
    return result('help', null, null, flags, 'scripted')
  }
  if (command === 'add') {
    return parseAdd(flags, positionals, options)
  }

  const addOnlyFlag = ADD_ONLY_FLAGS.find(([key]) => Object.hasOwn(flags, key))
  if (addOnlyFlag) {
    throw new PeartubeUsageError(`${addOnlyFlag[1]} is only valid with add`)
  }

  if (command === 'search') {
    return parseSearch(flags, positionals)
  }
  if (command === 'get') {
    return parseGet(flags, positionals)
  }

  rejectForeignFlags(flags, SEARCH_ONLY_FLAGS, 'search')
  rejectForeignFlags(flags, GET_ONLY_FLAGS, 'get')

  if (positionals.length > 0) {
    throw new PeartubeUsageError(`Unexpected argument ${positionals[0]}`)
  }

  return result('config', null, null, flags, 'interactive')
}
