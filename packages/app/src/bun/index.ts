/**
 * PearTube Desktop — Bun Main Process (Electrobun)
 *
 * Spawns the P2P backend as a Bare worker via PearRuntime.run().
 * Relays raw IPC between the Bare worker and the renderer webview.
 * The renderer runs the HRPC protocol client — Bun doesn't interpret messages.
 */
import Electrobun, { BrowserWindow, BrowserView } from 'electrobun/bun'
import PearRuntime from 'pear-runtime'
import type { PearTubeRPC } from '../shared/rpc-types'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_NAME = 'PearTube'

let mainWindow: any = null
let rendererReady = false
let blobServerPort: number | null = null
let workerWsPort: number = 0  // Direct WebSocket port from the Bare worker

// ── Worker State ────────────────────────────────────────────────────────
const workers = new Map<string, any>()
const workerPids = new Set<number>()

// ── Storage ─────────────────────────────────────────────────────────────
function getStoragePath(): string {
  // Use ~/.peartube for compatibility with existing Electron/pear-run data
  return join(homedir(), '.peartube')
}

// ── Worker Management ───────────────────────────────────────────────────
// Electrobun puts bundled bun code at Resources/app/bun/index.js
// and copy entries at Resources/app/ — go up one dir from import.meta.url
const appCodeDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const storagePath = getStoragePath()

function getWorker(specifier: string) {
  if (workers.has(specifier)) return workers.get(specifier)

  // Resolve worker path relative to app code directory
  // specifier is like '/pear/build/workers/core/index.js' or '/workers/core/index.js'
  let workerPath = join(appCodeDir, specifier.replace(/^\//, ''))
  if (!existsSync(workerPath)) {
    // Try without the pear/ prefix (Electrobun copies to workers/ directly)
    const stripped = specifier.replace(/^\/pear\/build\//, '/')
    workerPath = join(appCodeDir, stripped.replace(/^\//, ''))
  }
  // Try .mjs extension (bare-build output)
  if (!existsSync(workerPath)) {
    workerPath = workerPath.replace(/\.js$/, '.mjs')
  }

  console.log('[main] Spawning Bare worker:', workerPath, 'storage:', storagePath)
  const worker = PearRuntime.run(workerPath, [storagePath])

  // Track PID for force-kill on crash
  const pid = worker._process?.pid
  if (pid) workerPids.add(pid)

  worker.stdout.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) {
      console.log('[worker]', text)
      // Detect blob server port from worker output
      const portMatch = text.match(/blobServerPort:\s*(\d+)/)
      if (portMatch) blobServerPort = parseInt(portMatch[1], 10)
      // Detect direct WebSocket port from worker output
      const wsMatch = text.match(/PEARTUBE_WS_PORT=(\d+)/)
      if (wsMatch) workerWsPort = parseInt(wsMatch[1], 10)
    }
  })

  worker.stderr.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) console.error('[worker:err]', text)
  })

  worker.once('exit', (code: number) => {
    console.log('[main] Worker exited:', specifier, 'code:', code)
    if (pid) workerPids.delete(pid)
    workers.delete(specifier)
    // Close WebSocket to signal the renderer
    if (activeWs) { try { activeWs.close() } catch {} }
  })

  worker.on('error', (e: Error) => {
    console.error('[main] Worker error:', e.message)
  })

  workers.set(specifier, worker)
  return worker
}

function destroyAllWorkers() {
  for (const [specifier, worker] of workers) {
    console.log('[main] Destroying worker:', specifier)
    try { worker.destroy() } catch {}
  }
  workers.clear()
  // Force-kill any lingering bare processes after 2s
  if (workerPids.size > 0) {
    const pidsToKill = new Set(workerPids)
    setTimeout(() => {
      for (const pid of pidsToKill) {
        if (workerPids.has(pid)) {
          console.log('[main] Force-killing worker PID:', pid)
          try { process.kill(pid, 'SIGKILL') } catch {}
          workerPids.delete(pid)
        }
      }
    }, 2000)
  }
}

// ── Worker spawning ─────────────────────────────────────────────────────
// The Bare worker runs its own WebSocket server. The browser connects
// directly to the worker — no data flows through Bun. Bun just spawns
// the worker and reads the WS port from stdout.
const BACKEND_WORKER = '/pear/build/workers/core/index.js'
let ipcWsPort = 0  // fallback, unused with direct WS

async function spawnWorkerAndGetPort(): Promise<number> {
  const worker = getWorker(BACKEND_WORKER)

  // Wait for the worker to print its WebSocket port
  return new Promise<number>((resolve) => {
    const onData = (d: Buffer) => {
      const text = d.toString()
      const match = text.match(/PEARTUBE_WS_PORT=(\d+)/)
      if (match) {
        worker.stdout.removeListener('data', onData)
        resolve(parseInt(match[1], 10))
      }
    }
    worker.stdout.on('data', onData)
    // Timeout: fall back to 0 (renderer will fail gracefully)
    setTimeout(() => { worker.stdout.removeListener('data', onData); resolve(0) }, 15000)
  })
}

// ── Electrobun RPC (minimal — just for view lifecycle) ──────────────────
const appRPC = BrowserView.defineRPC<PearTubeRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      startWorker: async () => {
        // Worker is started when WebSocket connects — just return the WS port
        return { ok: true }
      },
      viewReady: async () => {
        rendererReady = true
        return { blobServerPort }
      },
    },
    messages: {
      workerWrite: () => {
        // No longer used — binary data goes through WebSocket
      },
    },
  },
})

// ── Static File Server ──────────────────────────────────────────────────
// Expo Router reads window.location.pathname to determine the route.
// views://app/index.html gives pathname "/app/index.html" which doesn't match.
// A local HTTP server gives a clean "/" pathname that Expo Router expects.
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
}

let staticPort = 0

async function startStaticServer() {
  const viewsDir = join(appCodeDir, 'views', 'app')
  const server = Bun.serve({
    port: 0, // auto-assign
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)

      // IPC port discovery — returns the worker's direct WebSocket port
      // Waits up to 15s for the worker to start its WS server
      if (url.pathname === '/__peartube_ipc_port') {
        let port = workerWsPort
        if (!port) {
          // Worker hasn't printed its WS port yet — poll until it does
          for (let i = 0; i < 150 && !workerWsPort; i++) {
            await new Promise(r => setTimeout(r, 100))
          }
          port = workerWsPort
        }
        return new Response(JSON.stringify({ port }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      let filePath = join(viewsDir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))

      const file = Bun.file(filePath)
      if (!file.size) {
        // SPA fallback: serve index.html for navigation routes
        const ext = filePath.split('.').pop() || ''
        if (!ext || ext === 'html') {
          return new Response(Bun.file(join(viewsDir, 'index.html')), {
            headers: { 'Content-Type': 'text/html' },
          })
        }
        return new Response('Not found', { status: 404 })
      }

      const ext = '.' + (filePath.split('.').pop() || '')
      return new Response(file, {
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
      })
    },
  })

  staticPort = server.port
  console.log('[main] Static server on http://127.0.0.1:' + staticPort)
  return staticPort
}

// ── Create Window ───────────────────────────────────────────────────────
async function createWindow() {
  await startStaticServer()
  // Spawn the worker — it starts its own WebSocket server
  // The renderer will discover the port via /__peartube_ipc_port
  workerWsPort = await spawnWorkerAndGetPort()
  console.log('[main] Worker direct WS port:', workerWsPort)

  mainWindow = new BrowserWindow({
    title: APP_NAME,
    url: `http://127.0.0.1:${staticPort}`,
    frame: { width: 1280, height: 800 },
    titleBarStyle: 'hiddenInset',
    renderer: 'native',
    rpc: appRPC,
  })

  mainWindow.on('close', () => {
    destroyAllWorkers()
    mainWindow = null
    rendererReady = false
  })
}

createWindow()

Electrobun.events.on('reopen', () => {
  if (!mainWindow) createWindow()
})

// ── Cleanup ─────────────────────────────────────────────────────────────
process.on('SIGTERM', () => { destroyAllWorkers(); process.exit(0) })
process.on('SIGINT', () => { destroyAllWorkers(); process.exit(0) })
process.on('exit', () => {
  for (const pid of workerPids) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
})
