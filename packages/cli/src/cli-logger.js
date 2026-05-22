/**
 * Structured ndjson logger for peartube-peer CLI.
 * Outputs one JSON object per line to stdout/stderr.
 */
import process from '#process'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

let currentLevel = LEVELS.info

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeArg(value) {
  if (value instanceof Error) return value.message
  return value
}

function normalizeData(args) {
  if (args.length === 0) return {}

  const [data, ...rest] = args
  if (isPlainObject(data)) {
    if (rest.length === 0) return data
    return { ...data, args: rest.map(normalizeArg) }
  }

  return { args: args.map(normalizeArg) }
}

/**
 * @param {boolean|string} debugOrLevel
 */
export function setDebugLevel(debugOrLevel) {
  if (typeof debugOrLevel === 'string' && LEVELS[debugOrLevel]) {
    currentLevel = LEVELS[debugOrLevel]
    return
  }

  currentLevel = debugOrLevel ? LEVELS.debug : LEVELS.info
}

/**
 * @param {string} component
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function createLogger(component) {
  function log(level, msg, ...args) {
    if (LEVELS[level] < currentLevel) return
    const data = normalizeData(args)
    const entry = {
      level,
      time: Date.now(),
      component,
      msg,
      ...data
    }
    process.stdout.write(JSON.stringify(entry) + '\n')
  }

  return {
    debug: (msg, ...args) => log('debug', msg, ...args),
    info: (msg, ...args) => log('info', msg, ...args),
    warn: (msg, ...args) => log('warn', msg, ...args),
    error: (msg, ...args) => log('error', msg, ...args)
  }
}

/**
 * Create all component loggers for the CLI.
 * @param {boolean|string} debugOrLevel - Enable debug logging or set a level directly
 * @returns {{ relay: Logger, runtime: Logger, admission: Logger, status: Logger, mirror: Logger, peer: Logger, cache: Logger, feed: Logger, download: Logger, archive: Logger }}
 */
export function createCliLogger(debugOrLevel) {
  setDebugLevel(debugOrLevel)
  return {
    relay: createLogger('Relay'),
    runtime: createLogger('Runtime'),
    admission: createLogger('Admission'),
    status: createLogger('Status'),
    mirror: createLogger('Mirror'),
    peer: createLogger('Peer'),
    cache: createLogger('Cache'),
    feed: createLogger('Feed'),
    download: createLogger('Download'),
    archive: createLogger('Archive')
  }
}
