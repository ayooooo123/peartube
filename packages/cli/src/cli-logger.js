/**
 * Structured ndjson logger for peartube-peer CLI.
 * Outputs one JSON object per line to stdout/stderr.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

let currentLevel = LEVELS.info

/**
 * @param {boolean} debug
 */
export function setDebugLevel(debug) {
  currentLevel = debug ? LEVELS.debug : LEVELS.info
}

/**
 * @param {string} component
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function createLogger(component) {
  function log(level, msg, data = {}) {
    if (LEVELS[level] < currentLevel) return
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
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data)
  }
}

/**
 * Create all component loggers for the CLI.
 * @param {boolean} debug - Enable debug-level logging
 * @returns {{ peer: Logger, cache: Logger, feed: Logger, download: Logger }}
 */
export function createCliLogger(debug) {
  setDebugLevel(debug)
  return {
    peer: createLogger('Peer'),
    cache: createLogger('Cache'),
    feed: createLogger('Feed'),
    download: createLogger('Download')
  }
}
