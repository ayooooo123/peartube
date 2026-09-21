/**
 * The desktop shell's loopback WebSocket is the renderer's entire authority
 * over the Bare backend worker (binary frames are raw HRPC) and over the app
 * bundle on disk (`pear:apply` swaps it, `pear:restart` relaunches it).
 * WebSocket upgrades ignore the same-origin policy, so before this gate any
 * page the user had open — and any local process that found the ephemeral
 * port — could drive both.
 *
 * These tests drive the real production handlers from src/bun/ipc-channel.ts
 * against a recording worker stub, so an unauthorized upgrade is proven not
 * to attach or write to the worker, not merely to get a 403.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { build } from 'esbuild'

import {
  IPC_CAPABILITY_PARAM,
  authorizeIpcUpgrade,
  createIpcChannelHandlers,
  mintIpcCapability,
} from '../src/bun/ipc-channel.ts'

const appRoot = path.resolve(import.meta.dirname, '..')
const SHELL_ORIGIN = 'http://127.0.0.1:41234'
const IPC_URL = 'http://127.0.0.1:52345/'

function createWorkerStub() {
  return {
    dataListeners: [],
    writes: [],
    on(event, listener) {
      assert.equal(event, 'data')
      this.dataListeners.push(listener)
    },
    off(event, listener) {
      assert.equal(event, 'data')
      this.dataListeners = this.dataListeners.filter((entry) => entry !== listener)
    },
    write(data) {
      this.writes.push(data)
    },
  }
}

function createHarness({ capability, allowedOrigins = [SHELL_ORIGIN] } = {}) {
  const worker = createWorkerStub()
  const clients = new Set()
  const controlFrames = []
  const logs = []
  const upgraded = []
  let started = 0

  const handlers = createIpcChannelHandlers({
    capability,
    allowedOrigins: () => allowedOrigins,
    clients,
    greeting: () => JSON.stringify({ t: 'pear:state', pkg: { version: '1.2.3' } }),
    startWorker: () => {
      started += 1
      return worker
    },
    runningWorker: () => (started > 0 ? worker : undefined),
    onControlFrame: (ws, raw) => controlFrames.push(raw),
  })

  // The real Bun server attaches the socket inside upgrade(); the open handler
  // is what reaches the worker, so the stub runs it exactly like Bun does.
  const server = {
    upgrade(_req) {
      const socket = {
        readyState: 1,
        sent: [],
        binary: [],
        closed: null,
        send(data) { this.sent.push(data) },
        sendBinary(data) { this.binary.push(data) },
        close(code, reason) { this.closed = { code, reason } },
      }
      upgraded.push(socket)
      handlers.websocket.open(socket)
      return true
    },
  }

  const connect = ({ url = IPC_URL, capability: presented, origin } = {}) => {
    const target = new URL(url)
    if (presented !== undefined) target.searchParams.set(IPC_CAPABILITY_PARAM, presented)
    const req = {
      url: target.href,
      headers: { get: (name) => (name.toLowerCase() === 'origin' ? origin ?? null : null) },
    }
    const consoleLog = console.log
    const consoleError = console.error
    console.log = (...args) => logs.push(args.join(' '))
    console.error = (...args) => logs.push(args.join(' '))
    try {
      return handlers.fetch(req, server)
    } finally {
      console.log = consoleLog
      console.error = consoleError
    }
  }

  return {
    handlers,
    worker,
    clients,
    controlFrames,
    logs,
    upgraded,
    connect,
    get started() { return started },
  }
}

function assertWorkerUntouched(harness) {
  assert.equal(harness.started, 0, 'no unauthorized upgrade may spawn the backend worker')
  assert.deepEqual(harness.worker.dataListeners, [], 'no unauthorized socket may be attached to the worker')
  assert.deepEqual(harness.worker.writes, [], 'no unauthorized socket may write to the worker')
  assert.equal(harness.upgraded.length, 0, 'the upgrade must be refused before server.upgrade()')
  assert.equal(harness.clients.size, 0, 'no unauthorized socket may join the update broadcast set')
}

test('an upgrade with no capability is refused before the worker is ever touched', () => {
  const capability = mintIpcCapability()
  const harness = createHarness({ capability })

  const response = harness.connect({})

  assert.equal(response.status, 403)
  assertWorkerUntouched(harness)
})

test('an upgrade with a wrong capability is refused before the worker is ever touched', () => {
  const capability = mintIpcCapability()
  const harness = createHarness({ capability })

  // Same length as the real one: the rejection cannot be a length check alone.
  const response = harness.connect({ capability: 'f'.repeat(capability.length) })

  assert.equal(response.status, 403)
  assertWorkerUntouched(harness)
})

test('a correct capability from a foreign origin is refused before the worker is ever touched', () => {
  const capability = mintIpcCapability()
  const harness = createHarness({ capability })

  const response = harness.connect({ capability, origin: 'https://evil.example' })

  assert.equal(response.status, 403)
  assertWorkerUntouched(harness)
})

test('a correct capability with no origin is accepted and attaches the worker', () => {
  const capability = mintIpcCapability()
  const harness = createHarness({ capability })

  const response = harness.connect({ capability })

  assert.equal(response, undefined, 'an accepted upgrade returns no HTTP response')
  assert.equal(harness.started, 1)
  assert.equal(harness.upgraded.length, 1)
  assert.equal(harness.worker.dataListeners.length, 1, 'the accepted socket is attached to the worker')
  assert.equal(harness.clients.size, 1)

  const [socket] = harness.upgraded
  assert.deepEqual(JSON.parse(socket.sent[0]), { t: 'pear:state', pkg: { version: '1.2.3' } })

  // The relay still carries HRPC in both directions for the trusted view.
  harness.handlers.websocket.message(socket, new Uint8Array([1, 2, 3]))
  assert.equal(harness.worker.writes.length, 1)
  assert.deepEqual([...harness.worker.writes[0]], [1, 2, 3])

  harness.worker.dataListeners[0](Buffer.from([9, 8]))
  assert.deepEqual([...harness.upgraded[0].binary[0]], [9, 8])

  harness.handlers.websocket.message(socket, JSON.stringify({ t: 'pear:apply', id: 1 }))
  assert.deepEqual(harness.controlFrames, [JSON.stringify({ t: 'pear:apply', id: 1 })])

  harness.handlers.websocket.close(socket)
  assert.deepEqual(harness.worker.dataListeners, [], 'closing unhooks the socket from the worker')
  assert.equal(harness.clients.size, 0)
})

test("a correct capability from the shell's own origin is accepted and attaches the worker", () => {
  const capability = mintIpcCapability()
  const harness = createHarness({ capability })

  const response = harness.connect({ capability, origin: SHELL_ORIGIN })

  assert.equal(response, undefined)
  assert.equal(harness.started, 1)
  assert.equal(harness.worker.dataListeners.length, 1)
})

test('the capability never reaches a log line the channel emits', () => {
  const capability = mintIpcCapability()
  const harness = createHarness({ capability })

  harness.connect({})
  harness.connect({ capability: 'f'.repeat(capability.length) })
  harness.connect({ capability, origin: 'https://evil.example' })
  harness.connect({ capability })
  harness.handlers.websocket.close(harness.upgraded[0])

  assert.ok(harness.logs.length > 0, 'the channel does log upgrade outcomes')
  for (const line of harness.logs) {
    assert.doesNotMatch(line, new RegExp(capability), `capability leaked into a log line: ${line}`)
  }
})

test('each launch mints a fresh 32-byte capability', () => {
  const first = mintIpcCapability()
  const second = mintIpcCapability()

  assert.match(first, /^[0-9a-f]{64}$/, 'the capability is 32 bytes of hex')
  assert.notEqual(first, second, 'the capability must not be a constant')
})

test('an unparseable or capability-free request URL is never authorized', () => {
  for (const url of ['not a url', 'http://127.0.0.1:52345/?other=1', 'http://127.0.0.1:52345/']) {
    assert.deepEqual(
      authorizeIpcUpgrade({ url, origin: null }, { capability: 'secret', allowedOrigins: [] }),
      { allowed: false, reason: 'missing-capability' },
      url,
    )
  }
})

test('the shell hands the capability to the view through the window bootstrap only', () => {
  const source = fs.readFileSync(path.join(appRoot, 'src/bun/index.ts'), 'utf8')

  assert.match(
    source,
    /const ipcCapability = mintIpcCapability\(\)/,
    'the launcher mints a per-launch capability',
  )
  assert.match(
    source,
    /url: `http:\/\/127\.0\.0\.1:\$\{staticPort\}\/\?\$\{IPC_CAPABILITY_PARAM\}=\$\{ipcCapability\}`/,
    'the capability is delivered in the URL the shell navigates the window to',
  )
  assert.doesNotMatch(
    source,
    /__peartube_ipc_port[\s\S]{0,400}ipcCapability/,
    'the loopback port-discovery endpoint must never hand the capability out',
  )
  assert.doesNotMatch(
    source,
    /console\.\w+\([^)]*ipcCapability/,
    'the capability must never be logged',
  )
  assert.doesNotMatch(
    source,
    /write\w*\([^)]*ipcCapability/,
    'the capability must never be written to disk',
  )
})

// The view bundle is what the shell actually loads, so it is bundled and run
// here against a fake window rather than pattern-matched.
let viewBundle = null
function bundleView() {
  if (!viewBundle) {
    viewBundle = build({
      entryPoints: [path.join(appRoot, 'src/view/index.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      resolveExtensions: ['.ts', '.js', '.json'],
      logLevel: 'silent',
      plugins: [{
        name: 'stub-electrobun',
        setup(esbuildBuild) {
          esbuildBuild.onResolve({ filter: /^electrobun\/view$/ }, () => ({
            path: 'electrobun-view',
            namespace: 'stub',
          }))
          esbuildBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            loader: 'js',
            contents: `
              export class Electroview {
                constructor(options) { this.rpc = options?.rpc ?? null }
                static defineRPC() {
                  return { proxy: { request: new Proxy({}, { get: () => async () => ({}) }) } }
                }
              }
            `,
          }))
        },
      }],
    }).then((result) => result.outputFiles[0].text)
  }
  return viewBundle
}

async function loadViewBridge(bootstrapHref) {
  const code = await bundleView()
  const sockets = []
  const replaced = []
  const logs = []

  class FakeWebSocket {
    static OPEN = 1
    constructor(url) {
      this.url = url
      this.readyState = 0
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }
    send() {}
    close() {}
  }

  const fakeWindow = { location: new URL(bootstrapHref) }
  const saved = { window: globalThis.window, history: globalThis.history, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch }
  const consoleLog = console.log
  const consoleError = console.error

  globalThis.window = fakeWindow
  globalThis.history = { replaceState: (_state, _title, url) => replaced.push(url) }
  globalThis.WebSocket = FakeWebSocket
  globalThis.fetch = async (input) => {
    assert.equal(input, '/__peartube_ipc_port')
    return { ok: true, status: 200, json: async () => ({ port: 5555 }) }
  }
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => logs.push(args.join(' '))

  try {
    // Unique fragment: the module has to be evaluated once per bootstrap URL.
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`)
    const started = await fakeWindow.bridge.startWorker('/pear/build/workers/core/index.js')
    return { started, sockets, replaced, logs }
  } finally {
    globalThis.window = saved.window
    globalThis.history = saved.history
    globalThis.WebSocket = saved.WebSocket
    globalThis.fetch = saved.fetch
    console.log = consoleLog
    console.error = consoleError
  }
}

test('the view takes the capability off the bootstrap URL, scrubs it, and presents it on the upgrade', async () => {
  const capability = mintIpcCapability()

  const { started, sockets, replaced, logs } = await loadViewBridge(
    `http://127.0.0.1:41234/?${IPC_CAPABILITY_PARAM}=${capability}`,
  )

  assert.equal(started, true, 'the trusted view still connects')
  assert.equal(sockets.length, 1)
  assert.equal(
    sockets[0].url,
    `ws://127.0.0.1:5555/?${IPC_CAPABILITY_PARAM}=${capability}`,
    'the capability is presented on the handshake URL',
  )
  assert.deepEqual(replaced, ['/'], 'the capability is stripped from the address before the app bundle runs')
  for (const line of logs) {
    assert.doesNotMatch(line, new RegExp(capability), `capability leaked into a view log line: ${line}`)
  }
})

test('a page that did not get the bootstrap capability never opens a socket', async () => {
  const { started, sockets } = await loadViewBridge('http://127.0.0.1:41234/')

  assert.equal(started, false, 'no capability means no connection attempt')
  assert.deepEqual(sockets, [], 'an unauthorized page must not even open the socket')
})

test('the view no longer probes neighbouring ports for a backend', () => {
  const source = fs.readFileSync(path.join(appRoot, 'src/view/index.ts'), 'utf8')

  assert.doesNotMatch(
    source,
    /for \(let offset = 1; offset <= 10; offset\+\+\)/,
    'the blind port scan is gone: an unauthorized probe could only ever be refused',
  )
})
