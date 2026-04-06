/**
 * PearTube Desktop — Electroview Bridge
 *
 * Sets up window.bridge with the same interface the Expo app expects
 * (matches electron/preload.js contract). Backed by Electrobun RPC
 * instead of Electron's contextBridge.
 *
 * Loaded as the view entrypoint — runs before the Expo bundle.
 */
import { Electroview } from 'electrobun/view'
import type { PearTubeRPC } from '../shared/rpc-types'

// ── Per-specifier listeners (mirrors Electron preload pattern) ──────────
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

// ── Electrobun RPC ──────────────────────────────────────────────────────
const rpc = Electroview.defineRPC<PearTubeRPC>({
  handlers: {
    requests: {},
    messages: {
      onWorkerIPC: ({ specifier, data }: { specifier: string; data: number[] }) => {
        fireListeners(ipcListeners, specifier, Buffer.from(data))
      },
      onWorkerStdout: ({ specifier, data }: { specifier: string; data: string }) => {
        fireListeners(stdoutListeners, specifier, Buffer.from(data))
      },
      onWorkerStderr: ({ specifier, data }: { specifier: string; data: string }) => {
        fireListeners(stderrListeners, specifier, Buffer.from(data))
      },
      onWorkerExit: ({ specifier, code }: { specifier: string; code: number }) => {
        fireListeners(exitListeners, specifier, code)
      },
    },
  },
})

const electrobun = new Electroview({ rpc })

// ── window.bridge (matches Electron preload.js contract) ────────────────
// rpc.web.ts checks for window.bridge?.startWorker to detect desktop mode.
// By implementing the same interface, the entire HRPC stack works unchanged.
const bridge = {
  pkg() {
    return { name: 'peartube', productName: 'PearTube', version: '0.1.0' }
  },

  applyUpdate: async () => { /* placeholder for OTA updates */ },
  appRestart: async () => { window.location.reload() },

  onPearEvent(_name: string, _listener: Function) {
    return () => {}
  },

  async startWorker(specifier: string): Promise<boolean> {
    const result = await electrobun.rpc.request.startWorker({ specifier })
    return result?.ok ?? false
  },

  writeWorkerIPC(specifier: string, data: any): Promise<boolean> {
    const arr = data instanceof Uint8Array
      ? Array.from(data)
      : data instanceof ArrayBuffer
        ? Array.from(new Uint8Array(data))
        : Array.isArray(data)
          ? data
          : Array.from(new Uint8Array(
              typeof data === 'string' ? new TextEncoder().encode(data) : data
            ))
    electrobun.rpc.send.workerWrite({ specifier, data: arr })
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
