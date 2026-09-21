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
import { join, dirname, basename, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { existsSync, realpathSync } from 'fs'
import { execSync, spawn } from 'child_process'
import { createPublisherSignerBridge } from '../../lib/publisher-signer-bridge'
import { createBunPublisherKeyVault } from './publisher-key-vault'
import { createBunPersonalSecretVault } from './personal-secret-vault'
import {
  IPC_CAPABILITY_PARAM,
  createIpcChannelHandlers,
  mintIpcCapability,
  type IpcClient,
} from './ipc-channel'
import { createStaticFileHandler } from './static-files'
import {
  createPublisherShellService,
  createDesktopPublisherLifecycleHandlers,
} from '../../lib/publisher-shell-service'
// The DESKTOP Pear drive. The mobile worklet swarms a different link —
// packages/app/package.json `upgrade` — because the two drives carry different
// distributables: the iOS/Android payload versus this desktop app bundle. The
// two must never be swapped; staging a desktop build onto the mobile link would
// offer phones a macOS .app. Imported rather than read from disk at runtime so
// the link is inlined into the Bun bundle and cannot go missing from a packaged
// app's Resources.
import desktopPear from '../../desktop.pear.json'
import {
  version as APP_VERSION,
  productName as APP_PRODUCT_NAME,
  name as APP_PACKAGE_NAME,
} from '../../package.json'


const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_NAME = 'PearTube'


// This accessor exists only in the Bun main bundle. It is deliberately absent
// from BrowserView RPC, the web renderer bundle, and the Bare backend worker.
export function getPrivilegedPublisherSignerBridge() {
  return privilegedPublisherSignerBridge
}

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

// ── Pear OTA (desktop) ──────────────────────────────────────────────────
const DESKTOP_UPGRADE_LINK = desktopPear.upgrade
// Worker stdout is the control channel back from the updater: the worker's
// Bare.IPC pipe carries binary HRPC frames and must stay untouched.
const PEAR_CONTROL_PREFIX = '[pear-update] '
const PEAR_COMMAND_TIMEOUT_MS = 60000

// pear-runtime-updater only looks for payloads when it knows the bundle it is
// replacing (`bundled` is derived from `app`), and it swaps the staged
// `/by-arch/<host>/app/<name>` onto exactly that path. Electrobun's own
// updater locates the running bundle the same way: the executable lives at
// <Name>.app/Contents/MacOS/<bin> on macOS and at <bundle>/bin/<bin>
// elsewhere. The layout assertions stop an unpackaged `bun src/bun/index.ts`
// run from claiming a parent of the developer's home directory as the bundle.
function resolveAppBundlePath(): string | null {
  const execDir = dirname(process.execPath)
  if (platform() === 'darwin') {
    const bundle = resolve(execDir, '..', '..')
    if (!bundle.endsWith('.app')) return null
    if (!existsSync(join(bundle, 'Contents', 'MacOS'))) return null
    return appCodeDir.startsWith(bundle + sep) ? bundle : null
  }
  const bundle = resolve(execDir, '..')
  if (!existsSync(join(bundle, 'bin'))) return null
  return appCodeDir.startsWith(bundle + sep) ? bundle : null
}

const appBundlePath = resolveAppBundlePath()

// Handed to the Bare worker in one argv slot. The updater itself runs over
// there because that process owns the Corestore and the Hyperswarm the update
// drive replicates over.
const pearWorkerConfig = JSON.stringify({
  upgrade: DESKTOP_UPGRADE_LINK,
  app: appBundlePath,
  // The updater mirrors `/by-arch/<host>/app/<name>` and its Windows branch
  // switches on `.exe`/`.msix`, so `name` is the distributable's filename
  // (`PearTube.app`), not the bare product name.
  name: appBundlePath ? basename(appBundlePath) : APP_PRODUCT_NAME,
  version: APP_VERSION,
})

type PearPkg = {
  name: string
  productName: string
  version: string
  upgrade: string | null
  updatesEnabled: boolean
  updatesError: string | null
}

const pearPkg: PearPkg = {
  name: APP_PACKAGE_NAME,
  productName: APP_PRODUCT_NAME,
  version: APP_VERSION,
  upgrade: DESKTOP_UPGRADE_LINK,
  // Replaced by the worker's first state frame; until then the only thing we
  // know for certain is whether a swappable bundle exists at all.
  updatesEnabled: false,
  updatesError: appBundlePath ? null : 'unpackaged build: OTA updates are disabled',
}
const publisherKeyVault = createBunPublisherKeyVault()
const personalSecretVault = createBunPersonalSecretVault()
const privilegedPublisherSignerBridge = createPublisherSignerBridge({
  runtime: 'desktop-main',
  vault: publisherKeyVault,
})
const publisherShellService = createPublisherShellService({
  shell: publisherKeyVault,
  signer: privilegedPublisherSignerBridge,
  async confirmRootOperation(summary) {
    const response = await Electrobun.Utils.showMessageBox({
      type: 'question',
      title: 'Confirm publisher setup',
      message: summary.action === 'create-publisher-namespace'
        ? 'Create the local publisher namespace?'
        : 'Admit this device to publish uploads?',
      detail: `${JSON.stringify(summary)}\n\nOnly continue if you initiated this exact publisher setup step.`,
      buttons: ['Confirm publisher operation', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    return response.response === 0
  },
  publisherRpc: {
    async provisionPublisherCatalog(request) {
      if (!mainWindow) throw new Error('Publisher renderer relay unavailable')
      const response = await mainWindow.webview.rpc.proxy.request.publisherProvisionCatalog({
        publisherId: request.publisherId,
        genesisRootKey: Array.from(request.genesisRootKey),
      })
      return {
        ...response,
        catalogBootstrapKey: new Uint8Array(response.catalogBootstrapKey),
        localWriterKey: new Uint8Array(response.localWriterKey),
        localSignerKey: new Uint8Array(response.localSignerKey),
      }
    },
    async preparePublisherRootOperation(request) {
      if (!mainWindow) throw new Error('Publisher renderer relay unavailable')
      const response = await mainWindow.webview.rpc.proxy.request.publisherPrepareRootOperation({
        ...request,
        body: Array.from(request.body),
        signerPublicKey: Array.from(request.signerPublicKey),
      })
      return {
        ...response,
        unsignedBytes: new Uint8Array(response.unsignedBytes),
        candidateRecordId: new Uint8Array(response.candidateRecordId),
        signerPublicKey: new Uint8Array(response.signerPublicKey),
      }
    },
    async submitPublisherRootOperation(request) {
      if (!mainWindow) throw new Error('Publisher renderer relay unavailable')
      const response = await mainWindow.webview.rpc.proxy.request.publisherSubmitRootOperation({
        ...request,
        unsignedBytes: Array.from(request.unsignedBytes),
        candidateRecordId: Array.from(request.candidateRecordId),
        signer: Array.from(request.signer),
        signerPublicKey: Array.from(request.signerPublicKey),
        signature: Array.from(request.signature),
        allowedSigners: request.allowedSigners?.map((key) => Array.from(key)) ?? request.allowedSigners,
      })
      return {
        ...response,
        recordId: new Uint8Array(response.recordId),
        transitionId: response.transitionId ? new Uint8Array(response.transitionId) : response.transitionId,
        signer: new Uint8Array(response.signer),
        signerPublicKey: new Uint8Array(response.signerPublicKey),
        signature: new Uint8Array(response.signature),
      }
    },
  },
})

const desktopPublisherLifecycleHandlers = createDesktopPublisherLifecycleHandlers({
  publisherShell: publisherShellService,
})

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

  const peerAddresses = globalThis.Bun.env.PEARTUBE_NETWORK_PEER_ADDRESSES || ''
  console.log('[main] Spawning Bare worker:', workerPath, 'storage:', storagePath)
  const worker = PearRuntime.run(workerPath, [storagePath, peerAddresses, pearWorkerConfig])

  // Track PID for force-kill on crash
  const pid = worker._process?.pid
  if (pid) workerPids.add(pid)

  // Line-buffered: update frames are newline-delimited JSON and a chunk
  // boundary must not split one.
  let stdoutPending = ''
  worker.stdout.on('data', (d: Buffer) => {
    stdoutPending += d.toString()
    const lines = stdoutPending.split('\n')
    stdoutPending = lines.pop() || ''
    for (const line of lines) handleWorkerStdoutLine(line)
  })

  worker.stderr.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) console.error('[worker:err]', text)
  })

  worker.once('exit', (code: number) => {
    if (stdoutPending) { handleWorkerStdoutLine(stdoutPending); stdoutPending = '' }
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
// One socket, two frame types. Binary frames are the raw pipe between the
// renderer and the Bare worker's IPC stream — no JSON, no interpretation.
// Text frames are this process talking to the view about Pear updates; the
// WebSocket frame type keeps them from ever being mistaken for HRPC bytes.
//
// The socket is the renderer's whole authority over the backend and over the
// app bundle on disk, and a loopback listener is reachable by every page the
// user has open and every process on the machine. Authorization lives in
// ./ipc-channel: a launch capability is required before the upgrade, and a
// request that carries an Origin must also come from this shell's own server.
const BACKEND_WORKER = '/pear/build/workers/core/index.js'
let ipcWsPort = 0
let ipcWsServer: { port?: number; stop?(closeActiveConnections?: boolean): void } | null = null
const ipcClients = new Set<IpcClient>()

// Minted once per launch, held only in this process's memory: never logged,
// never persisted, and never served over the loopback HTTP surface. The view
// receives it in the URL the shell navigates the window to.
const ipcCapability = mintIpcCapability()

function startIPCWebSocket() {
  if (ipcWsServer) return ipcWsPort

  const handlers = createIpcChannelHandlers({
    capability: ipcCapability,
    // Read per request: the static server's port is ephemeral and is only
    // known once it is listening.
    allowedOrigins: () => (staticPort ? ['http://127.0.0.1:' + staticPort] : []),
    clients: ipcClients,
    greeting: () => JSON.stringify({ t: 'pear:state', pkg: pearPkg }),
    startWorker: () => getWorker(BACKEND_WORKER),
    runningWorker: () => workers.get(BACKEND_WORKER),
    onControlFrame: (ws, raw) => { void handleViewControlFrame(ws, raw) },
  })

  const server = globalThis.Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    ...handlers,
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

// ── Pear update bridge (worker ⇄ view) ──────────────────────────────────
// Worker → launcher rides the worker's stdout as `[pear-update] {json}`
// lines; launcher → worker rides the worker's stdin as `{json}` lines. Both
// are stdio of the child process pear-runtime already spawned, so no second
// channel is opened and fd 3 stays reserved for HRPC.
let pearRequestId = 0
const pearRequests = new Map<number, { resolve(): void; reject(err: Error): void }>()

function broadcastToView(frame: Record<string, unknown>) {
  const payload = JSON.stringify(frame)
  for (const client of ipcClients) {
    if (client.readyState !== 1) continue
    try { client.send(payload) } catch { /* client went away mid-broadcast */ }
  }
}

function handleWorkerStdoutLine(line: string) {
  const text = line.trimEnd()
  if (!text) return
  if (text.startsWith(PEAR_CONTROL_PREFIX)) {
    handlePearWorkerFrame(text.slice(PEAR_CONTROL_PREFIX.length))
    return
  }
  console.log('[worker]', text)
  // Detect blob server port from worker output
  const portMatch = text.match(/blobServerPort:\s*(\d+)/)
  if (portMatch) blobServerPort = parseInt(portMatch[1], 10)
}

function handlePearWorkerFrame(raw: string) {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { console.error('[main] Bad pear frame:', raw); return }
  if (parsed === null || typeof parsed !== 'object') return
  const frame = parsed as Record<string, unknown>

  if (frame.t === 'state') {
    pearPkg.updatesEnabled = frame.enabled === true
    pearPkg.updatesError = typeof frame.error === 'string' ? frame.error : null
    if (typeof frame.upgrade === 'string') pearPkg.upgrade = frame.upgrade
    console.log('[main] Pear updates enabled:', pearPkg.updatesEnabled, pearPkg.updatesError || '')
    broadcastToView({ t: 'pear:state', pkg: pearPkg })
    return
  }

  if (frame.t === 'event') {
    broadcastToView({
      t: 'pear:event',
      event: { state: frame.state, version: frame.version ?? null, minver: frame.minver ?? null },
    })
    return
  }

  if (frame.t === 'ack') {
    if (typeof frame.id !== 'number') return
    const pending = pearRequests.get(frame.id)
    if (!pending) return
    pearRequests.delete(frame.id)
    if (frame.ok === true) pending.resolve()
    else pending.reject(new Error(typeof frame.error === 'string' ? frame.error : 'pear command failed'))
  }
}

function requestWorkerApply(): Promise<void> {
  const worker = workers.get(BACKEND_WORKER)
  const stdin = worker?.stdin
  if (!stdin || typeof stdin.write !== 'function') {
    return Promise.reject(new Error('backend worker is not running'))
  }
  const id = ++pearRequestId
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pearRequests.delete(id)
      rejectPromise(new Error('pear apply timed out'))
    }, PEAR_COMMAND_TIMEOUT_MS)
    pearRequests.set(id, {
      resolve() { clearTimeout(timer); resolvePromise() },
      reject(err: Error) { clearTimeout(timer); rejectPromise(err) },
    })
    try {
      stdin.write(JSON.stringify({ t: 'apply', id }) + '\n')
    } catch (err) {
      clearTimeout(timer)
      pearRequests.delete(id)
      rejectPromise(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// `applyUpdate()` only swaps the payload on disk — the running code is still
// the old build — so the swap is worthless without a relaunch of the bundle.
function restartApp() {
  if (!appBundlePath) {
    throw new Error('restart requires a packaged app bundle; relaunch manually')
  }
  if (platform() === 'darwin') {
    // `open -n` starts a second instance of the bundle that just got swapped
    // rather than re-execing this process's (now replaced) binary.
    spawn('open', ['-n', appBundlePath], { detached: true, stdio: 'ignore' }).unref()
  } else {
    // Electrobun's non-macOS layout puts the entrypoint at <bundle>/bin/launcher.
    const launcher = join(appBundlePath, 'bin', 'launcher')
    if (!existsSync(launcher)) {
      throw new Error(`cannot relaunch: no launcher at ${launcher}`)
    }
    spawn(launcher, [], { detached: true, stdio: 'ignore' }).unref()
  }
  // Let the ack reach the view, then quit through Electrobun so the
  // before-quit teardown runs and the Bare worker releases its Corestore lock.
  setTimeout(() => Electrobun.Utils.quit(), 250)
}

async function handleViewControlFrame(ws: IpcClient, raw: string) {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return }
  if (parsed === null || typeof parsed !== 'object') return
  const frame = parsed as Record<string, unknown>
  const id = typeof frame.id === 'number' ? frame.id : null

  const reply = (ok: boolean, error?: string) => {
    if (ws.readyState !== 1) return
    try { ws.send(JSON.stringify({ t: 'pear:ack', id, ok, error: error ?? null })) } catch { /* client gone */ }
  }

  try {
    if (frame.t === 'pear:state') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pear:state', pkg: pearPkg }))
      return
    }
    if (frame.t === 'pear:apply') {
      await requestWorkerApply()
      reply(true)
      return
    }
    if (frame.t === 'pear:restart') {
      restartApp()
      reply(true)
    }
  } catch (err) {
    reply(false, err instanceof Error ? err.message : String(err))
  }
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
      publisherEnsureLocalCatalog: async (request) =>
        desktopPublisherLifecycleHandlers.publisherEnsureLocalCatalog(request),
      personalSecureGet: async ({ account }) => ({
        value: await personalSecretVault.get(account),
      }),
      personalSecureSet: async ({ account, value }) => {
        await personalSecretVault.set(account, value)
        return { success: true }
      },
      personalSecureDelete: async ({ account }) => {
        await personalSecretVault.delete(account)
        return { success: true }
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
//
// The request path (decode, containment, SPA fallback, MIME, HTML injection)
// lives in ./static-files so it can be tested without Bun globals.
let staticPort = 0
let staticServer: { port?: number; stop?(closeActiveConnections?: boolean): void } | null = null

async function startStaticServer() {
  if (staticServer) return staticPort

  // Canonicalised once here, never per request: every containment check
  // compares against this exact string. realpath needs the directory to
  // exist, which it does in a packaged app; `resolve` keeps a dev tree with a
  // missing export usable (every request then 404s, as before).
  const viewsPath = join(appCodeDir, 'views', 'app')
  let viewsDir: string
  try {
    viewsDir = realpathSync(viewsPath)
  } catch {
    viewsDir = resolve(viewsPath)
  }

  const fetchStatic = createStaticFileHandler({
    viewsDir,
    openFile: (filePath) => {
      const file = globalThis.Bun.file(filePath)
      return { size: file.size, text: () => file.text(), body: file }
    },
    ipcPort: () => ipcWsPort,
  })

  const server = globalThis.Bun.serve({
    port: 0, // auto-assign
    hostname: '127.0.0.1',
    fetch: fetchStatic,
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

  // The bootstrap URL is the capability's only delivery path. It is handed to
  // the webview natively — it never crosses the loopback HTTP surface as a
  // response body, so a local process that probes the static server cannot
  // read it, and no other page can read this window's location. The view
  // strips the parameter from the address the moment it reads it.
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    url: `http://127.0.0.1:${staticPort}/?${IPC_CAPABILITY_PARAM}=${ipcCapability}`,
    frame: { x: 0, y: 0, width: 1280, height: 800 },
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
// The Bare worker is a separate OS process (pear-runtime's `run()` spawns
// `bare` with an IPC pipe on fd 3) and it holds an exclusive flock() on the
// Corestore for as long as it lives. A leaked worker makes the next launch
// hang forever inside store.ready(), so every exit path has to destroy the
// pipe — destroying it kills the child, which lets the worker's own SIGTERM
// handler close the store and release the lock.
//
// `before-quit` is the load-bearing one: Electrobun's Utils.quit() ends in a
// native forceExit(), so Cmd-Q / app-menu Quit never reaches
// `process.on('exit')` and, on macOS, never closes the window either.
Electrobun.events.on('before-quit', () => {
  destroyAllWorkers()
  stopIPCWebSocket()
  stopStaticServer()
})
process.on('SIGTERM', () => { destroyAllWorkers(); process.exit(0) })
process.on('SIGINT', () => { destroyAllWorkers(); process.exit(0) })
process.on('exit', () => {
  for (const pid of workerPids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* best effort */ }
  }
})
