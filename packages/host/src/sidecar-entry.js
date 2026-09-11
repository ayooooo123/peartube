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

function resolveDefaultInputStream() {
  return globalThis.Bare?.stdin ?? process.stdin
}

function resolveDefaultOutputStream() {
  return globalThis.Bare?.stdout ?? process.stdout
}

function attachTransportListeners(input, output, handlers) {
  input?.on?.('data', handlers.onData)
  input?.on?.('end', handlers.onEnd)
  input?.on?.('close', handlers.onClose)
  input?.on?.('error', handlers.onError)
  output?.on?.('drain', handlers.onDrain)
  output?.on?.('close', handlers.onClose)
  output?.on?.('error', handlers.onError)
}

function detachTransportListeners(input, output, handlers) {
  input?.removeListener?.('data', handlers.onData)
  input?.removeListener?.('end', handlers.onEnd)
  input?.removeListener?.('close', handlers.onClose)
  input?.removeListener?.('error', handlers.onError)
  output?.removeListener?.('drain', handlers.onDrain)
  output?.removeListener?.('close', handlers.onClose)
  output?.removeListener?.('error', handlers.onError)
}

export function createProcessTransport({
  input = resolveDefaultInputStream(),
  output = resolveDefaultOutputStream(),
} = {}) {
  const emitter = createEmitter()
  let closed = false
  const onData = chunk => emitter.emit('data', chunk)
  const onDrain = () => emitter.emit('drain')
  const onError = error => emitter.emit('error', error)
  const onEnd = () => {
    if (closed) return
    try {
      emitter.emit('end')
    } finally {
      onClose()
    }
  }
  const onClose = () => {
    if (closed) return
    closed = true
    detachTransportListeners(input, output, handlers)
    emitter.emit('close')
  }
  const handlers = { onData, onDrain, onError, onEnd, onClose }
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
      try {
        if (!closed && error) emitter.emit('error', error)
      } finally {
        onClose()
        input?.destroy?.()
        if (output !== input) output?.destroy?.()
      }
      return transport
    }
  }

  attachTransportListeners(input, output, handlers)
  return transport
}

export async function runHostSidecar({ platform = 'desktop', storagePath, entrypoint = 'sidecar-entry', args = [], network, swarmOptions } = {}) {
  const stream = createProcessTransport()

  return startHost({
    platform,
    storagePath,
    entrypoint,
    args,
    stream,
    network,
    swarmOptions
  })
}

function parseLaunchOptions(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.__peartubeLaunchOptions !== true && !parsed.network && !parsed.swarmOptions) return null
    return {
      network: parsed.network,
      swarmOptions: parsed.swarmOptions
    }
  } catch {
    return null
  }
}

export function parseSidecarArgv(argv = []) {
  const [storagePath = '', entrypoint = 'sidecar-entry', ...rawArgs] = argv
  const launchOptions = parseLaunchOptions(rawArgs[0])
  const args = launchOptions ? rawArgs.slice(1) : rawArgs
  return {
    storagePath,
    entrypoint,
    args,
    network: launchOptions?.network,
    swarmOptions: launchOptions?.swarmOptions
  }
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
