import test from 'brittle'
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
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

function request ({ host, port, method = 'GET', path = '/api/v2/status', body = '', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, method, path, headers }, (res) => {
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

function tcpConfig (storagePath, overrides = {}) {
  return resolveCompanionConfig({
    enabled: true,
    auth: true,
    host: '127.0.0.1',
    port: 0,
    client: CLIENT,
    sharedSecret: SECRET,
    ...overrides
  }, { storagePath })
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

test('companion defaults disabled with loopback HTTP transport', (t) => {
  const storagePath = '/var/lib/peartube-custom'
  const config = resolveRelayConfig({ storage: { path: storagePath } }, { env: {} })

  t.is(config.companion.enabled, false)
  t.is(config.companion.transport, 'tcp')
  t.is(config.companion.host, '127.0.0.1')
  t.is(config.companion.port, 8175)
  t.absent(config.companion.socketPath)
})

test('companion HTTP config honors file/env/CLI precedence and retires Unix settings', async (t) => {
  const dir = tempDir(t, 'peartube-companion-config-')
  const configPath = join(dir, 'relay.yml')
  writeFileSync(configPath, [
    'storage:',
    `  path: ${join(dir, 'from-file')}`,
    'companion:',
    '  enabled: true',
    '  transport: unix',
    '  socketPath: /tmp/retired.sock',
    '  port: 9000',
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
      PEARTUBE_COMPANION_PORT: '9001',
      PEARTUBE_COMPANION_SHARED_SECRET: SECRET
    }
  })

  t.is(config.storage.path, join(dir, 'from-env'))
  t.is(config.companion.transport, 'tcp')
  t.absent(config.companion.socketPath)
  t.is(config.companion.port, 9001)
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

test('authenticated HTTP status is bounded, unsigned is rejected, and replay conflicts', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: tcpConfig(storagePath),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  t.is(state.transport, 'tcp')
  t.is(state.host, '127.0.0.1')
  t.is(JSON.stringify(state).includes(SECRET), false)

  const headers = signedHeaders()
  const valid = await request({ host: state.host, port: state.port, headers })
  t.is(valid.statusCode, 200)
  const status = JSON.parse(valid.body)
  t.is(status.apiVersion, 2)
  t.is(status.status, 'available')
  t.is(status.transport.mode, 'tcp')
  t.is(status.auth.mode, 'mac')
  t.is(status.auth.clientId, CLIENT)
  t.ok(Buffer.byteLength(valid.body) < 256)

  const unsigned = await request({ host: state.host, port: state.port })
  t.is(unsigned.statusCode, 401)
  t.is(JSON.parse(unsigned.body).error.code, 'AUTH_REQUIRED')
  t.ok(Buffer.byteLength(unsigned.body) < 512)

  const replay = await request({ host: state.host, port: state.port, headers })
  t.is(replay.statusCode, 409)
  t.is(JSON.parse(replay.body).error.code, 'NONCE_REPLAY')

  await server.close()
})

test('loopback HTTP can attach a private source grant without echoing it', async (t) => {
  const storagePath = tempDir(t)
  let attached = null
  const server = createCompanionServer({
    service: {
      async attachSourceGrant (input) {
        attached = input
        return {
          schemaVersion: 1,
          acquisitionId: 'acq-loopback-1',
          state: 'queued',
          retentionClass: 'archive-pin',
          bytesAcquired: 0,
          expectedBytes: 0,
          recoverable: false,
          createdAt: NOW,
          updatedAt: NOW
        }
      }
    },
    config: tcpConfig(storagePath),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  const path = '/api/v2/acquisitions/acq-loopback-1/source-grants'
  const body = JSON.stringify({ grant: { token: 'private-token', url: 'https://private.invalid/media' } })
  const response = await request({
    host: state.host,
    port: state.port,
    method: 'POST',
    path,
    body,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...signedHeaders({ method: 'POST', path, body, nonce: 'loopback-grant-001' })
    }
  })

  t.is(response.statusCode, 200)
  t.is(attached.grant.token, 'private-token')
  t.absent(response.body.includes('private-token'))
  t.absent(response.body.includes('private.invalid'))
  await server.close()
})

test('unified public API requires verified signatures for non-loopback source grants', async (t) => {
  let accepted = 0
  const config = tcpConfig(tempDir(t), { auth: false })
  const server = createCompanionServer({
    config,
    clock: () => NOW,
    logger,
    service: {
      async attachSourceGrant () {
        accepted++
        return {
          schemaVersion: 1,
          acquisitionId: 'acq-shared-port',
          state: 'queued',
          retentionClass: 'archive-pin',
          bytesAcquired: 0,
          expectedBytes: 0,
          recoverable: false,
          createdAt: NOW,
          updatedAt: NOW
        }
      }
    }
  })
  // Model the Docker bridge peer seen by the shared HTTP listener.
  const surface = createHttpServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.10' })
    server.handleRequest(req, res)
  })
  await listen(surface, { host: '127.0.0.1', port: 0 })
  t.teardown(async () => { await close(surface); await server.close() })
  const address = { host: '127.0.0.1', port: surface.address().port }
  const path = '/api/v2/acquisitions/acq-shared-port/source-grants'
  const body = JSON.stringify({ grant: { token: 'private-shared-port-token' } })
  const headers = { 'content-type': 'application/json' }
  const send = (extraHeaders = {}, content = body) => request({
    ...address, method: 'POST', path, body: content, headers: { ...headers, ...extraHeaders }
  })

  t.is((await request(address)).statusCode, 200, 'public status stays unsigned on the same listener')
  t.is((await send({ 'x-forwarded-for': '127.0.0.1' })).statusCode, 401, 'claimed loopback is not authority')
  t.is(accepted, 0, 'unsigned grants never reach the acquisition service')
  const signature = signedHeaders({ method: 'POST', path, body, nonce: 'shared-port-grant-001' })
  const valid = await send(signature)
  t.is(valid.statusCode, 200, 'verified grant reaches the shared-port acquisition route')
  t.absent(valid.body.includes('private-shared-port-token'), 'source capability stays private')
  t.is((await send(signature)).statusCode, 409, 'signed grants cannot be replayed')
  const modified = signedHeaders({ method: 'POST', path, body, nonce: 'shared-port-grant-002' })
  t.is((await send(modified, body.replace('private-shared-port-token', 'changed-token'))).statusCode, 401, 'signature binds the grant body')
  config.sharedSecret = ''
  t.is((await send(signedHeaders({ method: 'POST', path, body, nonce: 'shared-port-grant-003' }))).statusCode, 401, 'missing credentials fail closed')
  t.is(accepted, 1, 'only the verified, unreplayed grant was accepted')
})

test('companion close terminates an in-flight HTTP request', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: tcpConfig(storagePath),
    logger
  })
  const state = await server.start()
  const socket = createConnection({ host: state.host, port: state.port })
  socket.on('error', noop)
  await once(socket, 'connect')
  const socketClosed = new Promise((resolve) => socket.once('close', resolve))
  socket.write(partialSignedRequest('close-nonce-0001'))

  await server.close()
  await socketClosed
})

test('companion enforces an absolute in-flight request deadline', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: tcpConfig(storagePath),
    clock: () => NOW,
    logger,
    requestDeadlineMs: 20
  })
  const state = await server.start()
  t.teardown(() => server.close().catch(noop))
  const socket = createConnection({ host: state.host, port: state.port })
  socket.on('error', noop)
  t.teardown(() => socket.destroy())
  await once(socket, 'connect')
  socket.write(partialSignedRequest('deadline-nonce-01'))
  await Promise.race([
    new Promise((resolve) => socket.once('close', resolve)),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('request deadline did not close the socket')), 250))
  ])
  t.pass('deadline closes the in-flight request')
})

test('companion closes a connection that never completes its first request headers', async (t) => {
  const storagePath = tempDir(t)
  const server = createCompanionServer({
    service: {},
    config: tcpConfig(storagePath),
    logger,
    requestDeadlineMs: 20
  })
  const state = await server.start()
  t.teardown(() => server.close().catch(noop))
  const socket = createConnection({ host: state.host, port: state.port })
  socket.on('error', noop)
  t.teardown(() => socket.destroy())
  await once(socket, 'connect')
  await Promise.race([
    new Promise((resolve) => socket.once('close', resolve)),
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
    config: tcpConfig(storagePath),
    clock: () => NOW,
    logger,
    requestDeadlineMs: 20
  })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const requestResult = request({
    host: state.host,
    port: state.port,
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

test('enabled HTTP configuration fails closed without a shared secret', (t) => {
  const storagePath = tempDir(t)
  t.exception(() => resolveCompanionConfig({
    enabled: true,
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
  const surface = createHttpServer(server.handleRequest)
  await listen(surface, { host: '127.0.0.1', port: 0 })
  t.teardown(() => close(surface))
  const port = surface.address().port
  server.setPublicAddress({ host: '127.0.0.1', port })
  const after = await request({ host: '127.0.0.1', port, path: '/api/v2/status' })
  t.is(after.statusCode, 503, 'an overlapping start cannot reopen the closed mounted surface')
  t.is(JSON.parse(after.body).error?.code, 'SERVER_CLOSING')
  await t.exception(server.dispatchInProcess({ url: '/api/v2/status' }))
})

test('oversized bodies are rejected before v2 dispatch without buffering beyond the configured limit', async (t) => {
  const storagePath = tempDir(t)
  const body = '12345'
  const server = createCompanionServer({
    service: {},
    config: tcpConfig(storagePath, { maxBodyBytes: 4 }),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  const response = await request({
    host: state.host,
    port: state.port,
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
    config: tcpConfig(storagePath, { maxBodyBytes: 4 }),
    clock: () => NOW,
    logger
  })
  const state = await server.start()
  const response = await request({
    host: state.host,
    port: state.port,
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
  const server = createCompanionServer({ service, config: tcpConfig(storagePath), clock: () => NOW, logger })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const response = await request({
    host: state.host,
    port: state.port,
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
  const server = createCompanionServer({ service, config: tcpConfig(storagePath), clock: () => NOW, logger })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const response = await request({
    host: state.host,
    port: state.port,
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
    companion: { enabled: true, port: 0, client: CLIENT, sharedSecret: SECRET },
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
    host: state.host,
    port: state.port,
    path: moviePath,
    headers: signedHeaders({ path: moviePath, timestamp: Date.now(), nonce: 'real-movie-nonce-0001' })
  })
  t.is(movie.statusCode, 200)
  t.is(options.limit, 1)

  const episodePath = '/api/v2/search?namespace=tmdb&identifier=1399&kind=episode&season=1&episode=2&limit=4'
  const episode = await request({
    host: state.host,
    port: state.port,
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
  const server = createCompanionServer({ service: {}, config: tcpConfig(storagePath), clock: () => NOW, logger })
  const state = await server.start()
  const path = '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'
  const response = await request({
    host: state.host,
    port: state.port,
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
    config: tcpConfig(storagePath),
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
    host: state.host,
    port: state.port,
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

test('relay service closes its companion HTTP listener during lifecycle teardown', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-service-')
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, port: 0, client: CLIENT, sharedSecret: SECRET },
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
  t.is(state.transport, 'tcp')
  t.is(JSON.stringify(state).includes(SECRET), false)
  t.is(await service.start(), service)
  t.alike(service.getCompanionState(), state)

  await service.close()
  const closed = await request({ host: state.host, port: state.port }).then(() => false, () => true)
  t.is(closed, true)
})

test('relay startup failure closes an already-started companion', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-failed-service-')
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, port: 0, client: CLIENT, sharedSecret: SECRET },
    archive: { enabled: false, uiEnabled: false, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] }
  }, { env: {} })
  const runtime = fakeRuntime()
  runtime.start = async () => { throw new Error('runtime failed') }
  let companionState = null
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => runtime,
    companionServerFactory: async (options) => {
      const server = createCompanionServer(options)
      const start = server.start
      server.start = async () => {
        companionState = await start()
        return companionState
      }
      return server
    },
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })

  await t.exception(service.start(), /runtime failed/)
  const closed = await request({ host: companionState.host, port: companionState.port }).then(() => false, () => true)
  t.is(closed, true)
})

test('TCP companion and archive UI use separate listeners and only v2 is machine-addressable', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-separate-')
  const surface = createArchiveHttpSurface({ host: '127.0.0.1', port: 0, logger })
  t.teardown(() => surface.close().catch(noop))
  const uiPort = await surface.listen()
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, auth: true, transport: 'tcp', host: '127.0.0.1', port: 0, client: CLIENT, sharedSecret: SECRET },
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
test('companion v2 API is accessible on unified archive UI port when companion port is not explicitly set', async (t) => {
  const storagePath = tempDir(t, 'peartube-companion-unified-')
  const surface = createArchiveHttpSurface({ host: '127.0.0.1', port: 0, logger })
  t.teardown(() => surface.close().catch(noop))
  const uiPort = await surface.listen()
  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    companion: { enabled: true, client: CLIENT },
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
  t.is(state.port, uiPort, 'companion state reports the unified UI port')
  const unsigned = await request({ host: '127.0.0.1', port: uiPort })
  t.is(unsigned.statusCode, 200, 'v2 status is reachable without authentication (nostr relay style)')
  const statusBody = JSON.parse(unsigned.body)
  t.is(statusBody.apiVersion, 2)
  t.alike(statusBody.transport, { mode: 'tcp', enabled: true, host: '127.0.0.1', port: uiPort })
  t.ok(statusBody.status, 'returns status payload')
  t.alike(statusBody.auth, { mode: 'none' }, 'status reports auth mode none in open relay mode')

  const search = await request({ host: '127.0.0.1', port: uiPort, path: '/api/v2/search?kind=movie&title=test' })
  t.is(search.statusCode, 200, 'v2 search is reachable without authentication')
})


test('auth-off relay verifies supplied credentials, denies remote unsigned mutations, and fails closed on broken authentication', async (t) => {
  const config = tcpConfig(tempDir(t), { auth: false })
  const seen = []
  const service = {
    async listAcquisitions ({ principal }) {
      seen.push(['list', { id: principal.id, isAuthenticated: principal.isAuthenticated }])
      return { items: [], nextCursor: null }
    },
    async search () {
      seen.push(['search'])
      return { candidates: [] }
    },
    async setPolicy ({ principal, policy }) {
      seen.push(['policy', { id: principal.id, isAuthenticated: principal.isAuthenticated }])
      return { policy: { ...policy, effectiveRole: 'seed' } }
    },
    async requestAcquisition ({ principal }) {
      seen.push(['acquire', { id: principal.id }])
      return {
        schemaVersion: 1,
        acquisitionId: 'acq-authoff-1',
        state: 'queued',
        retentionClass: 'archive-pin',
        bytesAcquired: 0,
        expectedBytes: null,
        recoverable: false,
        createdAt: NOW,
        updatedAt: NOW
      }
    },
    issueLocalResolution () {
      seen.push(['resolve'])
      return { resolutionRef: 'A'.repeat(43) }
    }
  }
  const server = createCompanionServer({ service, config, clock: () => NOW, logger })
  const surface = createHttpServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.10' })
    server.handleRequest(req, res)
  })
  await listen(surface, { host: '127.0.0.1', port: 0 })
  t.teardown(async () => { await close(surface); await server.close().catch(noop) })
  const address = { host: '127.0.0.1', port: surface.address().port }
  const send = (method, path, body = '', headers = {}) => request({ ...address, method, path, body, headers })
  const policyBody = JSON.stringify({
    policyVersion: 2,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: false,
    contributionBudgetBytes: 4096,
    archiveBudgetBytes: 0,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 4096
  })
  const acquisitionBodyText = JSON.stringify({
    idempotencyKey: 'authoff-1',
    request: { schemaVersion: 1, resolutionRef: 'A'.repeat(43), publisherId: 'publisher-1', retentionClass: 'archive-pin' }
  })

  const unsignedList = await send('GET', '/api/v2/acquisitions')
  t.is(unsignedList.statusCode, 200, 'public reads stay unsigned')
  t.alike(seen.at(-1)[1], { id: CLIENT, isAuthenticated: false }, 'an anonymous caller gets the fixed configured identity')

  const spoofed = await send('GET', '/api/v2/acquisitions', '', { 'x-peartube-client': 'spoofed-machine' })
  t.is(spoofed.statusCode, 401, 'partial control authentication is rejected, never an anonymous fallback')
  t.is(JSON.parse(spoofed.body).error?.code, 'AUTH_REQUIRED')

  const wrongTarget = signedHeaders({ method: 'GET', path: '/api/v2/status', nonce: 'authoff-wrong-0001' })
  const invalidOptional = await send('GET', '/api/v2/search?namespace=tmdb&identifier=348&kind=movie', '', wrongTarget)
  t.is(invalidOptional.statusCode, 401, 'supplied authentication is verified on every route, not ignored')
  t.is(JSON.parse(invalidOptional.body).error?.code, 'INVALID_MAC')

  const unsignedPolicy = await send('PUT', '/api/v2/policy', policyBody)
  t.is(unsignedPolicy.statusCode, 403, 'remote unsigned policy write is denied by routing')
  t.is(JSON.parse(unsignedPolicy.body).error?.code, 'PRIVATE_ROUTE_REQUIRES_AUTHENTICATION')
  const unsignedAcquire = await send('POST', '/api/v2/acquisitions', acquisitionBodyText)
  t.is(unsignedAcquire.statusCode, 403)
  const unsignedContribute = await send('POST', '/api/v2/acquisitions/contribute', JSON.stringify({
    idempotencyKey: 'authoff-contrib-1',
    title: 'The Matrix',
    selector: { kind: 'movie', namespace: 'tmdb', identifier: '603' },
    expectedBytes: 2048,
    retentionClass: 'contribution-cache',
    sourceFileName: 'matrix.mkv'
  }))
  t.is(unsignedContribute.statusCode, 403, 'the contribute mutation variant is denied too')
  t.is(seen.some(([name]) => ['policy', 'acquire', 'resolve'].includes(name)), false, 'no unsigned mutation reached the service')

  const signedPolicy = await send('PUT', '/api/v2/policy', policyBody,
    signedHeaders({ method: 'PUT', path: '/api/v2/policy', body: policyBody, nonce: 'authoff-policy-0001' }))
  t.is(signedPolicy.statusCode, 200, 'a verified mutation is admitted on the auth-off listener')
  t.is(JSON.parse(signedPolicy.body).policy.effectiveRole, 'seed')
  t.alike(seen.at(-1)[1], { id: CLIENT, isAuthenticated: true })
  const signedAcquire = await send('POST', '/api/v2/acquisitions', acquisitionBodyText,
    signedHeaders({ method: 'POST', path: '/api/v2/acquisitions', body: acquisitionBodyText, nonce: 'authoff-acq-00001' }))
  t.is(signedAcquire.statusCode, 202)
})

test('mounted companion tracks exported handleRequest traffic, serves in-process dispatch, and close drains without the foreign listener', async (t) => {
  const config = tcpConfig(tempDir(t), { auth: false })
  let searches = 0
  let sawAbort = 0
  const service = {
    search ({ signal }) {
      searches++
      return new Promise((resolve, reject) => {
        signal?.addEventListener?.('abort', () => {
          sawAbort++
          reject(new Error('backend aborted'))
        }, { once: true })
      })
    },
    async getStatus () { return { ready: true } }
  }
  let drained = false
  const capabilities = {
    issue () { throw new Error('capability issuance is not part of this test') },
    consume () { throw new Error('capability consumption is not part of this test') },
    close () { return false },
    clear () {},
    async drain () {
      drained = true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const server = createCompanionServer({ service, config, clock: () => NOW, logger, capabilities })
  const surface = createHttpServer((req, res) => {
    if (req.url.startsWith('/api/v2/')) {
      void server.handleRequest(req, res)
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true,"ready":true}')
  })
  await listen(surface, { host: '127.0.0.1', port: 0 })
  const port = surface.address().port
  t.teardown(async () => { await server.close().catch(noop); await close(surface) })

  server.setPublicAddress({ host: '127.0.0.1', port })
  const mounted = await server.dispatchInProcess({ url: '/api/v2/status' })
  t.is(mounted.statusCode, 200, 'in-process dispatch is usable when mounted without start()')

  const searchPath = kind => `/api/v2/search?namespace=tmdb&identifier=${kind}&kind=movie`
  const first = request({ host: '127.0.0.1', port, path: searchPath(1) })
  const second = request({ host: '127.0.0.1', port, path: searchPath(2) })
  await new Promise(resolve => setTimeout(resolve, 30))
  t.is(searches, 2, 'both mounted requests reached the backend')

  const closing = server.close()
  const late = await request({ host: '127.0.0.1', port, path: '/api/v2/status' })
  t.is(late.statusCode, 503, 'close rejects new admission while draining')
  t.is(JSON.parse(late.body).error?.code, 'SERVER_CLOSING')

  const [firstResponse, secondResponse] = await Promise.all([first, second, closing])
  t.is(firstResponse.statusCode, 499, 'close aborted the first mounted backend call')
  t.is(secondResponse.statusCode, 499, 'close aborted the second mounted backend call')
  t.is(sawAbort, 2)
  t.is(drained, true, 'close drained capabilities even without an owned listener')
  t.is(surface.listening, true, 'companion close left the foreign archive listener open')
  const remaining = await request({ host: '127.0.0.1', port, path: '/health' })
  t.is(remaining.statusCode, 200, 'the shared archive route still serves after companion close')
  const refused = await server.dispatchInProcess({ url: '/api/v2/status' }).then(() => false, () => true)
  t.is(refused, true, 'in-process admission is rejected once the surface is closed')
})

test('companion close denies admission after completion until an explicit restart', async (t) => {
  const config = tcpConfig(tempDir(t), { auth: false })
  const service = { async getStatus () { return { ready: true } } }
  const server = createCompanionServer({ service, config, clock: () => NOW, logger })
  const surface = createHttpServer((req, res) => {
    void server.handleRequest(req, res)
  })
  await listen(surface, { host: '127.0.0.1', port: 0 })
  const port = surface.address().port
  t.teardown(async () => { await server.close().catch(noop); await close(surface) })

  server.setPublicAddress({ host: '127.0.0.1', port })
  await server.close()

  const after = await request({ host: '127.0.0.1', port, path: '/api/v2/status' })
  t.is(after.statusCode, 503, 'requests after close completes are refused, not admitted')
  t.is(JSON.parse(after.body).error?.code, 'SERVER_CLOSING')
  const refusedInProcess = await server.dispatchInProcess({ url: '/api/v2/status' }).then(() => false, () => true)
  t.is(refusedInProcess, true, 'in-process admission stays denied after close completes')

  server.setPublicAddress({ host: '127.0.0.1', port })
  const resurrected = await request({ host: '127.0.0.1', port, path: '/api/v2/status' })
  t.is(resurrected.statusCode, 503, 'setPublicAddress cannot resurrect a closed service')

  const restarted = await server.start()
  t.is(restarted.enabled, true, 'an explicit start after close is a valid restart')
  const revived = await request({ host: restarted.host, port: restarted.port, path: '/api/v2/status' })
  t.is(revived.statusCode, 200, 'the restarted surface admits requests again')
})

test('supplied empty authentication headers fail closed on an auth-off relay', async (t) => {
  const config = tcpConfig(tempDir(t), { auth: false })
  const service = { async getStatus () { return { ready: true } } }
  const server = createCompanionServer({ service, config, clock: () => NOW, logger })
  const state = await server.start()
  t.teardown(() => server.close().catch(noop))

  const empty = await request({
    host: state.host,
    port: state.port,
    path: '/api/v2/status',
    headers: {
      'x-peartube-client': '',
      'x-peartube-timestamp': '',
      'x-peartube-nonce': '',
      'x-peartube-mac': ''
    }
  })
  t.is(empty.statusCode, 401, 'empty auth headers are detected as supplied, not anonymous')
  t.is(JSON.parse(empty.body).error?.code, 'AUTH_REQUIRED')

  const anonymous = await request({ host: state.host, port: state.port, path: '/api/v2/status' })
  t.is(anonymous.statusCode, 200, 'truly absent auth headers stay public reads')
})

test('Bare serves authenticated companion HTTP over loopback', (t) => {
  const bareName = process.platform === 'win32' ? 'bare.cmd' : 'bare'
  const bareCandidates = [
    join(packageRoot, 'node_modules', 'bare-runtime', 'bin', 'bare'),
    join(packageRoot, '..', '..', 'node_modules', 'bare-runtime', 'bin', 'bare'),
    join(packageRoot, 'node_modules', '.bin', bareName),
    join(packageRoot, '..', '..', 'node_modules', '.bin', bareName)
  ]
  const bare = bareCandidates.find((candidate) => existsSync(candidate)) || bareCandidates[0]
  const fixture = join(__dirname, 'fixtures', 'companion-bare-http.mjs')
  const result = spawnSync(process.execPath, [bare, fixture], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`
    }
  })
  const bareStdout = String(result.stdout || '')
  const bareStderr = String(result.stderr || '')
  const detail = result.error ? `launcher error: ${result.error.message}` : (bareStderr || bareStdout || `exit code ${result.status}`)
  t.is(result.status, 0, `Bare companion execution status: ${detail}`)
  t.is(bareStdout.trim(), 'bare-companion-http-ok', `Bare companion output: ${detail}`)
})
