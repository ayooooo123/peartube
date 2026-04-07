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

// ── Worker State ────────────────────────────────────────────────────────
const workers = new Map<string, any>()
const workerPids = new Set<number>()

// ── Storage ─────────────────────────────────────────────────────────────
function getStoragePath(): string {
  const p = platform()
  const base = p === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : p === 'win32'
      ? join(homedir(), 'AppData', 'Local')
      : join(homedir(), '.config')
  return join(base, 'peartube')
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
      sendToRenderer('onWorkerStdout', { specifier, data: text })

      // Detect blob server port from worker output
      const portMatch = text.match(/blobServerPort:\s*(\d+)/)
      if (portMatch) blobServerPort = parseInt(portMatch[1], 10)
    }
  })

  worker.stderr.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) {
      console.error('[worker:err]', text)
      sendToRenderer('onWorkerStderr', { specifier, data: text })
    }
  })

  worker.on('data', (d: Buffer) => {
    sendToRenderer('onWorkerIPC', { specifier, data: Array.from(d) })
  })

  worker.once('exit', (code: number) => {
    console.log('[main] Worker exited:', specifier, 'code:', code)
    if (pid) workerPids.delete(pid)
    sendToRenderer('onWorkerExit', { specifier, code: code ?? 0 })
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

// ── Electrobun RPC ──────────────────────────────────────────────────────
const appRPC = BrowserView.defineRPC<PearTubeRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      startWorker: async ({ specifier }) => {
        try {
          getWorker(specifier)
          return { ok: true }
        } catch (e: any) {
          console.error('[main] startWorker failed:', e.message)
          return { ok: false }
        }
      },
      viewReady: async () => {
        rendererReady = true
        console.log('[main] Renderer ready, blobServerPort:', blobServerPort)
        return { blobServerPort }
      },
    },
    messages: {
      workerWrite: ({ specifier, data }) => {
        const worker = workers.get(specifier)
        if (worker) {
          worker.write(Buffer.from(data))
        }
      },
    },
  },
})

// ── Send to Renderer ────────────────────────────────────────────────────
function sendToRenderer(method: string, data: any) {
  if (!mainWindow || !rendererReady) return
  const view = mainWindow.webview
  if (view?.rpc?.send?.[method]) {
    view.rpc.send[method](data)
  }
}

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
