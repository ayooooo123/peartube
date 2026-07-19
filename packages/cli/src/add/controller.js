import nodeFs from 'node:fs/promises'
import nodePath from 'node:path'
import { homedir as osHomedir } from 'node:os'

const DEFAULT_CLOCK = {
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: (id) => clearTimeout(id)
}

export class PathUsageError extends Error {
  constructor (message, { code, exitCode = 2, cause } = {}) {
    super(message)
    this.name = 'PathUsageError'
    this.code = code
    this.exitCode = exitCode
    if (cause !== undefined) this.cause = cause
  }
}

export function createPickerController ({
  dispatch,
  search,
  clock = DEFAULT_CLOCK,
  debounceMs = 0,
  initialRequestId = 0
} = {}) {
  if (typeof dispatch !== 'function') throw new TypeError('dispatch is required')
  if (typeof search !== 'function') throw new TypeError('search is required')

  let counter = Number.isSafeInteger(initialRequestId) ? initialRequestId : 0
  let activeId = null
  let timer = null
  let controller = null
  let cleaned = false

  function clearTimer () {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  function abortActive () {
    if (controller) {
      controller.abort()
      controller = null
    }
  }

  function request (query) {
    if (cleaned) return null
    clearTimer()
    abortActive()
    const id = ++counter
    activeId = id
    dispatch({ type: 'results.request', requestId: id })
    timer = clock.setTimeout(() => {
      timer = null
      const ac = new AbortController()
      controller = ac
      Promise.resolve(search(query, { requestId: id, signal: ac.signal }))
        .then((items) => {
          if (cleaned || id !== activeId) return
          dispatch({ type: 'results.replace', requestId: id, items })
        })
        .catch((error) => {
          if (cleaned || id !== activeId) return
          dispatch({ type: 'results.error', requestId: id, error: normalizeError(error) })
        })
    }, debounceMs)
    return id
  }

  function cleanup () {
    cleaned = true
    clearTimer()
    abortActive()
  }

  return { request, cleanup }
}

export async function listPathCandidates (input, options = {}) {
  const path = options.path || nodePath
  const filesystem = options.filesystem || nodeFs
  const homedir = options.homedir || osHomedir
  const cwd = options.cwd || process.cwd()

  const quotes = detectQuotes(input)
  const inner = input.slice(quotes.start, input.length - quotes.end)
  const separator = path.sep
  const lastSep = inner.lastIndexOf(separator)
  const parentInner = lastSep >= 0 ? inner.slice(0, lastSep) : ''
  const prefix = lastSep >= 0 ? inner.slice(lastSep + 1) : inner
  const baseDisplay = lastSep >= 0 ? inner.slice(0, lastSep + 1) : ''
  const directory = path.resolve(cwd, expandTilde(parentInner || '.', homedir, path))

  const entries = await filesystem.readdir(directory, { withFileTypes: true })
  const leading = quotes.leading
  const trailing = quotes.trailing
  return entries
    .filter((entry) => entry.name.startsWith(prefix))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => {
      const isDir = entry.isDirectory()
      const suffix = isDir ? separator : ''
      return {
        name: entry.name,
        directory: isDir,
        completion: `${leading}${baseDisplay}${entry.name}${suffix}${trailing}`
      }
    })
}

export function completePath (input, candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return input
  const common = commonPrefix(candidates.map((candidate) => candidate.completion))
  if (common.length > input.length) return common
  const index = Number.isInteger(options.index) ? options.index : 0
  const candidate = candidates[index] || candidates[0]
  return candidate.completion
}

export async function confirmPath (input, options = {}) {
  const path = options.path || nodePath
  const filesystem = options.filesystem || nodeFs
  const homedir = options.homedir || osHomedir
  const cwd = options.cwd || process.cwd()

  const quotes = detectQuotes(input)
  const inner = input.slice(quotes.start, input.length - quotes.end)
  const expanded = expandTilde(inner, homedir, path)
  const normalized = path.normalize(expanded)
  const target = path.resolve(cwd, normalized)

  try {
    await filesystem.access(target)
  } catch (cause) {
    throw new PathUsageError(`Cannot read ${input}`, {
      code: 'ERR_PEARTUBE_PATH_UNREADABLE',
      exitCode: 2,
      cause
    })
  }
  return normalized
}

function detectQuotes (input) {
  const leading = input.startsWith('"') ? '"' : ''
  const trailing = input.length > leading.length && input.endsWith('"') ? '"' : ''
  return {
    leading,
    trailing,
    start: leading ? 1 : 0,
    end: trailing ? 1 : 0
  }
}

function expandTilde (value, homedir, path) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return homedir() + value.slice(1)
  }
  return value
}

function commonPrefix (values) {
  if (values.length === 0) return ''
  let prefix = values[0]
  for (const value of values.slice(1)) {
    let length = 0
    while (length < prefix.length && length < value.length && prefix[length] === value[length]) {
      length += 1
    }
    prefix = prefix.slice(0, length)
    if (prefix === '') break
  }
  return prefix
}

function normalizeError (error) {
  const out = { message: error && error.message != null ? String(error.message) : String(error) }
  if (error && error.code != null) out.code = error.code
  return out
}
