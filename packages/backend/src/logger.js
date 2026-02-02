/**
 * Structured Logger with Redaction
 *
 * Provides leveled logging with automatic redaction of sensitive data.
 * Secrets like seed phrases, private keys, and full public keys are never logged.
 *
 * Usage:
 *   import { logger } from './logger.js'
 *   const log = logger('MyModule')
 *   log.info('Message', { key: someValue })
 *   log.debug('Detailed info', data)
 *   log.warn('Warning message')
 *   log.error('Error occurred', error)
 */

// Log levels in order of severity
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4
}

// Get configured log level from environment
function getLogLevel() {
  const envLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL) ||
                   (typeof globalThis !== 'undefined' && globalThis.__PEARTUBE_LOG_LEVEL__)
  if (envLevel && LOG_LEVELS[envLevel.toUpperCase()] !== undefined) {
    return LOG_LEVELS[envLevel.toUpperCase()]
  }
  // Default to INFO in production, DEBUG in development
  return LOG_LEVELS.INFO
}

let currentLevel = getLogLevel()

/**
 * Set the log level programmatically
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'|'SILENT'} level
 */
export function setLogLevel(level) {
  if (LOG_LEVELS[level] !== undefined) {
    currentLevel = LOG_LEVELS[level]
  }
}

// Patterns that indicate sensitive data
const SENSITIVE_PATTERNS = [
  /mnemonic/i,
  /seed/i,
  /secret/i,
  /private/i,
  /password/i,
  /passphrase/i,
  /token/i,
  /auth/i,
  /credential/i
]

// Keys that should always be redacted
const REDACTED_KEYS = new Set([
  'secretkey',
  'privatekey',
  'mnemonic',
  'seed',
  'seedphrase',
  'password',
  'passphrase',
  'secret',
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'encryptionkey'
])

/**
 * Check if a key name indicates sensitive data
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[_-]/g, '')
  if (REDACTED_KEYS.has(normalized)) return true
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(key))
}

/**
 * Truncate hex strings (likely keys) to first 16 chars
 * @param {string} value
 * @returns {string}
 */
function truncateHex(value) {
  if (typeof value !== 'string') return value
  // If it looks like a hex key (32+ chars, all hex)
  if (value.length >= 32 && /^[0-9a-f]+$/i.test(value)) {
    return value.slice(0, 16) + '...'
  }
  return value
}

/**
 * Recursively redact sensitive data from an object
 * @param {any} obj
 * @param {number} depth - Current recursion depth
 * @returns {any}
 */
function redact(obj, depth = 0) {
  // Prevent infinite recursion
  if (depth > 10) return '[max depth]'

  if (obj === null || obj === undefined) return obj

  // Handle Buffers
  if (Buffer.isBuffer(obj)) {
    if (obj.length > 32) {
      return `<Buffer ${obj.slice(0, 8).toString('hex')}... (${obj.length} bytes)>`
    }
    return `<Buffer ${obj.toString('hex')}>`
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => redact(item, depth + 1))
  }

  // Handle objects
  if (typeof obj === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        result[key] = '[REDACTED]'
      } else if (typeof value === 'string') {
        result[key] = truncateHex(value)
      } else {
        result[key] = redact(value, depth + 1)
      }
    }
    return result
  }

  // Handle strings
  if (typeof obj === 'string') {
    // Redact anything that looks like a mnemonic (12+ words)
    const words = obj.split(/\s+/)
    if (words.length >= 12 && words.every(w => /^[a-z]+$/i.test(w))) {
      return '[MNEMONIC REDACTED]'
    }
    return truncateHex(obj)
  }

  return obj
}

/**
 * Format log arguments into a string
 * @param {string} prefix - Module prefix
 * @param {string} level - Log level
 * @param {any[]} args - Arguments to format
 * @returns {string}
 */
function format(prefix, level, args) {
  const timestamp = new Date().toISOString()
  const parts = [`[${prefix}]`]

  for (const arg of args) {
    if (arg instanceof Error) {
      parts.push(arg.message)
      if (arg.stack && currentLevel === LOG_LEVELS.DEBUG) {
        parts.push('\n' + arg.stack)
      }
    } else if (typeof arg === 'object') {
      try {
        parts.push(JSON.stringify(redact(arg)))
      } catch {
        parts.push('[unserializable]')
      }
    } else if (typeof arg === 'string') {
      parts.push(redact(arg))
    } else {
      parts.push(String(arg))
    }
  }

  return parts.join(' ')
}

/**
 * Create a logger instance for a module
 * @param {string} moduleName - Name to prefix log messages with
 * @returns {Object} Logger instance with debug, info, warn, error methods
 */
export function logger(moduleName) {
  return {
    /**
     * Log debug message (only shown when LOG_LEVEL=DEBUG)
     * @param {...any} args
     */
    debug(...args) {
      if (currentLevel <= LOG_LEVELS.DEBUG) {
        console.debug(format(moduleName, 'DEBUG', args))
      }
    },

    /**
     * Log info message
     * @param {...any} args
     */
    info(...args) {
      if (currentLevel <= LOG_LEVELS.INFO) {
        console.log(format(moduleName, 'INFO', args))
      }
    },

    /**
     * Log warning message
     * @param {...any} args
     */
    warn(...args) {
      if (currentLevel <= LOG_LEVELS.WARN) {
        console.warn(format(moduleName, 'WARN', args))
      }
    },

    /**
     * Log error message
     * @param {...any} args
     */
    error(...args) {
      if (currentLevel <= LOG_LEVELS.ERROR) {
        console.error(format(moduleName, 'ERROR', args))
      }
    },

    /**
     * Create a child logger with a sub-prefix
     * @param {string} subName
     * @returns {Object}
     */
    child(subName) {
      return logger(`${moduleName}:${subName}`)
    }
  }
}

// Export constants for external use
export const LogLevel = LOG_LEVELS
