import bareProcess from 'bare-process'
import * as bridgeRPC from './native-rpc.mjs'

function formatError(error) {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.stack || error.message

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function createEmitter() {
  const listeners = new Map()

  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return this
    },
    once(event, listener) {
      const wrapped = (value) => {
        this.off(event, wrapped)
        listener(value)
      }
      return this.on(event, wrapped)
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
      return this
    },
    removeListener(event, listener) {
      return this.off(event, listener)
    },
    emit(event, value) {
      const eventListeners = listeners.get(event)
      if (!eventListeners) return false
      for (const listener of eventListeners) listener(value)
      return eventListeners.size > 0
    },
  }
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  if (typeof chunk === 'string') return Buffer.from(chunk)
  return Buffer.from(String(chunk ?? ''))
}

function writeIPCFrame(frame) {
  if (!globalThis?.BareKit?.IPC?.write) {
    throw new Error('BareKit IPC is unavailable in the native worklet')
  }

  return BareKit.IPC.write(toBuffer(frame))
}

function emitBridgeEvent(command, payload) {
  writeIPCFrame(
    bridgeRPC.encodeEventFrame({
      command,
      data: bridgeRPC.encodePayload(
        command === bridgeRPC.BRIDGE_EVENTS.hostReady
          ? bridgeRPC.hostReadyEventCodec
          : command === bridgeRPC.BRIDGE_EVENTS.hostError
            ? bridgeRPC.hostErrorEventCodec
            : command === bridgeRPC.BRIDGE_EVENTS.workletReady
              ? bridgeRPC.workletReadyEventCodec
              : bridgeRPC.hostLogEventCodec,
        payload
      ),
    })
  )
}

function reportFatalToHost(label, error) {
  const message = `${label}: ${formatError(error)}`

  try {
    emitBridgeEvent(bridgeRPC.BRIDGE_EVENTS.hostError, { message })
  } catch {}

  try {
    stderr.write(`${message}\n`)
  } catch {}
}

const stdin = createEmitter()
let stderrBuffer = ''
let hostRuntimeBootPromise = null
let hostRuntimeReady = false
const pendingInputChunks = []

const stdout = {
  write(chunk) {
    writeIPCFrame(chunk)
    return true
  },
}

const stderr = {
  write(chunk) {
    stderrBuffer += toBuffer(chunk).toString('utf8')

    while (true) {
      const newlineIndex = stderrBuffer.indexOf('\n')
      if (newlineIndex === -1) break

      const line = stderrBuffer.slice(0, newlineIndex).trim()
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1)

      if (!line) continue

      try {
        emitBridgeEvent(bridgeRPC.BRIDGE_EVENTS.hostLog, { message: line })
      } catch {}
    }

    return true
  },
}

globalThis.process = {
  ...bareProcess,
  env: bareProcess?.env || {},
  stdin,
  stdout,
  stderr,
}

if (globalThis.process?.env) {
  globalThis.process.env.PEARTUBE_NATIVE_EMBEDDED_BAREKIT = '1'
}

if (!globalThis?.BareKit?.IPC || typeof BareKit.IPC.on !== 'function') {
  throw new Error('BareKit IPC is unavailable in the native host worklet')
}

if (typeof Bare !== 'undefined' && Bare?.on) {
  Bare.on('unhandledRejection', (reason) => {
    reportFatalToHost('Embedded worklet unhandled rejection', reason)
    return true
  })

  Bare.on('uncaughtException', (error) => {
    reportFatalToHost('Embedded worklet uncaught exception', error)
    return true
  })
}

function flushPendingInput() {
  while (pendingInputChunks.length > 0) {
    stdin.emit('data', pendingInputChunks.shift())
  }
}

async function ensureHostRuntimeBooted() {
  if (hostRuntimeReady) {
    flushPendingInput()
    return hostRuntimeBootPromise
  }

  if (hostRuntimeBootPromise) return hostRuntimeBootPromise

  hostRuntimeBootPromise = (async () => {
    await import('./native-host-sidecar.mjs')

    hostRuntimeReady = true
    try {
      emitBridgeEvent(bridgeRPC.BRIDGE_EVENTS.hostLog, {
        message: 'Embedded BareKit worklet finished loading the native host runtime.',
      })
    } catch {}
    try {
      emitBridgeEvent(bridgeRPC.BRIDGE_EVENTS.workletReady, {
        stage: 'host-module-ready',
      })
    } catch {}
    flushPendingInput()
  })().catch((error) => {
    hostRuntimeBootPromise = null
    throw error
  })

  return hostRuntimeBootPromise
}

BareKit.IPC.on('data', (chunk) => {
  const payload = toBuffer(chunk)

  if (hostRuntimeReady) {
    stdin.emit('data', payload)
    return
  }

  pendingInputChunks.push(payload)
  if (pendingInputChunks.length == 1) {
    try {
      emitBridgeEvent(bridgeRPC.BRIDGE_EVENTS.hostLog, {
        message: 'Embedded BareKit worklet received the first IPC frame and is loading the native host runtime.',
      })
    } catch {}
  }

  void ensureHostRuntimeBooted().catch((error) => {
    reportFatalToHost('Native worklet bootstrap failed', error)
  })
})

if (typeof BareKit.IPC.once === 'function') {
  BareKit.IPC.once('close', () => {
    stdin.emit('end')
  })
}
