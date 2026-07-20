const COMMANDS = new Set(['add', 'config', 'help'])

const VALUE_FLAGS = new Map([
  ['--storage', 'storage'],
  ['--config', 'config'],
  ['--type', 'type'],
  ['--provider', 'provider'],
  ['--show-id', 'showId'],
  ['--season', 'season'],
  ['--episode', 'episode'],
  ['--movie-id', 'movieId'],
  ['--title', 'title'],
  ['--channel-name', 'channelName']
])

const BOOLEAN_FLAGS = new Map([
  ['--no-color', 'noColor'],
  ['--json', 'json'],
  ['--no-input', 'noInput'],
  ['--yes', 'yes'],
  ['--force', 'force']
])

const REPEATABLE_FLAGS = new Map([
  ['--relay', 'relay'],
  ['--blind-peer', 'blindPeer']
])

const EPISODE_COORDINATES = ['showId', 'season', 'episode']
const ADD_ONLY_FLAGS = [
  ['type', '--type'],
  ['provider', '--provider'],
  ['showId', '--show-id'],
  ['season', '--season'],
  ['episode', '--episode'],
  ['movieId', '--movie-id']
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

function validateProvider(flags) {
  if (flags.provider && flags.provider !== 'tmdb') {
    throw new PeartubeUsageError(`Provider "${flags.provider}" is unavailable; only "tmdb" is supported`)
  }
}

function validateCoordinateFamily(flags) {
  const hasEpisodeCoordinate = EPISODE_COORDINATES.some(key => Object.hasOwn(flags, key))
  const hasMovieCoordinate = Object.hasOwn(flags, 'movieId')

  if (hasEpisodeCoordinate && hasMovieCoordinate && flags.type === undefined) {
    throw new PeartubeUsageError('Cannot combine movie and episode coordinates')
  }
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

  validateProvider(flags)
  validateCoordinateFamily(flags)

  if (flags.type && flags.type !== 'episode' && flags.type !== 'movie' && flags.type !== 'video') {
    throw new PeartubeUsageError(`Unsupported content type "${flags.type}"; expected "episode", "movie", or "video"`)
  }

  if (flags.type === 'video') {
    if (Object.hasOwn(flags, 'movieId') || EPISODE_COORDINATES.some(key => Object.hasOwn(flags, key))) {
      throw new PeartubeUsageError('Direct video mode does not accept TMDB coordinates')
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

  if (flags.type === 'episode') {
    if (Object.hasOwn(flags, 'movieId')) {
      throw new PeartubeUsageError('Episode mode does not accept --movie-id')
    }

    const complete = flags.provider === 'tmdb' && EPISODE_COORDINATES.every(key => Object.hasOwn(flags, key))
    if (complete && flags.yes) {
      validateScriptedSource(query, positionals.length)
      return result('add', query, fetchUrl, flags, 'scripted')
    }
    if (complete && !interactive) {
      throw new PeartubeUsageError('Complete scripted coordinates require --yes')
    }
    if (!interactive) {
      throw new PeartubeUsageError('Episode mode requires --provider tmdb, --show-id, --season, and --episode')
    }
    return result('add', query, fetchUrl, flags, 'interactive')
  }

  if (flags.type === 'movie') {
    if (EPISODE_COORDINATES.some(key => Object.hasOwn(flags, key))) {
      throw new PeartubeUsageError('Movie mode does not accept --show-id, --season, or --episode')
    }

    const complete = flags.provider === 'tmdb' && Object.hasOwn(flags, 'movieId')
    if (complete && flags.yes) {
      validateScriptedSource(query, positionals.length)
      return result('add', query, fetchUrl, flags, 'scripted')
    }
    if (complete && !interactive) {
      throw new PeartubeUsageError('Complete scripted coordinates require --yes')
    }
    if (!interactive) {
      throw new PeartubeUsageError('Movie mode requires --provider tmdb and --movie-id')
    }
    return result('add', query, fetchUrl, flags, 'interactive')
  }

  if (!interactive) {
    throw new PeartubeUsageError('Non-interactive add requires --type and complete provider coordinates')
  }

  return result('add', query, fetchUrl, flags, 'interactive')
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

  if (positionals.length > 0) {
    throw new PeartubeUsageError(`Unexpected argument ${positionals[0]}`)
  }

  return result('config', null, null, flags, 'interactive')
}
