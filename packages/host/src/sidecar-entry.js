import { startHost } from './start-host.js'

function createEmitter() {
  const listeners = new Map()

  function add(event, listener) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
    return () => listeners.get(event)?.delete(listener)
  }

  function emit(event, value) {
    const eventListeners = listeners.get(event)
    if (!eventListeners) return
    for (const listener of eventListeners) listener(value)
  }

  return { add, emit }
}

function createProcessTransport() {
  const emitter = createEmitter()
  const input = globalThis.Bare?.stdin ?? process.stdin
  const output = globalThis.Bare?.stdout ?? process.stdout

  input?.on?.('data', (chunk) => emitter.emit('data', chunk))
  input?.on?.('end', () => emitter.emit('close'))
  input?.on?.('close', () => emitter.emit('close'))
  input?.on?.('error', (error) => emitter.emit('error', error))

  return {
    on(event, listener) {
      return emitter.add(event, listener)
    },
    once(event, listener) {
      const remove = emitter.add(event, (value) => {
        remove()
        listener(value)
      })
      return remove
    },
    write(chunk) {
      return output?.write?.(chunk)
    },
    destroy(error) {
      if (error) emitter.emit('error', error)
      emitter.emit('close')
    }
  }
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
  const [storagePath = '', ...args] = argv
  await runHostSidecar({ storagePath, args })
}
