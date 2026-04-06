# Migrate Desktop from `pear run` to Standalone Electron + pear-runtime

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deprecated `pear run` launcher with a standard Electron app that embeds `pear-runtime` as a library, following the [hello-pear-electron](https://github.com/holepunchto/hello-pear-electron) template exactly.

**Architecture:** Electron becomes the host app (no more `pear run`). `pear-runtime` is a library dependency — `new PearRuntime({...})` creates the runtime instance. The P2P backend runs in a Bare worker spawned via `pear.run()`. The renderer starts the worker via `bridge.startWorker(specifier)` and communicates through per-specifier IPC channels (`bridge.writeWorkerIPC(specifier, data)` / `bridge.onWorkerIPC(specifier, cb)`). The Expo web export stays as-is.

**Tech Stack:** Electron ^40.2.1, `pear-runtime` ^0.5.0, `paparam` ^1.10.0, `which-runtime` ^1.3.2, Electron Forge ^7.11.1, Bare runtime (worker), HRPC (unchanged)

**Reference implementation:** https://github.com/holepunchto/hello-pear-electron

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| **Create** | `packages/app/electron/main.js` | Electron main process: PearRuntime init, window creation, per-specifier worker IPC relay, deep links, updates |
| **Create** | `packages/app/electron/preload.js` | contextBridge: per-specifier worker IPC (writeWorkerIPC, onWorkerIPC, onWorkerStdout, etc.), pear events, pkg() |
| **Create** | `packages/app/forge.config.js` | Electron Forge config: makers (DMG, MSIX, ZIP), prebuild plugins, signing hooks |
| **Modify** | `packages/app/pear-src/workers/core/index.ts:395-420` | Use `Bare.IPC` as transport + `Bare.argv[2]` for storage |
| **Modify** | `packages/app/pear-src/worker-client.js` | Detect `window.bridge`, create virtual pipe via `bridge.writeWorkerIPC`/`onWorkerIPC` |
| **Modify** | `packages/app/package.json` | Add electron/pear-runtime deps, `"main": "electron/main.js"`, new scripts |
| **Modify** | `packages/app/pear-src/scripts/inject-pear-bar.js` | Remove `<pear-ctrl>`, keep drag region CSS |

---

## Chunk 1: Electron Main + Preload (following template exactly)

### Task 1: Create electron/main.js

Follows `hello-pear-electron/electron/main.js` pattern exactly: paparam CLI parsing, per-specifier worker management, `getAppPath()` for all platforms, deep link protocol, single instance lock.

**Files:**
- Create: `packages/app/electron/main.js`

- [ ] **Step 1: Create electron/main.js**

```js
const { app, BrowserWindow, ipcMain } = require('electron')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag } = require('paparam')
const pkg = require('../pear-src/package.json')

const { name, productName, version, upgrade } = pkg
const protocol = name
const appName = productName ?? name

const workers = new Map()
let pear = null

// CLI argument parsing (matches template exactly)
const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates')
)
cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const pearStore = cmd.flags.storage
const updates = cmd.flags.updates

// Sync package.json to renderer
ipcMain.on('pkg', (evt) => { evt.returnValue = pkg })

function getPear () {
  if (pear) return pear
  const appPath = getAppPath()
  let dir = null
  if (pearStore) {
    console.log('pear store: ' + pearStore)
    dir = pearStore
  } else if (appPath === null) {
    dir = path.join(os.tmpdir(), 'pear', appName)
  } else {
    dir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', appName)
      : isLinux
        ? path.join(os.homedir(), '.config', appName.toLowerCase())
        : path.join(os.homedir(), 'AppData', 'Local', appName)
  }

  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'
  pear = new PearRuntime({
    dir,
    app: appPath,
    updates,
    version,
    upgrade,
    name: productName + extension
  })
  pear.on('error', console.error)
  return pear
}

function getAppPath () {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll (name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

// Per-specifier worker management (matches template pattern exactly)
function getWorker (specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const p = getPear()
  const worker = p.run(require.resolve('..' + specifier), [p.storage])

  function sendWorkerStdout (data) { sendToAll('pear:worker:stdout:' + specifier, data) }
  function sendWorkerStderr (data) { sendToAll('pear:worker:stderr:' + specifier, data) }
  function sendWorkerIPC (data) { sendToAll('pear:worker:ipc:' + specifier, data) }
  function onBeforeQuit () { worker.destroy() }

  ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => {
    return worker.write(Buffer.from(data))
  })

  workers.set(specifier, worker)
  worker.on('data', sendWorkerIPC)
  worker.stdout.on('data', sendWorkerStdout)
  worker.stderr.on('data', sendWorkerStderr)
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    worker.removeListener('data', sendWorkerIPC)
    worker.stdout.removeListener('data', sendWorkerStdout)
    worker.stderr.removeListener('data', sendWorkerStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })
  app.on('before-quit', onBeforeQuit)
  return worker
}

// Window creation
async function createWindow () {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0e0e10',
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: isWindows ? {
      color: '#0e0e10',
      symbolColor: '#ffffff',
      height: 52
    } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const p = getPear()

  const onUpdating = () => {
    if (!win.isDestroyed()) win.webContents.send('pear:event:updating')
  }
  const onUpdated = () => {
    if (!win.isDestroyed()) win.webContents.send('pear:event:updated')
  }
  p.updater.on('updating', onUpdating)
  p.updater.on('updated', onUpdated)
  win.on('closed', () => {
    p.updater.removeListener('updating', onUpdating)
    p.updater.removeListener('updated', onUpdated)
  })

  // Load content
  const devServerUrl = process.env.PEARTUBE_DEV_SERVER_URL
  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
    return
  }

  // Load Expo web export
  const indexPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'pear', 'index.html')
    : path.join(__dirname, '..', 'pear', 'index.html')
  await win.loadFile(indexPath)
}

// IPC handlers (matches template)
ipcMain.handle('pear:applyUpdate', () => getPear().updater.applyUpdate())
ipcMain.handle('pear:startWorker', (evt, filename) => {
  getWorker(filename)
  return true
})
ipcMain.handle('app:restart', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv.slice(1).filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    })
  } else {
    app.relaunch()
  }
  app.exit(0)
})

// Deep link protocol
function handleDeepLink (url) {
  console.log('deep link:', url)
}

app.setAsDefaultProtocolClient(protocol)
app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

// Single instance lock
const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'))
    if (url) handleDeepLink(url)
  })

  app.whenReady().then(() => {
    createWindow().catch((err) => {
      console.error('Failed to create window:', err)
      app.quit()
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch(console.error)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
```

**Differences from template:** Window dimensions (1280x800 vs 800x600), `titleBarStyle: 'hiddenInset'` for macOS traffic lights, HTML path points to Expo web export (`pear/index.html`), reads `pkg` from `pear-src/package.json`, dev server env var is `PEARTUBE_DEV_SERVER_URL`.

- [ ] **Step 2: Commit**

```bash
git add packages/app/electron/main.js
git commit -m "feat(desktop): add Electron main process following hello-pear-electron template

Per-specifier worker management, paparam CLI, PearRuntime as library,
deep link protocol, single instance lock, P2P update events."
```

---

### Task 2: Create electron/preload.js

Matches template exactly — per-specifier worker channels.

**Files:**
- Create: `packages/app/electron/preload.js`

- [ ] **Step 1: Create electron/preload.js**

```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bridge', {
  pkg () {
    return ipcRenderer.sendSync('pkg')
  },
  applyUpdate: () => ipcRenderer.invoke('pear:applyUpdate'),
  appRestart: () => ipcRenderer.invoke('app:restart'),
  onPearEvent: (name, listener) => {
    const wrap = (evt, eventName) => listener(eventName)
    ipcRenderer.on('pear:event:' + name, wrap)
    return () => ipcRenderer.removeListener('pear:event:' + name, wrap)
  },
  startWorker: (specifier) => ipcRenderer.invoke('pear:startWorker', specifier),
  writeWorkerIPC: (specifier, data) => {
    return ipcRenderer.invoke('pear:worker:writeIPC:' + specifier, data)
  },
  onWorkerIPC: (specifier, listener) => {
    const wrap = (evt, data) => listener(Buffer.from(data))
    ipcRenderer.on('pear:worker:ipc:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:ipc:' + specifier, wrap)
  },
  onWorkerStdout: (specifier, listener) => {
    const wrap = (evt, data) => listener(Buffer.from(data))
    ipcRenderer.on('pear:worker:stdout:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stdout:' + specifier, wrap)
  },
  onWorkerStderr: (specifier, listener) => {
    const wrap = (evt, data) => listener(Buffer.from(data))
    ipcRenderer.on('pear:worker:stderr:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stderr:' + specifier, wrap)
  },
  onWorkerExit: (specifier, listener) => {
    const wrap = (evt, data) => listener(data)
    ipcRenderer.on('pear:worker:exit:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:exit:' + specifier, wrap)
  }
})
```

This is functionally identical to the template's preload.js.

- [ ] **Step 2: Commit**

```bash
git add packages/app/electron/preload.js
git commit -m "feat(desktop): add preload bridge (per-specifier worker IPC)

Matches hello-pear-electron template: writeWorkerIPC, onWorkerIPC,
onWorkerStdout, onWorkerStderr, onWorkerExit, pear events, pkg sync."
```

---

## Chunk 2: Worker + Client Migration

### Task 3: Update worker to use Bare.IPC

The backend worker is spawned by `pear.run()`. It receives storage as `Bare.argv[2]` and communicates via `Bare.IPC`.

**Files:**
- Modify: `packages/app/pear-src/workers/core/index.ts:395-420`

- [ ] **Step 1: Add Bare type declarations**

After the existing imports (line 22), add:

```typescript
// Bare runtime globals (available when spawned via pear.run())
declare const Bare: { argv: string[]; IPC: any } | undefined
```

- [ ] **Step 2: Update pipe and storage resolution (lines 395-405)**

Replace:
```typescript
const workerBaseDir = (typeof Pear?.config?.dir === 'string' && Pear.config.dir.trim()) ? Pear.config.dir : os.cwd()
;(globalThis as any).__PEARTUBE_HYPERCORE_WORKER_PATH__ = path.join(workerBaseDir || '.', 'build/workers/hypercore-reader-worker.mjs')

let storage: string
if (Pear.config.storage) { storage = Pear.config.storage }
else { try { const dir = require('bare-storage'); storage = path.join(dir.persistent(), 'peartube') } catch { storage = path.join(os.homedir(), '.peartube') } }
console.log('[Worker] Storage:', storage)
const injectedPipe = (globalThis as any).__PEARTUBE_HRPC_PIPE__ as any
const ipcPipe = injectedPipe || pipe()
if (!ipcPipe) throw new Error('No IPC pipe')
```

With:
```typescript
// Storage: Bare.argv[2] (from pear.run()), then Pear.config, then default
const bareArgv = (typeof Bare !== 'undefined' && Array.isArray(Bare.argv)) ? Bare.argv : []
const runtimeStorage = bareArgv[2] || null

let storage: string
if (runtimeStorage) { storage = path.join(runtimeStorage, 'peartube') }
else if (typeof Pear !== 'undefined' && Pear.config?.storage) { storage = Pear.config.storage }
else { try { const dir = require('bare-storage'); storage = path.join(dir.persistent(), 'peartube') } catch { storage = path.join(os.homedir(), '.peartube') } }
console.log('[Worker] Storage:', storage)

const workerBaseDir = runtimeStorage || ((typeof Pear !== 'undefined' && typeof Pear?.config?.dir === 'string' && Pear.config.dir.trim()) ? Pear.config.dir : os.cwd())
;(globalThis as any).__PEARTUBE_HYPERCORE_WORKER_PATH__ = path.join(workerBaseDir || '.', 'build/workers/hypercore-reader-worker.mjs')

// Transport: Bare.IPC (new pear-runtime), then injected pipe, then pear-pipe
const bareIPC = (typeof Bare !== 'undefined' && Bare.IPC) ? Bare.IPC : null
const injectedPipe = (globalThis as any).__PEARTUBE_HRPC_PIPE__ as any
const ipcPipe = bareIPC || injectedPipe || pipe()
if (!ipcPipe) throw new Error('No IPC pipe')
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/pear-src/workers/core/index.ts
git commit -m "feat(worker): support Bare.IPC from pear.run()

Prefers Bare.IPC transport and Bare.argv[2] storage path.
Falls back to globalThis pipe and pear-pipe for legacy compat."
```

---

### Task 4: Update worker-client.js with bridge virtual pipe

The renderer starts the worker via `bridge.startWorker()` and creates a virtual duplex pipe over `bridge.writeWorkerIPC()` / `bridge.onWorkerIPC()`.

**Files:**
- Modify: `packages/app/pear-src/worker-client.js`

- [ ] **Step 1: Define the worker specifier constant**

At the top of the file (after imports, line 17), add:

```js
// Worker specifier — matches the path used by electron/main.js getWorker()
const BACKEND_WORKER = '/pear/build/workers/core/index.js'
```

- [ ] **Step 2: Add bridge pipe factory method**

Add this private method to the WorkerClient class (before `_doInitialize`):

```js
  #createBridgePipe(specifier) {
    // Virtual duplex stream over Electron IPC bridge.
    // Implements the minimal interface HRPC/protomux needs.
    const listeners = new Map()
    let destroyed = false
    let unsubscribe = null

    const virtualPipe = {
      write(data) {
        if (destroyed) return false
        window.bridge.writeWorkerIPC(specifier, data instanceof ArrayBuffer ? new Uint8Array(data) : data)
        return true
      },
      on(event, cb) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(cb)
        return virtualPipe
      },
      removeListener(event, cb) {
        const cbs = listeners.get(event)
        if (cbs) { const idx = cbs.indexOf(cb); if (idx !== -1) cbs.splice(idx, 1) }
        return virtualPipe
      },
      emit(event, ...args) {
        const cbs = listeners.get(event)
        if (cbs) for (const cb of [...cbs]) cb(...args)
      },
      destroy() {
        if (destroyed) return
        destroyed = true
        virtualPipe.emit('end')
        virtualPipe.emit('close')
        listeners.clear()
        if (unsubscribe) unsubscribe()
      },
      get destroyed() { return destroyed },
      get writable() { return !destroyed },
      get readable() { return !destroyed },
    }

    // Subscribe to incoming data from worker via main process relay
    unsubscribe = window.bridge.onWorkerIPC(specifier, (data) => {
      if (!destroyed) virtualPipe.emit('data', data)
    })

    // Log worker stdout/stderr
    const offStdout = window.bridge.onWorkerStdout(specifier, (data) => {
      console.log('[Worker stdout]', new TextDecoder().decode(data))
    })
    const offStderr = window.bridge.onWorkerStderr(specifier, (data) => {
      console.error('[Worker stderr]', new TextDecoder().decode(data))
    })
    const offExit = window.bridge.onWorkerExit(specifier, (code) => {
      console.log('[Worker] Exited with code:', code)
      offStdout(); offStderr(); offExit()
      if (!destroyed) virtualPipe.destroy()
    })

    return virtualPipe
  }
```

- [ ] **Step 3: Update _doInitialize to use bridge when available**

Replace lines 47-54 of `_doInitialize`:

```js
  async _doInitialize() {
    // New architecture: Electron bridge (per-specifier worker IPC)
    if (typeof window !== 'undefined' && window.bridge?.startWorker) {
      console.log('[WorkerClient] Using Electron bridge (pear-runtime)')

      // Start the backend worker via main process
      await window.bridge.startWorker(BACKEND_WORKER)
      console.log('[WorkerClient] Worker started:', BACKEND_WORKER)

      // Create virtual pipe over bridge IPC
      this.pipe = this.#createBridgePipe(BACKEND_WORKER)
    } else {
      // Legacy: pear run (direct pear-pipe)
      console.log('[WorkerClient] Falling back to pear-pipe (legacy pear run)')
      this.pipe = (typeof Pear !== 'undefined' && typeof Pear.pipe === 'function')
        ? Pear.pipe()
        : pipe()
    }

    if (!this.pipe) throw new Error('Failed to create pipe')

    // Create shared protocol client on top of the pipe (unchanged)
    console.log('[WorkerClient] Creating shared protocol client...')
    this.client = createProtocolClient({ stream: this.pipe })
    this.rpc = this.client.rpc
    console.log('[WorkerClient] HRPC client initialized')

    // ... rest of _doInitialize unchanged (event binding, handshake) ...
```

Keep the rest of `_doInitialize` (from `const methods = ...` onward) unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/app/pear-src/worker-client.js
git commit -m "feat(worker-client): support Electron bridge with per-specifier IPC

Starts worker via bridge.startWorker(), creates virtual duplex pipe
over bridge.writeWorkerIPC/onWorkerIPC. Falls back to pear-pipe."
```

---

## Chunk 3: Build Pipeline + Config

### Task 5: Create forge.config.js

Matches template: universal prebuilds plugin, prune prebuilds plugin, DMG maker, MSIX maker with hooks.

**Files:**
- Create: `packages/app/forge.config.js`

- [ ] **Step 1: Create forge.config.js**

```js
const fs = require('fs')
const path = require('path')
const pkg = require('./pear-src/package.json')
const appName = pkg.productName ?? pkg.name
const { isWindows } = require('which-runtime')

function getWindowsKitVersion () {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs.readdirSync(binDir).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().pop()
      if (version) return version
    }
  } catch { return undefined }
}

let packagerConfig = {
  name: appName,
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  extraResource: ['./pear']
}

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist')
      })
    },
    osxNotarize: {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    }
  }
}

module.exports = {
  packagerConfig,
  makers: [
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: {} },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        windowsKitVersion: getWindowsKitVersion(),
        ...(process.env.WINDOWS_CERTIFICATE_FILE ? {
          windowsSignOptions: {
            certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD
          }
        } : {})
      }
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux'] }
  ],
  hooks: {
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, path.basename(artifact))
          fs.renameSync(artifact, dest)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
        }
      }
      if (isWindows) {
        fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })
      }
    }
  },
  plugins: [
    { name: 'electron-forge-plugin-universal-prebuilds', config: {} },
    { name: 'electron-forge-plugin-prune-prebuilds', config: {} }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/forge.config.js
git commit -m "feat(desktop): add Electron Forge config following template

DMG + MSIX + ZIP makers, prebuild plugins, signing support,
Pear output as extraResource."
```

---

### Task 6: Update package.json

**Files:**
- Modify: `packages/app/package.json`

- [ ] **Step 1: Add `"main"` field**

Add near the top:
```json
"main": "electron/main.js",
```

- [ ] **Step 2: Add dependencies**

To `dependencies`:
```json
"pear-runtime": "^0.5.0",
"paparam": "^1.10.0",
"which-runtime": "^1.3.2"
```

To `devDependencies`:
```json
"electron": "^40.2.1",
"@electron-forge/cli": "^7.11.1",
"@electron-forge/maker-dmg": "^7.11.1",
"@electron-forge/maker-msix": "^7.11.1",
"@electron-forge/maker-zip": "^7.11.1",
"electron-forge-plugin-prune-prebuilds": "^1.0.0",
"electron-forge-plugin-universal-prebuilds": "^1.0.0"
```

- [ ] **Step 3: Add scripts**

```json
"electron:start": "electron-forge start -- --no-updates",
"electron:dev": "npm run pear:build && electron-forge start -- --no-updates",
"electron:package": "electron-forge package",
"electron:make:darwin": "electron-forge make --platform=darwin",
"electron:make:win32": "electron-forge make --platform=win32"
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/package.json
git commit -m "feat(desktop): add Electron + pear-runtime deps and scripts"
```

---

### Task 7: Update inject-pear-bar.js

Remove `<pear-ctrl>` (Pear-specific window controls). The Electron window handles controls natively via `titleBarStyle: 'hiddenInset'`.

**Files:**
- Modify: `packages/app/pear-src/scripts/inject-pear-bar.js:14`

- [ ] **Step 1: Remove `<pear-ctrl>` from bar HTML**

Replace line 14:
```js
const PEAR_BAR_HTML = `<div id="pear-bar" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:0;width:240px;z-index:9999;display:flex;align-items:flex-start;padding-top:12px;padding-left:12px;box-sizing:border-box;"><pear-ctrl style="-webkit-app-region:no-drag;"></pear-ctrl></div><div id="pear-bar-right" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:240px;right:0;z-index:9998;"></div>`
```

With:
```js
const PEAR_BAR_HTML = `<div id="pear-bar" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:0;width:240px;z-index:9999;box-sizing:border-box;"></div><div id="pear-bar-right" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:240px;right:0;z-index:9998;"></div>`
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/pear-src/scripts/inject-pear-bar.js
git commit -m "chore(desktop): remove pear-ctrl from title bar

Electron handles window controls natively via titleBarStyle."
```

---

## Chunk 4: Verification

### Task 8: Build and test

- [ ] **Step 1: Build the Pear output**

```bash
cd packages/app && npm run pear:build
```

- [ ] **Step 2: Install new deps**

```bash
cd packages/app && npm install
```

- [ ] **Step 3: Run with Electron**

```bash
cd packages/app && npm run electron:start
```

Verify:
1. Window opens (1280x800, macOS traffic lights visible)
2. Expo web content loads
3. Console shows `[WorkerClient] Using Electron bridge (pear-runtime)`
4. Console shows `[WorkerClient] Worker started: /pear/build/workers/core/index.js`
5. HRPC handshake completes: `[WorkerClient] Connected. blobServerPort:`
6. Feed loads, videos play

- [ ] **Step 4: Test legacy pear run still works**

```bash
cd packages/app/pear && pear run --dev --store=$HOME/.peartube .
```

Verify backward compat: `[WorkerClient] Falling back to pear-pipe (legacy pear run)`

- [ ] **Step 5: Update pear:dev default**

```json
"pear:dev": "npm run pear:build && npm run electron:start"
```

- [ ] **Step 6: Commit**

```bash
git add packages/app/package.json
git commit -m "feat(desktop): switch pear:dev to Electron launcher"
```
