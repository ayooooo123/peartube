/**
 * PearTube Desktop — Electroview Bridge
 *
 * Sets up window.bridge backed by a raw WebSocket to the Bun main process.
 * Binary HRPC frames flow untouched over the WebSocket — no JSON serialization.
 * The Bun process pipes them directly to/from the Bare worker IPC stream.
 *
 * Loaded as the Electrobun view entrypoint — runs before the Expo bundle.
 */
import { Electroview } from 'electrobun/view'
import { Buffer } from 'buffer'

// ── Node.js polyfills for CEF ───────────────────────────────────────────
// The Expo bundle includes P2P code that references Node builtins.
// Electrobun's CEF renderer doesn't provide Node integration.
// Buffer must be the real `buffer` package (not a minimal shim) because
// bare-rpc / b4a call Buffer.byteLength, Buffer.concat, Buffer.alloc etc.
;(globalThis as any).Buffer = Buffer
if (typeof (globalThis as any).process === 'undefined') {
  ;(globalThis as any).process = { env: {}, nextTick: (fn: Function) => Promise.resolve().then(() => fn()), browser: true }
}
if (typeof (globalThis as any).global === 'undefined') {
  ;(globalThis as any).global = globalThis
}

// ── Electrobun RPC (minimal — just for lifecycle) ───────────────────────
const rpc = Electroview.defineRPC({
  handlers: {
    requests: {},
    messages: {},
  },
})

const electrobun = new Electroview({ rpc })

// ── WebSocket IPC to Bun process ────────────────────────────────────────
// The Bun main process runs a WebSocket server that pipes binary data
// directly to/from the Bare worker. We connect to it and create a
// duplex-like interface that the HRPC client can use.

let ipcSocket: WebSocket | null = null
const ipcListeners = new Map<string, Set<Function>>()
const stdoutListeners = new Map<string, Set<Function>>()
const stderrListeners = new Map<string, Set<Function>>()
const exitListeners = new Map<string, Set<Function>>()

function addListener(map: Map<string, Set<Function>>, key: string, fn: Function) {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key)!.add(fn)
  return () => { map.get(key)?.delete(fn) }
}

function fireListeners(map: Map<string, Set<Function>>, key: string, data: any) {
  const fns = map.get(key)
  if (fns) for (const fn of fns) { try { fn(data) } catch {} }
}

// Discover the IPC WebSocket port from the static server
// The Bun process injects it as a meta tag or we detect it from the URL
async function discoverIpcPort(): Promise<number> {
  // The static server and IPC WS server run on different ports.
  // Convention: IPC port = static port + 1 (set in Bun main process)
  // OR: read from a well-known endpoint
  try {
    const resp = await fetch('/__peartube_ipc_port')
    if (resp.ok) {
      const { port } = await resp.json()
      return port
    }
  } catch {}

  // Fallback: scan ports near the static server
  const staticPort = parseInt(window.location.port, 10)
  // Try the convention: IPC WS port is communicated via the static server
  for (let offset = 1; offset <= 10; offset++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${staticPort + offset}`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => { ws.close(); resolve() }
        ws.onerror = () => reject()
        setTimeout(reject, 200)
      })
      return staticPort + offset
    } catch {}
  }
  throw new Error('Could not discover IPC WebSocket port')
}

// ── window.bridge ───────────────────────────────────────────────────────
const bridge = {
  pkg() {
    return { name: 'peartube', productName: 'PearTube', version: '0.1.0' }
  },

  applyUpdate: async () => {},
  appRestart: async () => { window.location.reload() },
  onPearEvent(_name: string, _listener: Function) { return () => {} },

  async startWorker(specifier: string): Promise<boolean> {
    // Connect the IPC WebSocket — the Bun process spawns the worker on connect
    try {
      const port = await discoverIpcPort()
      console.log('[bridge] Connecting IPC WebSocket on port', port)

      return new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.binaryType = 'arraybuffer'

        ws.onopen = () => {
          console.log('[bridge] IPC WebSocket connected')
          ipcSocket = ws
          resolve(true)
        }

        ws.onmessage = (event) => {
          // Binary HRPC data from worker
          const data = event.data instanceof ArrayBuffer
            ? Buffer.from(event.data)
            : event.data
          fireListeners(ipcListeners, specifier, data)
        }

        ws.onclose = () => {
          console.log('[bridge] IPC WebSocket closed')
          ipcSocket = null
          fireListeners(exitListeners, specifier, 0)
        }

        ws.onerror = (err) => {
          console.error('[bridge] IPC WebSocket error:', err)
          resolve(false)
        }

        // Timeout
        setTimeout(() => {
          if (!ipcSocket) {
            console.error('[bridge] IPC WebSocket connection timeout')
            resolve(false)
          }
        }, 10000)
      })
    } catch (e: any) {
      console.error('[bridge] startWorker failed:', e.message)
      return false
    }
  },

  writeWorkerIPC(_specifier: string, data: any): Promise<boolean> {
    if (!ipcSocket || ipcSocket.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    // Send binary data directly — no JSON serialization
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      ipcSocket.send(data)
    } else if (data instanceof Buffer) {
      ipcSocket.send(data)
    } else {
      // Fallback for other types
      ipcSocket.send(new Uint8Array(data))
    }
    return Promise.resolve(true)
  },

  onWorkerIPC(specifier: string, listener: Function) {
    return addListener(ipcListeners, specifier, listener)
  },

  onWorkerStdout(specifier: string, listener: Function) {
    return addListener(stdoutListeners, specifier, listener)
  },

  onWorkerStderr(specifier: string, listener: Function) {
    return addListener(stderrListeners, specifier, listener)
  },

  onWorkerExit(specifier: string, listener: Function) {
    return addListener(exitListeners, specifier, listener)
  },
}

;(window as any).bridge = bridge
console.log('[bridge] Electrobun bridge ready')
