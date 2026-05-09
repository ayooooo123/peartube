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

export function parseArgv(argv = []) {
  const args = [...argv]
  let command = 'run'

  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift()
  }

  const flags = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }

    if (arg === '--debug' || arg === '-d') {
      flags.debug = true
      continue
    }

    if (arg === '--json') {
      flags.json = true
      continue
    }

    if (arg === '--run-now') {
      flags.runNow = true
      continue
    }

    const next = args[i + 1]
    const consumeValue = () => {
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`)
      }
      i += 1
      return next
    }

    if (arg === '--config' || arg === '-c') {
      flags.config = consumeValue()
      continue
    }

    if (arg === '--mode') {
      flags.mode = consumeValue()
      continue
    }

    if (arg === '--policy') {
      flags.policy = consumeValue()
      continue
    }

    if (arg === '--storage' || arg === '-s') {
      flags.storage = consumeValue()
      continue
    }

    if (arg === '--max-bytes') {
      flags.maxBytes = consumeValue()
      continue
    }

    if (arg === '--max-storage' || arg === '-m') {
      flags.maxStorage = consumeValue()
      continue
    }

    if (arg === '--channel') {
      pushFlag(flags, 'channel', consumeValue())
      continue
    }

    if (arg === '--owner') {
      pushFlag(flags, 'owner', consumeValue())
      continue
    }

    if (arg === '--url') {
      flags.url = consumeValue()
      continue
    }

    if (arg === '--path') {
      flags.path = consumeValue()
      continue
    }

    if (arg === '--max-files') {
      flags.maxFiles = consumeValue()
      continue
    }

    if (arg === '--local-mirror-path') {
      flags.localMirrorPath = consumeValue()
      continue
    }

    if (arg === '--local-mirror-poll') {
      flags.localMirrorPoll = consumeValue()
      continue
    }

    if (arg === '--local-mirror-channel-name') {
      flags.localMirrorChannelName = consumeValue()
      continue
    }

    if (arg === '--channel-name') {
      flags.channelName = consumeValue()
      continue
    }

    if (arg === '--title') {
      flags.title = consumeValue()
      continue
    }

    if (arg === '--description') {
      flags.description = consumeValue()
      continue
    }

    if (arg === '--host') {
      flags.host = consumeValue()
      continue
    }

    if (arg === '--port') {
      flags.port = consumeValue()
      continue
    }

    throw new Error(`Unknown argument ${arg}`)
  }

  return { command, flags }
}
