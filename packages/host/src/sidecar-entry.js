import { startHost } from './start-host.js'

function createEmitter() {
  const listeners = new Map()

  function add(event, listener) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
  }

  function remove(event, listener) {
    listeners.get(event)?.delete(listener)
  }

  function emit(event, value) {
    const eventListeners = listeners.get(event)
    if (!eventListeners) return
    for (const listener of eventListeners) listener(value)
  }

  return { add, remove, emit }
}

export function createProcessTransport() {
  const emitter = createEmitter()
  const input = globalThis.Bare?.stdin ?? process.stdin
  const output = globalThis.Bare?.stdout ?? process.stdout

  const transport = {
    on(event, listener) {
      emitter.add(event, listener)
      return transport
    },
    once(event, listener) {
      const wrapped = (value) => {
        emitter.remove(event, wrapped)
        listener(value)
      }
      emitter.add(event, wrapped)
      return transport
    },
    off(event, listener) {
      emitter.remove(event, listener)
      return transport
    },
    removeListener(event, listener) {
      emitter.remove(event, listener)
      return transport
    },
    write(chunk) {
      return output?.write?.(chunk)
    },
    end(chunk) {
      if (chunk !== undefined) output?.write?.(chunk)
      output?.end?.()
      return transport
    },
    destroy(error) {
      if (error) emitter.emit('error', error)
      input?.destroy?.(error)
      output?.destroy?.(error)
      emitter.emit('close')
      return transport
    }
  }

  input?.on?.('data', (chunk) => emitter.emit('data', chunk))
  input?.on?.('end', () => emitter.emit('end'))
  input?.on?.('end', () => emitter.emit('close'))
  input?.on?.('close', () => emitter.emit('close'))
  input?.on?.('error', (error) => emitter.emit('error', error))
  output?.on?.('drain', () => emitter.emit('drain'))
  output?.on?.('close', () => emitter.emit('close'))
  output?.on?.('error', (error) => emitter.emit('error', error))

  return transport
}

export async function runHostSidecar({ platform = 'desktop', storagePath, entrypoint = 'sidecar-entry', args = [] } = {}) {
  const stream = createProcessTransport()

  return startHost({
    platform,
    storagePath,
    entrypoint,
    args,
    stream
  })
}

export function parseSidecarArgv(argv = []) {
  const [storagePath = '', entrypoint = 'sidecar-entry', ...args] = argv
  return { storagePath, entrypoint, args }
}

function isDirectRun() {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false

  try {
    return import.meta.url === new URL(process.argv[1], 'file://').href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  const argv = globalThis.Bare?.argv ?? process.argv.slice(2)
  await runHostSidecar(parseSidecarArgv(argv))
}
