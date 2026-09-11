function looksLikePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /^[A-Za-z]:[\\/]/.test(value))
}

function looksLikeNodeExecutable(value) {
  return typeof value === 'string' && /(^|[/\\])node(?:\.exe)?$/i.test(value)
}

export function normalizeCliArgv(argv = []) {
  if (!Array.isArray(argv) || argv.length === 0) return []

  if (argv.length >= 2 && looksLikeNodeExecutable(argv[0]) && looksLikePath(argv[1])) {
    return argv.slice(2)
  }

  if (looksLikePath(argv[0])) {
    return argv.slice(1)
  }

  return [...argv]
}

function pushFlag(target, key, value) {
  if (target[key] === undefined) {
    target[key] = value
    return
  }

  if (Array.isArray(target[key])) {
    target[key].push(value)
    return
  }

  target[key] = [target[key], value]
}

function applyBooleanFlag(flags, arg) {
  if (arg === '--help' || arg === '-h') {
    flags.help = true
    return true
  }
  if (arg === '--debug' || arg === '-d') {
    flags.debug = true
    return true
  }
  if (arg === '--json') {
    flags.json = true
    return true
  }
  if (arg === '--run-now') {
    flags.runNow = true
    return true
  }
  if (arg === '--no-reseed') {
    flags.noReseed = true
    return true
  }
  return false
}

function applyStorageOrHostFlag(flags, arg, consumeValue) {
  if (arg === '--config' || arg === '-c') {
    flags.config = consumeValue()
    return true
  }
  if (arg === '--mode') {
    flags.mode = consumeValue()
    return true
  }
  if (arg === '--policy') {
    flags.policy = consumeValue()
    return true
  }
  if (arg === '--storage' || arg === '-s') {
    flags.storage = consumeValue()
    return true
  }
  if (arg === '--max-bytes') {
    flags.maxBytes = consumeValue()
    return true
  }
  if (arg === '--max-storage' || arg === '-m') {
    flags.maxStorage = consumeValue()
    return true
  }
  if (arg === '--min-free-bytes') {
    flags.minFreeBytes = consumeValue()
    return true
  }
  if (arg === '--host') {
    flags.host = consumeValue()
    return true
  }
  if (arg === '--port') {
    flags.port = consumeValue()
    return true
  }
  return false
}

function applyMetadataOrMirrorFlag(flags, arg, consumeValue) {
  if (arg === '--key') {
    flags.key = consumeValue()
    return true
  }
  if (arg === '--label') {
    flags.label = consumeValue()
    return true
  }
  if (arg === '--channel') {
    pushFlag(flags, 'channel', consumeValue())
    return true
  }
  if (arg === '--owner') {
    pushFlag(flags, 'owner', consumeValue())
    return true
  }
  if (arg === '--url') {
    flags.url = consumeValue()
    return true
  }
  if (arg === '--path') {
    flags.path = consumeValue()
    return true
  }
  if (arg === '--max-files') {
    flags.maxFiles = consumeValue()
    return true
  }
  if (arg === '--local-mirror-path') {
    flags.localMirrorPath = consumeValue()
    return true
  }
  if (arg === '--local-mirror-poll') {
    flags.localMirrorPoll = consumeValue()
    return true
  }
  if (arg === '--local-mirror-channel-name') {
    flags.localMirrorChannelName = consumeValue()
    return true
  }
  if (arg === '--channel-name') {
    flags.channelName = consumeValue()
    return true
  }
  if (arg === '--title') {
    flags.title = consumeValue()
    return true
  }
  if (arg === '--description') {
    flags.description = consumeValue()
    return true
  }
  return false
}

export function parseArgv(argv = []) {
  const args = [...argv]
  let command = 'run'

  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift()
  }

  const flags = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (applyBooleanFlag(flags, arg)) {
      continue
    }

    const consumeValue = () => {
      const next = args[i + 1]
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`)
      }
      i += 1
      return next
    }

    if (applyStorageOrHostFlag(flags, arg, consumeValue) || applyMetadataOrMirrorFlag(flags, arg, consumeValue)) {
      continue
    }

    throw new Error(`Unknown argument ${arg}`)
  }

  return { command, flags }
}
