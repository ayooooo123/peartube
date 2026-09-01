import test from 'brittle'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRelayConfig, renderExampleConfig, resolveRelayConfig } from '../src/config.js'
import { resolveCompanionConfig } from '../src/companion/config.js'
import { signControlRequest } from '../src/companion/auth.js'
import { createCompanionServer } from '../src/companion/server.js'
import { createRelayService } from '../src/service.js'
import { createArchiveHttpSurface } from '../src/archive-console.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(__dirname, '..')
const SECRET = 'cd'.repeat(32)
const CLIENT = 'client-test'
const NOW = 1_786_406_400_000
const noop = () => {}
const logger = Object.fromEntries(
  ['relay', 'runtime', 'status', 'archive', 'admission', 'discovery', 'mirror', 'storage', 'companion'].map((scope) => [
    scope,
    { info: noop, warn: noop, error: noop, debug: noop }
  ])
)

function tempDir (t, prefix = 'peartube-companion-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function listen (server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options, resolve)
  })
}

function close (server) {
  return new Promise((resolve) => server.close(resolve))
}

function request ({ socketPath, host, port, method = 'GET', path = '/api/v2/status', body = '', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, host, port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.once('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function signedHeaders ({ method = 'GET', path = '/api/v2/status', body = '', timestamp = NOW, nonce = 'server-nonce-0001' } = {}) {
  return signControlRequest({
    method,
    path,
    body,
    timestamp,
    nonce,
    client: CLIENT,
    secret: SECRET
  })
}

function partialSignedRequest (nonce) {
  const headers = signedHeaders({
    method: 'POST',
    path: '/api/v2/status',
    body: 'x'.repeat(100),
    nonce
  })
  return [
    'POST /api/v2/status HTTP/1.1',
    'Host: companion',
    'Content-Length: 100',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    'partial'
  ].join('\r\n')
}

function udsConfig (storagePath, overrides = {}) {
  return resolveCompanionConfig({
    enabled: true,
    transport: 'unix',
    client: CLIENT,
    sharedSecret: SECRET,
    ...overrides
  }, { storagePath })
}

function prepareSocketPath (storagePath) {
  const socketPath = udsConfig(storagePath).socketPath
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(socketPath), 0o700)
  return socketPath
}

function fakeRuntime () {
  const runtime = {
    ctx: { metaDb: null },
    api: {},
    identityManager: {},
    uploadManager: {},
    setCandidateHandler: noop,
    async start () {},
    async close () {},
    async getDiagnostics () { return {} }
  }
  runtime.provider = {
    async search ({ selector, limit, signal }) {
      const candidates = await runtime.api.searchIndexCandidates?.(selector, { limit, signal }) || []
      return { candidates, nextCursor: null }
    },
    async resolve () { throw new Error('not configured') },
    async requestAcquisition () { throw new Error('not configured') },
    async attachSourceGrant () { throw new Error('not configured') },
    async getAcquisition () { return null },
    async listAcquisitions () { return { items: [], cursor: null } },
    async cancelAcquisition () { return null },
    async getPublication () { return null },
    async openStream () { throw new Error('not configured') },
    async getStatus () { return { ready: true } },
    async getPolicy () { return {} },
    async setPolicy (value) { return value },
    async getAcquisitionPolicy () { return {} },
    async setAcquisitionPolicy ({ policy }) { return policy },
    async migrateLegacyIngest () { return { migrated: 0, skipped: 0 } }
  }
  return runtime
}

// Enough of a Hyperbee for the stores a relay opens when its archive surface is
// enabled: get/put for the archive job store, atomic batches and a bounded
// range read for the companion ingest store.
function fakeMetaDb () {
  const entries = new Map()
  const commit = (operations) => {
    for (const [operation, key, value] of operations) {
      if (operation === 'put') entries.set(key, value)
      else entries.delete(key)
    }
  }
  return {
    async get (key) { return entries.has(key) ? { value: entries.get(key) } : null },
    async put (key, value) { commit([['put', key, value]]) },
    async del (key) { commit([['del', key]]) },
    batch () {
      const staged = []
      return {
        async put (key, value) { staged.push(['put', key, value]) },
        async del (key) { staged.push(['del', key]) },
        async flush () { commit(staged) }
      }
    },
    async * createReadStream ({ gte = '', lt = '\uffff' } = {}) {
      for (const key of [...entries.keys()].sort()) {
        if (key >= gte && key < lt) yield { key, value: entries.get(key) }
      }
    }
  }
}

test('companion defaults disabled with Unix transport derived from resolved storage', (t) => {
  const storagePath = '/var/lib/peartube-custom'
  const config = resolveRelayConfig({ storage: { path: storagePath } }, { env: {} })

  t.is(config.companion.enabled, false)
  t.is(config.companion.transport, 'unix')
  t.is(config.companion.socketPath, '/var/lib/peartube-custom/.pt/s')
})

test('companion config derives the default socket from resolved storage and honors file/env/CLI precedence', async (t) => {
  const dir = tempDir(t, 'peartube-companion-config-')
  const configPath = join(dir, 'relay.yml')
  writeFileSync(configPath, [
    'storage:',
    `  path: ${join(dir, 'from-file')}`,
    'companion:',
    '  enabled: true',
    '  transport: unix',
    '  client: from-file',
    '  sharedSecret: file-secret',
    ''
  ].join('\n'))

  const config = await loadRelayConfig({
    config: configPath,
    companion: { client: 'from-cli' }
  }, {
    env: {
      PEARTUBE_STORAGE_PATH: join(dir, 'from-env'),
      PEARTUBE_COMPANION_CLIENT: 'from-env',
      PEARTUBE_COMPANION_SHARED_SECRET: SECRET
    }
  })

  t.is(config.storage.path, join(dir, 'from-env'))
  t.is(config.companion.socketPath, join(dir, 'from-env', '.pt', 's'))
  t.is(config.companion.client, 'from-cli')
  t.is(config.companion.sharedSecret, SECRET)
  t.is(renderExampleConfig(config).includes(SECRET), false)
})

test('enabled companion rejects password-like shared secrets', (t) => {
  t.exception(() => resolveCompanionConfig({
    enabled: true,
    client: CLIENT,
    sharedSecret: 'password'
  }, { storagePath: '/var/lib/peartube' }), /64 lowercase hexadecimal characters/)
})

test('plaintext TCP companion transport is loopback-only', (t) => {
  t.exception(() => resolveCompanionConfig({
    enabled: true,
    transport: 'tcp',
    host: '0.0.0.0',
    port: 8175,
    client: CLIENT,
    sharedSecret: SECRET
  }, { storagePath: '/var/lib/peartube' }), /must bind to loopback/)
})

test('authenticated Unix status is bounded, unsigned is rejected, replay conflicts, and close removes the 0600 socket', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  t.is(state.transport, 'unix')
  t.is(state.socketPath, join(storagePath, '.pt', 's'))
  t.is(JSON.stringify(state).includes(SECRET), false)
  t.is(statSync(state.socketPath).mode & 0o777, 0o600)

  const headers = signedHeaders()
  const valid = await request({ socketPath: state.socketPath, headers })
  t.is(valid.statusCode, 200)
  const status = JSON.parse(valid.body)
  t.is(status.apiVersion, 2)
  t.is(status.status, 'available')
  t.is(status.transport.mode, 'unix')
  t.is(status.auth.mode, 'mac')
  t.is(status.auth.clientId, CLIENT)
  t.ok(Buffer.byteLength(valid.body) < 256)

  const unsigned = await request({ socketPath: state.socketPath })
  t.is(unsigned.statusCode, 401)
  t.is(JSON.parse(unsigned.body).error.code, 'AUTH_REQUIRED')
  t.ok(Buffer.byteLength(unsigned.body) < 512)

  const replay = await request({ socketPath: state.socketPath, headers })
  t.is(replay.statusCode, 409)
  t.is(JSON.parse(replay.body).error.code, 'NONCE_REPLAY')

  await server.close()
  t.is(existsSync(state.socketPath), false)
})

test('Unix socket bind is wrapped in a restrictive owner-only umask', async (t) => {
  const storagePath = tempDir(t)
  const umaskCalls = []
  let activeUmask = 0o022
  const setUmask = (value) => {
    const previous = activeUmask
    activeUmask = value
    umaskCalls.push(value)
    return previous
  }
  const createServer = (handler) => {
    const server = createHttpServer(handler)
    const listen = server.listen
    server.listen = function (...args) {
      t.is(activeUmask, 0o177, 'restrictive umask is active when the socket is bound')
      return listen.apply(this, args)
    }
    return server
  }
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath),
    logger,
    createServer,
    setUmask
  })

  await server.start()
  t.alike(umaskCalls, [0o177, 0o022])
  t.is(activeUmask, 0o022, 'the previous process umask is restored')
  await server.close()
})

test('companion close terminates an in-flight request before removing its socket', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath),
    logger
  })
  const state = await server.start()
  const socket = createConnection(state.socketPath)
  await once(socket, 'connect')
  const socketClosed = once(socket, 'close')
  socket.write(partialSignedRequest('close-nonce-0001'))

  await server.close()
  await socketClosed
  t.is(existsSync(state.socketPath), false)
})

test('companion enforces an absolute in-flight request deadline', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath),
    clock: () => NOW,
    logger,
    requestDeadlineMs: 20
  })
  const state = await server.start()
  t.teardown(() => server.close().catch(noop))
  const socket = createConnection(state.socketPath)
  t.teardown(() => socket.destroy())
  await once(socket, 'connect')
  socket.write(partialSignedRequest('deadline-nonce-01'))

  await Promise.race([
    once(socket, 'close'),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('request deadline did not close the socket')), 250))
  ])
  t.pass('deadline closes the in-flight request')
})

test('companion closes a connection that never completes its first request headers', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath),
    logger,
    requestDeadlineMs: 20
  })
  const state = await server.start()
  t.teardown(() => server.close().catch(noop))
  const socket = createConnection(state.socketPath)
  t.teardown(() => socket.destroy())
  await once(socket, 'connect')

  await Promise.race([
    once(socket, 'close'),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('first request deadline did not close the socket')), 250))
  ])
  t.pass('deadline closes a pre-request connection')
})

test('request deadlines abort delegated backend work before server close returns', async (t) => {
  const storagePath = tempDir(t)
  let sawAbort = false
  let backendSettled = false
  const service = {
    search ({ signal } = {}) {
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          sawAbort = true
          resolve({ candidates: [] })
        }, { once: true })
      }).finally(() => {
        backendSettled = true
      })
    }
  }
  const server = createCompanionServer({
    service,
    config: udsConfig(storagePath),
    clock: () => NOW,
    logger,
    requestDeadlineMs: 20
  })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const requestResult = request({
    socketPath: state.socketPath,
    path,
    headers: signedHeaders({ path, nonce: 'backend-deadline-01' })
  }).then(
    () => null,
    error => error
  )

  t.ok(await requestResult)
  await server.close()
  t.is(sawAbort, true)
  t.is(backendSettled, true)
})

test('Unix startup refuses a non-socket path without removing it', async (t) => {
  const storagePath = tempDir(t)
  const socketPath = prepareSocketPath(storagePath)
  writeFileSync(socketPath, 'operator data')
  const server = createCompanionServer({ service: {}, config: udsConfig(storagePath), logger })

  await t.exception(server.start(), /not a socket/)
  t.is(existsSync(socketPath), true)
})

test('Unix startup refuses foreign or unprovable socket ownership', async (t) => {
  const storagePath = tempDir(t)
  const socketPath = prepareSocketPath(storagePath)
  const config = udsConfig(storagePath)
  const baseStat = {
    isSocket: () => true,
    dev: 1,
    ino: 1
  }
  const cases = [
    { ...baseStat, uid: process.getuid() + 1 },
    baseStat
  ]

  for (const socketStat of cases) {
    const server = createCompanionServer({
      service: {},
      config,
      logger,
      fs: {
        lstatSync (path) {
          return path === socketPath ? socketStat : statSync(path)
        }
      }
    })
    await t.exception(server.start(), /not owned by the current user/)
  }
})

test('Unix startup rejects a socket namespace writable by other users', async (t) => {
  const storagePath = tempDir(t)
  const socketDirectory = join(storagePath, 'insecure')
  mkdirSync(socketDirectory)
  chmodSync(socketDirectory, 0o755)
  const config = udsConfig(storagePath, {
    socketPath: join(socketDirectory, 'control.sock')
  })
  const server = createCompanionServer({ service: {}, config, logger })
  t.teardown(() => server.close().catch(noop))

  await t.exception(server.start(), /socket directory must be owner-only/)
})

test('Unix startup rejects socket paths beyond the portable byte limit', async (t) => {
  const storagePath = tempDir(t)
  const config = udsConfig(storagePath, {
    socketPath: join(storagePath, 'x'.repeat(100), 's')
  })
  const server = createCompanionServer({ service: {}, config, logger })

  await t.exception(server.start(), /at most 103 bytes/)
})

test('Unix startup refuses a symlink without touching its target', async (t) => {
  const storagePath = tempDir(t)
  const targetPath = join(storagePath, 'operator-data')
  const socketPath = prepareSocketPath(storagePath)
  writeFileSync(targetPath, 'operator data')
  symlinkSync(targetPath, socketPath)
  const server = createCompanionServer({ service: {}, config: udsConfig(storagePath), logger })

  await t.exception(server.start(), /not a socket/)
  t.is(existsSync(targetPath), true)
  t.is(existsSync(socketPath), true)
})

test('Unix startup refuses an existing live socket without unlinking it', async (t) => {
  const storagePath = tempDir(t)
  const socketPath = prepareSocketPath(storagePath)
  const live = createHttpServer((req, res) => res.end('live'))
  await listen(live, socketPath)
  t.teardown(() => close(live).catch(noop))

  const server = createCompanionServer({ service: {}, config: udsConfig(storagePath), logger })
  await t.exception(server.start(), /already in use/)

  const response = await request({ socketPath })
  t.is(response.statusCode, 200)
  t.is(response.body, 'live')
  await close(live)
})

test('Unix startup unlinks a proven stale same-owner socket', async (t) => {
  const storagePath = tempDir(t)
  const socketPath = prepareSocketPath(storagePath)
  const child = spawn(process.execPath, [
    '-e',
    [
      "const { createServer } = require('node:http')",
      'const server = createServer((request, response) => response.end())',
      "server.listen(process.argv[1], () => process.send('listening'))"
    ].join(';'),
    socketPath
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.teardown(() => child.kill('SIGKILL'))
  await once(child, 'message')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  t.ok(statSync(socketPath).isSocket())

  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  const response = await request({
    socketPath: state.socketPath,
    headers: signedHeaders({ nonce: 'stale-nonce-0001' })
  })
  t.is(response.statusCode, 200)
  await server.close()
})

test('enabled Unix configuration fails closed without a shared secret', (t) => {
  const storagePath = tempDir(t)
  t.exception(() => resolveCompanionConfig({
    enabled: true,
    transport: 'unix',
    client: CLIENT,
    sharedSecret: ''
  }, { storagePath }), /sharedSecret is required/)
})

test('TCP startup fails closed without a configured shared secret', async (t) => {
  const config = resolveCompanionConfig({
    enabled: false,
    transport: 'tcp',
    host: '127.0.0.1',
    port: 0,
    client: CLIENT
  }, { storagePath: tempDir(t) })
  config.enabled = true
  const server = createCompanionServer({ service: {}, config, logger })

  await t.exception(server.start(), /64 lowercase hexadecimal characters/)
})

test('explicit authenticated TCP serves only signed requests', async (t) => {
  const config = resolveCompanionConfig({
    enabled: true,
    transport: 'tcp',
    host: '127.0.0.1',
    port: 0,
    client: CLIENT,
    sharedSecret: SECRET
  }, { storagePath: tempDir(t) })
  const server = createCompanionServer({ service: {}, config, clock: () => NOW, logger })
  const state = await server.start()

  const valid = await request({ host: state.host, port: state.port, headers: signedHeaders({ nonce: 'tcp-nonce-000001' }) })
  const unsigned = await request({ host: state.host, port: state.port })
  t.is(valid.statusCode, 200)
  t.is(unsigned.statusCode, 401)
  t.is(JSON.stringify(state).includes(SECRET), false)
  await server.close()
})

test('companion serializes concurrent direct starts around one listener', async (t) => {
  const config = resolveCompanionConfig({
    enabled: true,
    transport: 'tcp',
    host: '127.0.0.1',
    port: 0,
    client: CLIENT,
    sharedSecret: SECRET
  }, { storagePath: tempDir(t) })
  const listeners = []
  const server = createCompanionServer({
    service: {},
    config,
    logger,
    createServer (handler) {
      const listener = createHttpServer(handler)
      listeners.push(listener)
      return listener
    }
  })
  t.teardown(async () => {
    await server.close().catch(noop)
    for (const listener of listeners) {
      if (listener.listening) await close(listener)
    }
  })

  const [first, second] = await Promise.all([server.start(), server.start()])
  t.is(listeners.length, 1)
  t.alike(first, second)
  await server.close()
  const restarted = await server.start()
  t.is(listeners.length, 2)
  t.is(restarted.enabled, true)
  await server.close()
})

test('companion close waits for a direct start in progress and owns its listener', async (t) => {
  const config = resolveCompanionConfig({
    enabled: true,
    transport: 'tcp',
    host: '127.0.0.1',
    port: 0,
    client: CLIENT,
    sharedSecret: SECRET
  }, { storagePath: tempDir(t) })
  const listener = new EventEmitter()
  let releaseListen = null
  let closed = false
  listener.listening = false
  listener.listen = () => {
    releaseListen = () => {
      listener.listening = true
      listener.emit('listening')
    }
  }
  listener.address = () => ({ address: '127.0.0.1', port: 12345 })
  listener.close = (callback) => {
    listener.listening = false
    closed = true
    callback()
  }
  const server = createCompanionServer({
    service: {},
    config,
    logger,
    createServer: () => listener
  })

  const starting = server.start()
  const closing = server.close()
  let closeSettled = false
  void closing.then(() => { closeSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  t.is(closeSettled, false)
  releaseListen()
  const [startResult, closeResult] = await Promise.allSettled([starting, closing])
  t.is(startResult.status, 'fulfilled')
  t.is(closeResult.status, 'fulfilled')
  t.is(closed, true)
})

test('companion restart binds again after guarded Unix cleanup fails', async (t) => {
  const storagePath = tempDir(t)
  const socketDirectory = join(storagePath, '.pt')
  const movedDirectory = join(storagePath, '.pt-old')
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath),
    logger
  })
  const first = await server.start()
  renameSync(socketDirectory, movedDirectory)
  mkdirSync(socketDirectory, { mode: 0o700 })

  await t.exception(server.close(), /socket namespace changed/)
  t.is(existsSync(first.socketPath), false)
  const restarted = await server.start()
  t.is(restarted.enabled, true)
  t.is(existsSync(restarted.socketPath), true)
  await server.close()
})

test('oversized bodies are rejected before v2 dispatch without buffering beyond the configured limit', async (t) => {
  const storagePath = tempDir(t)
  const body = '12345'
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath, { maxBodyBytes: 4 }),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  const response = await request({
    socketPath: state.socketPath,
    method: 'POST',
    path: '/api/v2/search',
    body,
    headers: signedHeaders({
      method: 'POST',
      path: '/api/v2/search',
      body,
      nonce: 'large-nonce-0001'
    })
  })

  t.is(response.statusCode, 413)
  t.is(JSON.parse(response.body).error.code, 'REQUEST_TOO_LARGE')
  await server.close()
})

test('missing authentication is rejected before an oversized body is read', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: udsConfig(storagePath, { maxBodyBytes: 4 }),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  const response = await request({
    socketPath: state.socketPath,
    method: 'POST',
    path: '/api/v2/search',
    body: '12345'
  })

  t.is(response.statusCode, 401)
  t.is(JSON.parse(response.body).error.code, 'AUTH_REQUIRED')
  await server.close()
})

test('authenticated search reaches the backend and returns URL-free candidates', async (t) => {
  const storagePath = tempDir(t)
  let selector = null
  const service = {
    async search ({ selector: value }) {
      selector = value
      return { candidates: [{
        candidateRef: 'A'.repeat(43),
        work: { title: 'The Matrix', releaseYear: 1999 },
        publication: { publicationId: 'publication-1', publisherId: 'publisher-1' },
        rendition: { renditionId: 'rendition-1' },
        asset: { assetId: 'asset-1' },
        streamUrl: 'https://forbidden.invalid/stream'
      }] }
    }
  }
  const server = createCompanionServer({ service, config: udsConfig(storagePath), clock: () => NOW, logger })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const response = await request({
    socketPath: state.socketPath,
    path,
    headers: signedHeaders({ path, nonce: 'search-nonce-0001' })
  })

  t.is(response.statusCode, 200)
  t.alike(selector, { namespace: 'tmdb', identifier: '348', kind: 'movie' })
  t.is(JSON.parse(response.body).candidates[0].candidateRef, 'A'.repeat(43))
  t.not(response.body.includes('forbidden.invalid'), true)
  await server.close()
})

test('authenticated search sends the provider only the fields its contract accepts', async (t) => {
  const storagePath = tempDir(t)
  let received = null
  const service = {
    // The provider service validates search with a closed field list. Anything
    // extra is refused as INVALID_FIELD, which the companion maps to a 502 - so
    // a fake that shrugs at unknown fields hides a broken route.
    async search (request) {
      received = Object.keys(request).sort()
      for (const field of received) {
        if (!['selector', 'limit', 'cursor', 'signal'].includes(field)) {
          const error = new Error(`request.${field} is unsupported`)
          error.code = 'INVALID_FIELD'
          throw error
        }
      }
      return { candidates: [] }
    }
  }
  const server = createCompanionServer({ service, config: udsConfig(storagePath), clock: () => NOW, logger })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const response = await request({
    socketPath: state.socketPath,
    path,
    headers: signedHeaders({ path, nonce: 'search-nonce-0002' })
  })

  t.is(response.statusCode, 200, 'the search reaches the provider instead of failing as a backend error')
  t.absent(received.includes('principal'), 'the principal authorizes the call and never rides in the query')
  await server.close()
})

test('real relay companion forwards movie limits and episode coordinates alike', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-search-service-')
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, client: CLIENT, sharedSecret: SECRET },
    archive: { enabled: false, uiEnabled: false, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] }
  }, { env: {} })
  const runtime = fakeRuntime()
  let searches = 0
  let options = null
  let selector = null
  runtime.api.searchIndexCandidates = async (value, searchOptions) => {
    searches++
    selector = value
    options = searchOptions
    return []
  }
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => runtime,
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  await service.start()
  const state = service.getCompanionState()

  const moviePath = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie&limit=1'
  const movie = await request({
    socketPath: state.socketPath,
    path: moviePath,
    headers: signedHeaders({ path: moviePath, timestamp: Date.now(), nonce: 'real-movie-nonce-0001' })
  })
  t.is(movie.statusCode, 200)
  t.is(options.limit, 1)

  const episodePath = '/api/v2/search?namespace=tmdb&identifier=1399&kind=episode&season=1&episode=2&limit=4'
  const episode = await request({
    socketPath: state.socketPath,
    path: episodePath,
    headers: signedHeaders({ path: episodePath, timestamp: Date.now(), nonce: 'real-episode-nonce-01' })
  })
  t.is(episode.statusCode, 200)
  t.alike(JSON.parse(episode.body), { candidates: [], cursor: null })
  t.alike(selector, { namespace: 'tmdb', identifier: '1399', kind: 'episode', season: 1, episode: 2 })
  t.is(options.limit, 4)
  t.is(searches, 2)
  await service.close()
})

test('authenticated routes return a deterministic bounded capability error when their backend is absent', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({ service: {}, config: udsConfig(storagePath), clock: () => NOW, logger })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const response = await request({
    socketPath: state.socketPath,
    path,
    headers: signedHeaders({ path, nonce: 'route-nonce-00001' })
  })

  t.is(response.statusCode, 501)
  t.alike(JSON.parse(response.body), {
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Index search capability is unavailable' }
  })
  t.ok(Buffer.byteLength(response.body) < 512)
  await server.close()
})

test('authenticated policy control reaches ProviderService', async (t) => {
  const storagePath = tempDir(t)
  const applied = []
  const service = {
    async setPolicy ({ policy }) {
      applied.push(structuredClone(policy))
      return { policy: { ...policy, effectiveRole: 'contributor' } }
    }
  }
  const server = createCompanionServer({
    service,
    config: udsConfig(storagePath),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  const path = '/api/v2/policy'
  const policy = {
    policyVersion: 2,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: false,
    contributionBudgetBytes: 4096,
    archiveBudgetBytes: 0,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 4096
  }
  const body = JSON.stringify(policy)
  const response = await request({
    socketPath: state.socketPath,
    method: 'PUT',
    path,
    body,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...signedHeaders({ method: 'PUT', path, body, nonce: 'policy-control-0001' })
    }
  })
  t.is(response.statusCode, 200)
  t.alike(applied, [policy])
  t.is(JSON.parse(response.body).policy.effectiveRole, 'contributor')
  await server.close()
})

test('relay service closes its companion socket during lifecycle teardown', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-service-')
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, client: CLIENT, sharedSecret: SECRET },
    archive: { enabled: false, uiEnabled: false, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] }
  }, { env: {} })
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => fakeRuntime(),
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })

  await service.start()
  const state = service.getCompanionState()
  t.is(existsSync(state.socketPath), true)
  t.is(JSON.stringify(state).includes(SECRET), false)
  t.is(await service.start(), service)
  t.is(service.getCompanionState().socketPath, state.socketPath)

  await service.close()
  t.is(existsSync(state.socketPath), false)
})

test('relay startup failure closes an already-started companion', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-failed-service-')
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, client: CLIENT, sharedSecret: SECRET },
    archive: { enabled: false, uiEnabled: false, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] }
  }, { env: {} })
  const runtime = fakeRuntime()
  runtime.start = async () => { throw new Error('runtime failed') }
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => runtime,
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })

  await t.exception(service.start(), /runtime failed/)
  t.is(existsSync(config.companion.socketPath), false)
})

test('TCP companion and archive UI use separate listeners and only v2 is machine-addressable', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-separate-')
  const surface = createArchiveHttpSurface({ host: '127.0.0.1', port: 0, logger })
  t.teardown(() => surface.close().catch(noop))
  const uiPort = await surface.listen()
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, transport: 'tcp', host: '127.0.0.1', port: 0, client: CLIENT, sharedSecret: SECRET },
    archive: { enabled: false, uiEnabled: true, uiHost: '127.0.0.1', uiPort, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] }
  }, { env: {} })
  const runtime = fakeRuntime()
  runtime.ctx.metaDb = fakeMetaDb()
  runtime.api.getMediaCatalog = async () => ({ success: true, items: [], nextCursor: null })
  runtime.api.searchIndexCandidates = async () => []
  const service = await createRelayService({
    config,
    logger,
    archiveHttp: surface,
    runtimeFactory: async () => runtime,
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  t.teardown(() => service.close().catch(noop))
  await service.start()

  const state = service.getCompanionState()
  t.is(state.transport, 'tcp')
  t.not(state.port, uiPort, 'the authenticated machine API binds its configured listener')

  const signed = await request({
    host: '127.0.0.1',
    port: state.port,
    headers: signedHeaders({ timestamp: Date.now(), nonce: 'separate-listener-0001' })
  })
  t.is(signed.statusCode, 200)

  const unsigned = await request({ host: '127.0.0.1', port: state.port })
  t.is(unsigned.statusCode, 401, 'v2 control routes remain MAC-authenticated')
  t.is(JSON.parse(unsigned.body).error.code, 'AUTH_REQUIRED')

  const legacy = await request({ host: '127.0.0.1', port: uiPort, path: '/api/v1/catalog' })
  t.is(legacy.statusCode, 404, 'the archive UI listener exposes no legacy machine API')
  const health = await request({ host: '127.0.0.1', port: uiPort, path: '/health' })
  t.alike(JSON.parse(health.body), { ok: true, ready: true })
})

test('Bare serves authenticated companion HTTP over a Unix socket', (t) => {
  const bareName = process.platform === 'win32' ? 'bare.cmd' : 'bare'
  const bareCandidates = [
    join(packageRoot, '..', '..', 'node_modules', '.bin', bareName),
    join(packageRoot, 'node_modules', '.bin', bareName)
  ]
  const bare = bareCandidates.find((candidate) => existsSync(candidate)) || bareCandidates[0]
  const fixture = join(__dirname, 'fixtures', 'companion-bare-uds.mjs')
  const spawnTarget = existsSync(bare) ? process.execPath : bare
  const spawnArgs = spawnTarget === process.execPath ? [bare, fixture] : [fixture]
  const result = spawnSync(spawnTarget, spawnArgs, {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 10_000
  })
  const bareStdout = String(result.stdout || '')
  const bareStderr = String(result.stderr || '')
  const detail = result.error ? `launcher error: ${result.error.message}` : (bareStderr || bareStdout || `exit code ${result.status}`)
  t.is(result.status, 0, `Bare companion execution status: ${detail}`)
  t.is(bareStdout.trim(), 'bare-companion-uds-ok', `Bare companion output: ${detail}`)
})
