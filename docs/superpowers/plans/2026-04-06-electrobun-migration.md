# Migrate PearTube Desktop from Electron to Electrobun+Bun

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Electron+Node with Electrobun+Bun for the desktop app, following the architecture proven in `~/projects/p2p-farmville`. Eliminates preload.js/contextBridge boilerplate, gets typed RPC, and uses Bun natively.

**Architecture:** Bun main process spawns the Bare worker via `PearRuntime.run()` and relays IPC to the renderer via Electrobun's typed RPC. The renderer sets up `window.bridge` (same interface the Expo app already expects) backed by Electrobun RPC instead of Electron IPC. The HRPC protocol client in `rpc.web.ts` stays unchanged — only the underlying transport switches from Electron IPC to Electrobun RPC. The Bare worker (`pear-src/workers/core/index.ts`) is untouched — it already uses `Bare.IPC`.

**Tech Stack:** Electrobun 1.16+, Bun, pear-runtime ^1.1.1, Protomux, compact-encoding, Expo web export (unchanged)

**Reference:** `~/projects/p2p-farmville` — working Electrobun + PearRuntime + Bare worker app

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| **Create** | `packages/app/src/bun/index.ts` | Bun main process: PearRuntime init, worker spawn, Protomux IPC relay, window creation |
| **Create** | `packages/app/src/view/index.ts` | Electroview bridge: sets up `window.bridge` backed by Electrobun RPC |
| **Create** | `packages/app/src/shared/rpc-types.ts` | Shared RPC type definitions for Bun ↔ Renderer |
| **Create** | `packages/app/electrobun.config.ts` | Electrobun build configuration |
| **Modify** | `packages/app/pear-src/scripts/inject-pear-bar.js` | Keep relative asset paths for views:// protocol |
| **Modify** | `packages/app/package.json` | Add electrobun deps, add `desktop:*` scripts |
| **Delete** | `packages/app/electron/main.js` | Replaced by src/bun/index.ts |
| **Delete** | `packages/app/electron/preload.js` | Replaced by src/view/index.ts |
| **Delete** | `packages/app/forge.config.js` | Electron Forge no longer needed |

---

## Chunk 1: Shared RPC Types + Electrobun Config

### Task 1: Create shared RPC type definitions

The RPC surface between Bun and Renderer is minimal — just raw binary IPC relay (the HRPC protocol client in the renderer handles the actual RPC methods). We only need:
- `workerWrite`: renderer → bun → worker (binary data)
- `onWorkerIPC`: worker → bun → renderer (binary data)
- `onWorkerStdout/Stderr`: log relay
- `startWorker` / `onWorkerExit`: lifecycle

**Files:**
- Create: `packages/app/src/shared/rpc-types.ts`

- [ ] **Step 1: Create the type file**

```typescript
/**
 * Electrobun RPC types for PearTube desktop.
 *
 * The renderer communicates with the Bare worker via HRPC/Protomux.
 * Bun just relays raw binary chunks between them — no knowledge of
 * the 50+ RPC methods. This keeps the surface tiny.
 */
export type PearTubeRPC = {
  // Handled by Bun (renderer calls these)
  main: {
    requests: {
      startWorker: { params: { specifier: string }; response: { ok: boolean } }
      viewReady: { params: {}; response: { blobServerPort: number | null } }
    }
    messages: {
      workerWrite: { specifier: string; data: number[] }
    }
  }
  // Handled by Renderer (Bun calls these)
  webview: {
    requests: {}
    messages: {
      onWorkerIPC: { specifier: string; data: number[] }
      onWorkerStdout: { specifier: string; data: string }
      onWorkerStderr: { specifier: string; data: string }
      onWorkerExit: { specifier: string; code: number }
    }
  }
}
```

Note: We serialize binary data as `number[]` (JSON-safe) since Electrobun RPC uses JSON over WebSocket. The HRPC messages are small (protobuf-encoded), so the overhead is negligible.

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shared/rpc-types.ts
git commit -m "feat(desktop): add Electrobun RPC type definitions

Minimal IPC relay surface — Bun forwards raw binary chunks between
renderer HRPC client and Bare worker. No knowledge of app-level RPCs."
```

---

### Task 2: Create Electrobun config

**Files:**
- Create: `packages/app/electrobun.config.ts`

- [ ] **Step 1: Create config**

```typescript
export default {
  app: {
    name: 'PearTube',
    identifier: 'com.peartube.desktop',
    version: '0.1.0',
  },
  build: {
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    views: {
      app: {
        entrypoint: 'src/view/index.ts',
      },
    },
    copy: {
      // Expo web export
      'pear': 'views/app',
      // Bare worker (compiled by desktop:worker script)
      'pear/build/workers': 'workers',
      // Node modules needed by the Bare worker at runtime
      'pear/node_modules': 'node_modules',
    },
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/electrobun.config.ts
git commit -m "feat(desktop): add Electrobun build config

Maps Expo web export to views/app, Bare worker to workers/."
```

---

## Chunk 2: Bun Main Process

### Task 3: Create Bun main process

This replaces `electron/main.js`. Follows the p2p-farmville pattern exactly: PearRuntime.run() spawns the Bare worker, IPC stream relayed via Electrobun RPC.

**Files:**
- Create: `packages/app/src/bun/index.ts`

- [ ] **Step 1: Create the main process**

```typescript
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
const appCodeDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const storagePath = getStoragePath()

function getWorker(specifier: string) {
  if (workers.has(specifier)) return workers.get(specifier)

  const workerPath = join(appCodeDir, specifier.replace(/^\//, ''))
  if (!existsSync(workerPath)) {
    throw new Error(`Worker not found: ${workerPath}`)
  }

  console.log('[main] Spawning Bare worker:', workerPath)
  const worker = PearRuntime.run(workerPath, [storagePath])

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
        console.log('[main] Renderer ready')
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

// ── Create Window ───────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    url: 'views://app/index.html',
    frame: { width: 1280, height: 800 },
    titleBarStyle: 'hiddenInset',
    renderer: 'cef', // Chromium for HTML5 video + custom libffmpeg
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
  for (const [, worker] of workers) {
    try { process.kill(worker._process?.pid, 'SIGKILL') } catch {}
  }
})
```

**Key differences from Electron version:**
- No static HTTP server (views:// handles file serving)
- No preload.js (Electrobun RPC replaces contextBridge)
- No `ipcMain.handle` boilerplate (typed RPC)
- Worker IPC data serialized as `number[]` for JSON transport
- PearRuntime.run() called directly from Bun (same as p2p-farmville)

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/bun/index.ts
git commit -m "feat(desktop): add Electrobun Bun main process

PearRuntime.run() spawns Bare worker, Electrobun RPC relays IPC
to renderer. Replaces electron/main.js + preload.js."
```

---

## Chunk 3: Renderer Bridge (Electroview)

### Task 4: Create Electroview bridge

This runs in the webview and exposes `window.bridge` — the same interface that `rpc.web.ts` already checks for. The HRPC protocol client connects through this bridge without knowing it's Electrobun underneath.

**Files:**
- Create: `packages/app/src/view/index.ts`

- [ ] **Step 1: Create the view bridge**

```typescript
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
      onWorkerIPC: ({ specifier, data }) => {
        fireListeners(ipcListeners, specifier, Buffer.from(data))
      },
      onWorkerStdout: ({ specifier, data }) => {
        fireListeners(stdoutListeners, specifier, Buffer.from(data))
      },
      onWorkerStderr: ({ specifier, data }) => {
        fireListeners(stderrListeners, specifier, Buffer.from(data))
      },
      onWorkerExit: ({ specifier, code }) => {
        fireListeners(exitListeners, specifier, code)
      },
    },
  },
})

const electrobun = new Electroview({ rpc })

// ── window.bridge (matches Electron preload.js contract) ────────────────
const bridge = {
  pkg() {
    // Return minimal app metadata
    return { name: 'peartube', productName: 'PearTube', version: '0.1.0' }
  },

  applyUpdate: async () => { /* no-op for now */ },
  appRestart: async () => { window.location.reload() },

  onPearEvent(_name: string, _listener: Function) {
    return () => {} // no-op, placeholder for update events
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
          : Array.from(Buffer.from(data))
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
```

**Key insight:** By implementing the exact `window.bridge` interface from `electron/preload.js`, the existing `rpc.web.ts` transport detection (`window.bridge?.startWorker`) works without any changes. The entire HRPC protocol stack is unaware of the Electron → Electrobun swap.

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/view/index.ts
git commit -m "feat(desktop): add Electroview bridge (window.bridge)

Implements the same bridge interface as electron/preload.js.
rpc.web.ts detects window.bridge and works unchanged."
```

---

## Chunk 4: Build Pipeline + Package Updates

### Task 5: Update package.json

**Files:**
- Modify: `packages/app/package.json`

- [ ] **Step 1: Add Electrobun dependencies**

To `dependencies`:
```json
"electrobun": "^1.16.0",
"pear-runtime": "^1.1.1",
"protomux": "^3.10.1",
"compact-encoding": "^2.19.2"
```

Note: `pear-runtime` version bumped from `^0.5.0` to `^1.1.1` (matches p2p-farmville). The v1 API is the same for `PearRuntime.run()`.

- [ ] **Step 2: Add scripts**

```json
"electrobun:build": "npm run desktop:export && npm run desktop:merge && npm run desktop:copy && npm run desktop:install && npm run desktop:worker && npm run desktop:inject && electrobun build",
"electrobun:dev": "npm run electrobun:build && electrobun dev",
"electrobun:start": "electrobun dev"
```

- [ ] **Step 3: Update inject-pear-bar.js for views:// protocol**

The views:// protocol uses file-system paths, not HTTP. Asset paths must stay relative (`./_expo/`) instead of being converted to absolute (`/_expo/`).

In `packages/app/pear-src/scripts/inject-pear-bar.js`, comment out or conditionalize lines 52-53:

```javascript
// Only convert to absolute paths when serving via HTTP (Electron static server).
// Electrobun's views:// protocol resolves relative paths correctly.
if (process.env.PEARTUBE_ABSOLUTE_PATHS !== 'false') {
  html = html.replace(/href="\.\/_expo\//g, 'href="/_expo/')
  html = html.replace(/src="\.\/_expo\//g, 'src="/_expo/')
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/package.json packages/app/pear-src/scripts/inject-pear-bar.js
git commit -m "feat(desktop): add Electrobun deps and build scripts"
```

---

### Task 6: Remove Electron files

**Files:**
- Delete: `packages/app/electron/main.js`
- Delete: `packages/app/electron/preload.js`
- Delete: `packages/app/forge.config.js`

- [ ] **Step 1: Delete Electron-specific files**

```bash
rm packages/app/electron/main.js packages/app/electron/preload.js packages/app/forge.config.js
rmdir packages/app/electron
```

- [ ] **Step 2: Remove Electron devDependencies from package.json**

Remove from `devDependencies`:
```json
"electron": "^40.2.1",
"@electron-forge/cli": "^7.11.1",
"@electron-forge/maker-dmg": "^7.11.1",
"@electron-forge/maker-msix": "^7.11.1",
"@electron-forge/maker-zip": "^7.11.1",
"electron-forge-plugin-prune-prebuilds": "^1.0.0",
"electron-forge-plugin-universal-prebuilds": "^1.0.0"
```

Remove the `"main": "electron/main.js"` field if present.

Remove Electron-specific scripts:
```json
"desktop:start": "npx electron ...",
"desktop:make:darwin": "electron-forge ...",
"desktop:make:win32": "electron-forge ..."
```

- [ ] **Step 3: Commit**

```bash
git rm packages/app/electron/main.js packages/app/electron/preload.js packages/app/forge.config.js
git add packages/app/package.json
git commit -m "chore(desktop): remove Electron files and dependencies

Replaced by Electrobun (src/bun/, src/view/, electrobun.config.ts)."
```

---

## Chunk 5: Verification

### Task 7: Build and test

- [ ] **Step 1: Install Electrobun deps**

```bash
cd packages/app && bun install
```

- [ ] **Step 2: Build the desktop app**

```bash
cd packages/app && npm run electrobun:build
```

- [ ] **Step 3: Run the app**

```bash
cd packages/app && electrobun dev
```

Verify:
1. Window opens (1280x800, macOS traffic lights visible via hiddenInset)
2. Console shows `[bridge] Electrobun bridge ready`
3. Console shows `[main] Spawning Bare worker:`
4. Console shows `[worker] [Storage] Initializing storage at:` (no fd-lock error)
5. Console shows `[Platform RPC] Initialized, blobServerPort:`
6. Feed loads with videos
7. Video playback works (HTML5 `<video>` with audio)

- [ ] **Step 4: Test video playback**

Navigate to a video. Verify:
- Video plays
- Audio works (including AC3 if custom libffmpeg is in place)
- Progress bar updates
- Play/pause/seek work

- [ ] **Step 5: Verify worker cleanup on quit**

Close the app. Verify no stale `bare` processes:
```bash
ps aux | grep "bare.*peartube" | grep -v grep
```

Expected: No output (worker cleaned up).

- [ ] **Step 6: Commit any fixups**

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────┐
│  Renderer (Chromium/CEF via Electrobun)              │
│                                                       │
│  Expo Web Export ──── rpc.web.ts ──── window.bridge   │
│  (React, RN-web)     (HRPC client)   (Electroview)   │
└───────────────────────────┬───────────────────────────┘
                            │ Electrobun RPC (typed, encrypted)
                            │ workerWrite ↓  onWorkerIPC ↑
┌───────────────────────────┴───────────────────────────┐
│  Bun Main Process (src/bun/index.ts)                  │
│                                                       │
│  PearRuntime.run() ──── worker.write() / on('data')   │
│  (bare-sidecar)         (raw binary IPC)              │
└───────────────────────────┬───────────────────────────┘
                            │ Bare.IPC (duplex stream)
┌───────────────────────────┴───────────────────────────┐
│  Bare Worker (pear-src/workers/core/index.ts)         │
│                                                       │
│  HRPC server ── Corestore ── Hyperswarm ── BlobServer │
│  (unchanged)                                          │
└───────────────────────────────────────────────────────┘
```

vs. the old Electron architecture:
- ~~preload.js + contextBridge~~ → Electroview typed RPC
- ~~ipcMain.handle per-specifier~~ → `BrowserView.defineRPC` (2 methods)
- ~~Static HTTP server for Expo~~ → views:// protocol (built-in)
- ~~Node.js main process~~ → Bun (faster startup, native TS)
