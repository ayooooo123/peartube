const { app, BrowserWindow, ipcMain } = require('electron')

// Enable remote debugging for DevTools MCP
app.commandLine.appendSwitch('remote-debugging-port', '9222')
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { isMac, isLinux, isWindows } = require('which-runtime')
let PearRuntime
try { PearRuntime = require('pear-runtime') } catch (e) { console.error('[PearTube] Failed to load pear-runtime:', e.message); PearRuntime = null }
let Sidecar
try { Sidecar = require('bare-sidecar') } catch (e) { console.error('[PearTube] Failed to load bare-sidecar:', e.message); Sidecar = null }
const { execSync } = require('child_process')
const { command, flag } = require('paparam')
const pkg = require('../pear-src/package.json')

const { name, productName, version, upgrade } = pkg

// Kill any stale bare-sidecar workers from a previous crash/force-quit.
// SIGKILL can't be caught, so the child process may outlive the parent.
function killStaleSidecars () {
  const storageDir = path.join(os.homedir(), '.peartube')
  const corestorePath = path.join(storageDir, 'CORESTORE')
  if (!fs.existsSync(corestorePath)) return
  try {
    const out = execSync(`lsof -t "${corestorePath}" 2>/dev/null`, { encoding: 'utf-8' }).trim()
    if (!out) return
    for (const pidStr of out.split('\n')) {
      const pid = parseInt(pidStr, 10)
      if (!pid || pid === process.pid) continue
      console.log('[PearTube] Killing stale worker holding Corestore lock: PID', pid)
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  } catch {}
}
killStaleSidecars()
const deepLinkProtocol = name
const appName = productName ?? name

const workers = new Map()
let pear = null

// Parse CLI args — filter out Electron internals before paparam
const rawArgs = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2)
const appArgs = rawArgs.filter(a => !a.startsWith('--inspect') && !a.startsWith('--remote-debugging') && a !== '--')

let pearStore = null
let updates = true
try {
  const cmd = command(
    appName,
    flag('--storage <dir>', 'pass custom storage to pear-runtime'),
    flag('--no-updates', 'start without OTA updates')
  )
  cmd.parse(appArgs)
  pearStore = cmd.flags.storage || null
  updates = cmd.flags.updates !== false
} catch (err) {
  console.warn('[PearTube] CLI parse error (continuing with defaults):', err.message)
}

ipcMain.on('pkg', (evt) => { evt.returnValue = pkg })

function getStorageDir () {
  if (pearStore) return pearStore
  const appPath = getAppPath()
  // Dev mode: use ~/.peartube (same as pear run --store=$HOME/.peartube)
  if (appPath === null) return path.join(os.homedir(), '.peartube')
  return isMac
    ? path.join(os.homedir(), 'Library', 'Application Support', appName)
    : isLinux
      ? path.join(os.homedir(), '.config', appName.toLowerCase())
      : path.join(os.homedir(), 'AppData', 'Local', appName)
}

function getPear () {
  if (pear) return pear
  const dir = getStorageDir()
  const appPath = getAppPath()
  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'

  // PearRuntime requires an upgrade link — use it when available (production),
  // fall back to a lightweight shim for dev mode without OTA.
  console.log('[PearTube] getPear: PearRuntime=' + !!PearRuntime + ' upgrade=' + !!upgrade + ' dir=' + dir)
  if (PearRuntime && upgrade) {
    pear = new PearRuntime({
      dir,
      app: appPath,
      updates,
      version,
      upgrade,
      name: productName + extension
    })
    pear.on('error', console.error)
  } else {
    // Dev mode: no upgrade link, no OTA. Provide the same interface.
    console.log('[PearTube] No upgrade link — running without PearRuntime (dev mode)')
    const storage = path.join(dir, 'app-storage')
    pear = {
      storage,
      dir,
      updater: null,
      run (entrypoint, args, opts) { return new Sidecar(entrypoint, args, opts) },
      on () {}
    }
  }
  return pear
}

function getAppPath () {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll (channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
}

// Track bare-sidecar PIDs so we can force-kill them if destroy() doesn't work
const workerPids = new Set()

function destroyAllWorkers () {
  for (const [specifier, worker] of workers) {
    console.log('[PearTube] Destroying worker:', specifier)
    try { worker.destroy() } catch {}
  }
  workers.clear()
  // Force-kill any bare processes that didn't exit within 2s
  if (workerPids.size > 0) {
    const pidsToKill = new Set(workerPids)
    setTimeout(() => {
      for (const pid of pidsToKill) {
        if (workerPids.has(pid)) {
          console.log('[PearTube] Force-killing worker PID:', pid)
          try { process.kill(pid, 'SIGKILL') } catch {}
          workerPids.delete(pid)
        }
      }
    }, 2000)
  }
}

// Last-resort: synchronous kill on process exit (fires even on crash/unexpected exit)
process.on('exit', () => {
  for (const pid of workerPids) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
})

process.on('SIGTERM', () => { destroyAllWorkers(); process.exit(0) })
process.on('SIGINT', () => { destroyAllWorkers(); process.exit(0) })

function getWorker (specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const p = getPear()
  // Pass the base storage dir (e.g. ~/.peartube) — the worker uses this
  // as its Corestore root, matching the path used by pear run --store=
  const worker = p.run(require.resolve('..' + specifier), [p.dir || p.storage])

  // Track the bare-sidecar PID for force-kill on exit
  const pid = worker._process?.pid
  if (pid) workerPids.add(pid)

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
    if (pid) workerPids.delete(pid)
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

// Simple static file server for the Expo web export.
// Expo Router needs http:// URLs (not file://) to resolve routes correctly.
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
}

let staticServer = null
let staticPort = 0

function startStaticServer (dir) {
  return new Promise((resolve, reject) => {
    staticServer = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      let filePath = path.join(dir, urlPath === '/' ? 'index.html' : urlPath)

      // SPA fallback: serve index.html for navigation routes only (not assets)
      if (!fs.existsSync(filePath)) {
        const ext = path.extname(urlPath)
        if (!ext || ext === '.html') {
          // Client-side route — serve index.html for Expo Router
          filePath = path.join(dir, 'index.html')
        } else {
          // Asset file missing — return 404
          res.writeHead(404)
          res.end('Not found')
          return
        }
      }

      const ext = path.extname(filePath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'

      try {
        const data = fs.readFileSync(filePath)
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end('Not found')
      }
    })
    staticServer.listen(0, '127.0.0.1', () => {
      staticPort = staticServer.address().port
      console.log('[PearTube] Static server on http://127.0.0.1:' + staticPort)
      resolve(staticPort)
    })
    staticServer.on('error', reject)
  })
}

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

  // P2P update events (only available when upgrade link is set)
  if (p.updater) {
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
  }

  const devServerUrl = process.env.PEARTUBE_DEV_SERVER_URL
  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
    return
  }

  // Serve Expo web export via local HTTP so Expo Router gets proper "/" routing
  const exportDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'pear')
    : path.join(__dirname, '..', 'pear')
  await startStaticServer(exportDir)
  await win.loadURL('http://127.0.0.1:' + staticPort)

  // Open DevTools in dev mode
  if (!app.isPackaged) win.webContents.openDevTools()
}

ipcMain.handle('pear:applyUpdate', () => getPear().updater?.applyUpdate())
ipcMain.handle('pear:startWorker', (evt, filename) => {
  console.log('[PearTube] startWorker requested:', filename)
  try {
    getWorker(filename)
    console.log('[PearTube] Worker started successfully:', filename)
    return true
  } catch (err) {
    console.error('[PearTube] Failed to start worker:', err.message)
    throw err
  }
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

function handleDeepLink (url) {
  console.log('deep link:', url)
}

app.setAsDefaultProtocolClient(deepLinkProtocol)
app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (evt, args) => {
    const url = args.find((arg) => arg.startsWith(deepLinkProtocol + '://'))
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
    destroyAllWorkers()
    if (staticServer) staticServer.close()
    if (process.platform !== 'darwin') app.quit()
  })

  // Safety net: ensure workers are destroyed on any quit path (Cmd+Q, force quit, etc.)
  app.on('will-quit', () => {
    destroyAllWorkers()
    if (staticServer) { staticServer.close(); staticServer = null }
  })
}
