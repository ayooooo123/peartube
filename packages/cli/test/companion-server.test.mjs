import test from 'brittle'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { loadRelayConfig, renderExampleConfig, resolveRelayConfig } from '../src/config.js'
import { resolveCompanionConfig } from '../src/companion/config.js'
import { signControlRequest } from '../src/companion/auth.js'
import { createCompanionServer } from '../src/companion/server.js'
import { createRelayService } from '../src/service.js'

const SECRET = 'cd'.repeat(32)
const CLIENT = 'mediastorm-test'
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

function signedHeaders ({ method = 'GET', path = '/api/v2/status', body = '', nonce = 'server-nonce-0001' } = {}) {
  return signControlRequest({
    method,
    path,
    body,
    timestamp: NOW,
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
  return {
    ctx: { metaDb: null },
    api: {},
    identityManager: {},
    uploadManager: {},
    setCandidateHandler: noop,
    async start () {},
    async close () {},
    async getDiagnostics () { return {} }
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
  t.alike(JSON.parse(valid.body), { apiVersion: 2, status: 'available', implemented: false })
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

test('authenticated but unimplemented v2 routes return a deterministic bounded response', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({ service: {}, config: udsConfig(storagePath), clock: () => NOW, logger })
  const state = await server.start()
  const path = '/api/v2/search?query=test'
  const response = await request({
    socketPath: state.socketPath,
    path,
    headers: signedHeaders({ path, nonce: 'route-nonce-00001' })
  })

  t.is(response.statusCode, 501)
  t.alike(JSON.parse(response.body), {
    error: { code: 'NOT_IMPLEMENTED', message: 'Companion v2 route is not implemented' }
  })
  t.ok(Buffer.byteLength(response.body) < 512)
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

test('Bare serves authenticated companion HTTP over a Unix socket', (t) => {
  const bare = join(process.cwd(), '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'bare.cmd' : 'bare')
  const fixture = join(process.cwd(), 'test', 'fixtures', 'companion-bare-uds.mjs')
  const result = spawnSync(bare, [fixture], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000
  })

  t.is(result.status, 0, result.error?.message || result.stderr || result.stdout)
  t.is(result.stdout?.trim(), 'bare-companion-uds-ok', result.error?.message)
})
