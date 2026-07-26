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
import type {
  PearTubeRPC,
  PublisherPreparedRecord,
  PublisherProvisionResponse,
  PublisherSignedRecord,
  PublisherSubmitResponse,
} from '../shared/rpc-types'


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

type PublisherBackendRelay = {
  provisionPublisherCatalog(request: {
    publisherId: string
    genesisRootKey: Uint8Array
  }): Promise<Omit<PublisherProvisionResponse, 'catalogBootstrapKey' | 'localWriterKey' | 'localSignerKey'> & {
    catalogBootstrapKey: Uint8Array
    localWriterKey: Uint8Array
    localSignerKey: Uint8Array
  }>
  preparePublisherRootOperation(request: Omit<
    PublisherPreparedRecord,
    'success' | 'unsignedBytes' | 'candidateRecordId' | 'signerPublicKey' |
    'bodyLength' | 'expiresAt' | 'error'
  > & {
    signerPublicKey: Uint8Array
    displaySummaryJson: string
    expiresInMs: number
  }): Promise<Omit<PublisherPreparedRecord, 'unsignedBytes' | 'candidateRecordId' | 'signerPublicKey'> & {
    unsignedBytes: Uint8Array
    candidateRecordId: Uint8Array
    signerPublicKey: Uint8Array
  }>
  submitPublisherRootOperation(request: Omit<
    PublisherSignedRecord,
    'unsignedBytes' | 'candidateRecordId' | 'signer' | 'signerPublicKey' | 'signature' | 'allowedSigners'
  > & {
    unsignedBytes: Uint8Array
    candidateRecordId: Uint8Array
    signer: Uint8Array
    signerPublicKey: Uint8Array
    signature: Uint8Array
    allowedSigners?: Uint8Array[] | null
  }): Promise<Omit<
    PublisherSubmitResponse,
    'recordId' | 'transitionId' | 'signer' | 'signerPublicKey' | 'signature'
  > & {
    recordId: Uint8Array
    transitionId?: Uint8Array | null
    signer: Uint8Array
    signerPublicKey: Uint8Array
    signature: Uint8Array
  }>
}

let publisherBackendRelay: PublisherBackendRelay | null = null

// ── Electrobun RPC (minimal lifecycle plus public backend record relay) ──
const rpc = Electroview.defineRPC<PearTubeRPC>({
  handlers: {
    requests: {
      async publisherProvisionCatalog(request) {
        if (!publisherBackendRelay) throw new Error('Publisher backend relay unavailable')
        const response = await publisherBackendRelay.provisionPublisherCatalog({
          publisherId: request.publisherId,
          genesisRootKey: new Uint8Array(request.genesisRootKey),
        })
        return {
          ...response,
          catalogBootstrapKey: Array.from(response.catalogBootstrapKey),
          localWriterKey: Array.from(response.localWriterKey),
          localSignerKey: Array.from(response.localSignerKey),
        }
      },
      async publisherPrepareRootOperation(request) {
        if (!publisherBackendRelay) throw new Error('Publisher backend relay unavailable')
        const response = await publisherBackendRelay.preparePublisherRootOperation({
          ...request,
          body: new Uint8Array(request.body),
          signerPublicKey: new Uint8Array(request.signerPublicKey),
        })
        return {
          ...response,
          unsignedBytes: Array.from(response.unsignedBytes),
          candidateRecordId: Array.from(response.candidateRecordId),
          signerPublicKey: Array.from(response.signerPublicKey),
        }
      },
      async publisherSubmitRootOperation(request) {
        if (!publisherBackendRelay) throw new Error('Publisher backend relay unavailable')
        const response = await publisherBackendRelay.submitPublisherRootOperation({
          ...request,
          unsignedBytes: new Uint8Array(request.unsignedBytes),
          candidateRecordId: new Uint8Array(request.candidateRecordId),
          signer: new Uint8Array(request.signer),
          signerPublicKey: new Uint8Array(request.signerPublicKey),
          signature: new Uint8Array(request.signature),
          allowedSigners: request.allowedSigners?.map((key) => new Uint8Array(key)) ?? request.allowedSigners,
        })
        return {
          ...response,
          recordId: Array.from(response.recordId),
          transitionId: response.transitionId ? Array.from(response.transitionId) : response.transitionId,
          signer: Array.from(response.signer),
          signerPublicKey: Array.from(response.signerPublicKey),
          signature: Array.from(response.signature),
        }
      },
    },
    messages: {},
  },
})

const electrobun = new Electroview({ rpc })

// ── WebSocket IPC to Bun process ────────────────────────────────────────
// The Bun main process runs a WebSocket server that pipes binary data
// directly to/from the Bare worker. We connect to it and create a
// duplex-like interface that the HRPC client can use.

let ipcSocket: WebSocket | null = null
let ipcConnectPromise: Promise<boolean> | null = null
let ipcPortPromise: Promise<number> | null = null
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
// The Bun process exposes it through a same-origin endpoint.
async function discoverIpcPort(): Promise<number> {
  try {
    const resp = await fetch('/__peartube_ipc_port')
    if (resp.ok) {
      const { port } = await resp.json()
      const parsedPort = Number(port)
      if (Number.isInteger(parsedPort) && parsedPort > 0) {
        return parsedPort
      }
    }
  } catch {}

  // Fallback: scan ports near the static server
  const staticPort = parseInt(window.location.port, 10)
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

function getIpcPort(): Promise<number> {
  if (!ipcPortPromise) {
    ipcPortPromise = discoverIpcPort().catch((err) => {
      ipcPortPromise = null
      throw err
    })
  }
  return ipcPortPromise
}


// ── window.bridge ───────────────────────────────────────────────────────
const bridge = {
  pkg() {
    return { name: 'peartube', productName: 'PearTube', version: '0.1.115' }
  },

  applyUpdate: async () => {},
  appRestart: async () => { window.location.reload() },
  onPearEvent(_name: string, _listener: Function) { return () => {} },
  registerPublisherBackendRelay(relay: PublisherBackendRelay) {
    if (publisherBackendRelay) throw new Error('Publisher backend relay is already registered')
    if (!relay || typeof relay.provisionPublisherCatalog !== 'function' ||
        typeof relay.preparePublisherRootOperation !== 'function' ||
        typeof relay.submitPublisherRootOperation !== 'function') {
      throw new Error('Invalid publisher backend relay')
    }
    publisherBackendRelay = Object.freeze(relay)
  },
  async ensureLocalPublisher() {
    return rpc.proxy.request.publisherEnsureLocalCatalog({ action: 'ensure-local-publisher' })
  },
  async personalSecureGet(account: string): Promise<string | null> {
    const response = await rpc.proxy.request.personalSecureGet({ account })
    return response.value
  },
  async personalSecureSet(account: string, value: string): Promise<void> {
    await rpc.proxy.request.personalSecureSet({ account, value })
  },
  async personalSecureDelete(account: string): Promise<void> {
    await rpc.proxy.request.personalSecureDelete({ account })
  },

  async startWorker(specifier: string): Promise<boolean> {
    if (ipcSocket?.readyState === WebSocket.OPEN) return true
    if (ipcConnectPromise) return ipcConnectPromise

    // Connect the IPC WebSocket — the Bun process spawns the worker on connect
    ipcConnectPromise = (async () => {
      try {
        const port = await getIpcPort()
        console.log('[bridge] Connecting IPC WebSocket on port', port)

        return new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}`)
          ws.binaryType = 'arraybuffer'
          let settled = false
          let didOpen = false
          let timeout: ReturnType<typeof setTimeout> | null = null

          const settle = (ok: boolean) => {
            if (settled) return
            settled = true
            if (timeout) clearTimeout(timeout)
            resolve(ok)
          }

          ws.onopen = () => {
            console.log('[bridge] IPC WebSocket connected')
            didOpen = true
            ipcSocket = ws
            settle(true)
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
            if (ipcSocket === ws) ipcSocket = null
            if (didOpen) fireListeners(exitListeners, specifier, 0)
            settle(false)
          }

          ws.onerror = (err) => {
            console.error('[bridge] IPC WebSocket error:', err)
            settle(false)
          }

          timeout = setTimeout(() => {
            console.error('[bridge] IPC WebSocket connection timeout')
            try { ws.close() } catch {}
            settle(false)
          }, 10000)
        })
      } catch (e: any) {
        console.error('[bridge] startWorker failed:', e.message)
        return false
      } finally {
        ipcConnectPromise = null
      }
    })()

    return ipcConnectPromise
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

Object.defineProperty(window, 'bridge', {
  value: Object.freeze(bridge),
  enumerable: true,
  writable: false,
  configurable: false,
})
console.log('[bridge] Electrobun bridge ready')
