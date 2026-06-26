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
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_NAME = 'PearTube'

// ── Kill stale workers holding the Corestore lock ───────────────────────
// If a previous session crashed or was force-killed, the bare-sidecar
// may still hold the fd lock. Find and kill it on startup.
function killStaleLocks() {
  const corestorePath = join(homedir(), '.peartube', 'CORESTORE')
  if (!existsSync(corestorePath)) return
  try {
    const pids = execSync(`lsof -t "${corestorePath}" 2>/dev/null`, { encoding: 'utf-8' }).trim()
    if (!pids) return
    for (const pidStr of pids.split('\n')) {
      const pid = parseInt(pidStr, 10)
      if (!pid || pid === process.pid) continue
      console.log('[main] Killing stale worker holding Corestore lock: PID', pid)
      try { process.kill(pid, 'SIGKILL') } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}
killStaleLocks()

let mainWindow: any = null
let rendererReady = false
let blobServerPort: number | null = null

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
  // Prefer the self-contained bare bundle when present. `desktop:bundle`
  // bare-packs the worker (+ @peartube/backend source) into a single
  // `.bundle` that `bare` loads natively, so we run one frozen artifact
  // instead of resolving raw source from the copied node_modules tree (which
  // could be stale — see the "does not provide an export named X" failure).
  const bundlePath = workerPath.replace(/\.(js|mjs)$/, '.bundle')
  if (existsSync(bundlePath)) {
    workerPath = bundlePath
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
    try { worker.destroy() } catch { /* best effort */ }
  }
  workers.clear()
  // Force-kill any lingering bare processes after 2s
  if (workerPids.size > 0) {
    const pidsToKill = new Set(workerPids)
    setTimeout(() => {
      for (const pid of pidsToKill) {
        if (workerPids.has(pid)) {
          console.log('[main] Force-killing worker PID:', pid)
          try { process.kill(pid, 'SIGKILL') } catch { /* best effort */ }
          workerPids.delete(pid)
        }
      }
    }, 2000)
  }
}

// ── IPC WebSocket Relay ─────────────────────────────────────────────────
// Binary pipe between renderer and worker. Bun relays WebSocket frames
// to/from the Bare worker's IPC stream. No JSON serialization.
const BACKEND_WORKER = '/pear/build/workers/core/index.js'
let ipcWsPort = 0
let ipcWsServer: any = null

function removeWorkerDataListener(worker: any, listener: (d: Buffer) => void) {
  if (!worker || !listener) return
  if (typeof worker.off === 'function') {
    worker.off('data', listener)
    return
  }
  if (typeof worker.removeListener === 'function') {
    worker.removeListener('data', listener)
  }
}

function startIPCWebSocket() {
  if (ipcWsServer) return ipcWsPort

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      if (server.upgrade(req)) return
      return new Response('WebSocket only', { status: 426 })
    },
    websocket: {
      open(ws) {
        console.log('[main] IPC WebSocket connected')
        let worker: any = null
        try {
          worker = getWorker(BACKEND_WORKER)
        } catch (err: any) {
          console.error('[main] IPC WebSocket worker startup failed:', err?.message || err)
          try { ws.close(1011, 'worker startup failed') } catch { /* best effort */ }
          return
        }

        // Pipe: worker IPC → WebSocket → renderer
        const forwardWorkerData = (d: Buffer) => {
          if (ws.readyState === 1) ws.sendBinary(d)
        }
        ;(ws as any).data = { worker, forwardWorkerData }
        worker.on('data', forwardWorkerData)
      },
      message(ws, message) {
        // Pipe: renderer → WebSocket → worker IPC
        const worker = workers.get(BACKEND_WORKER)
        if (worker) {
          const buf = message instanceof ArrayBuffer
            ? Buffer.from(message)
            : Buffer.from(message as Uint8Array)
          worker.write(buf)
        }
      },
      close(ws) {
        const data = (ws as any).data || {}
        const worker = data.worker || workers.get(BACKEND_WORKER)
        const forwardWorkerData = data.forwardWorkerData
        if (worker && forwardWorkerData) {
          removeWorkerDataListener(worker, forwardWorkerData)
        }
        console.log('[main] IPC WebSocket closed')
      },
    },
  })

  ipcWsServer = server
  ipcWsPort = server.port ?? 0
  console.log('[main] IPC WebSocket on ws://127.0.0.1:' + ipcWsPort)
  return ipcWsPort
}

function stopIPCWebSocket() {
  if (!ipcWsServer) return
  try { ipcWsServer.stop?.(true) } catch { /* best effort */ }
  ipcWsServer = null
  ipcWsPort = 0
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
let staticServer: any = null

async function startStaticServer() {
  if (staticServer) return staticPort

  const viewsDir = join(appCodeDir, 'views', 'app')
  const server = Bun.serve({
    port: 0, // auto-assign
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)

      // IPC port discovery
      if (url.pathname === '/__peartube_ipc_port') {
        return new Response(JSON.stringify({ port: ipcWsPort }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      let filePath = join(viewsDir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))

      const file = Bun.file(filePath)
      if (!file.size) {
        // SPA fallback: serve index.html for navigation routes
        const ext = filePath.split('.').pop() || ''
        if (!ext || ext === 'html') {
          filePath = join(viewsDir, 'index.html')
        } else {
          return new Response('Not found', { status: 404 })
        }
      }

      const ext = '.' + (filePath.split('.').pop() || '')

      // Inject Electrobun view script into HTML at serve time.
      // This replaces the build-time inject-desktop-shell.js script — no
      // post-processing of files on disk, no fragile regex replacements.
      if (ext === '.html') {
        let html = await Bun.file(filePath).text()
        // Inject view entrypoint before the Expo bundle so window.bridge is ready
        if (!html.includes('views://app/index.js')) {
          html = html.replace(
            /(<script[^>]*src="[^"]*_expo\/static\/js\/web\/[^"]*"[^>]*><\/script>)/,
            '<script src="views://app/index.js"></script>\n$1'
          )
        }
        return new Response(html, { headers: { 'Content-Type': 'text/html' } })
      }

      return new Response(Bun.file(filePath), {
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
      })
    },
  })

  staticServer = server
  staticPort = server.port ?? 0
  console.log('[main] Static server on http://127.0.0.1:' + staticPort)
  return staticPort
}

function stopStaticServer() {
  if (!staticServer) return
  try { staticServer.stop?.(true) } catch { /* best effort */ }
  staticServer = null
  staticPort = 0
}

// ── Create Window ───────────────────────────────────────────────────────
async function createWindow() {
  await startStaticServer()
  startIPCWebSocket()

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
    stopIPCWebSocket()
    stopStaticServer()
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
    try { process.kill(pid, 'SIGKILL') } catch { /* best effort */ }
  }
})
