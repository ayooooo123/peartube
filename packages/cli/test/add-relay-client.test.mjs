import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runTerminal } from '../src/add/terminal.js'
import test from 'brittle'
import http from 'node:http'
import { createRelayClient, normalizeRelayUi, RelayClientError } from '../src/add/relay-client.js'
import { runAddCommand } from '../src/add/index.js'

// Mock archive console matching archive-console.js routes:
//   POST /archive (form) -> 303, enqueues a job (newest-first in /jobs)
//   POST /creators (form) -> 303
//   GET  /jobs -> { jobs: [...] }
function makeMockRelay ({ completeDelayMs = 0, seedJobs = [] } = {}) {
  const state = { jobs: [...seedJobs], archiveForms: [], creatorForms: [], counter: 0 }

  const readBody = (req) => new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => resolve(body))
  })

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/jobs') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jobs: state.jobs }))
      return
    }
    if (req.method === 'POST' && req.url === '/archive') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      state.archiveForms.push(form)
      const job = { id: `arch_${state.counter++}`, status: 'queued', title: form.title || null, channelName: form.channelName || 'Anonymous Archive', error: null }
      state.jobs.unshift(job)
      const complete = () => { job.status = 'completed'; job.channelKey = 'ck123'; job.videoId = 'vid456' }
      if (completeDelayMs <= 0) complete()
      else setTimeout(complete, completeDelayMs)
      res.writeHead(303, { location: '/' })
      res.end()
      return
    }
    if (req.method === 'POST' && req.url === '/creators') {
      state.creatorForms.push(Object.fromEntries(new URLSearchParams(await readBody(req))))
      res.writeHead(303, { location: '/' })
      res.end()
      return
    }
    res.writeHead(404); res.end('nope')
  })

  return { server, state }
}

async function listen (server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

test('normalizeRelayUi accepts host:port and full URLs, rejects garbage', (t) => {
  t.is(normalizeRelayUi('10.0.40.100:8174'), 'http://10.0.40.100:8174')
  t.is(normalizeRelayUi('http://relay.local:8174/'), 'http://relay.local:8174')
  t.is(normalizeRelayUi(''), null)
  t.exception(() => normalizeRelayUi('http://[bad'))
})

test('archiveAndWait posts the form, finds the NEW job by diff, and resolves completed', async (t) => {
  const { server, state } = makeMockRelay({ seedJobs: [{ id: 'arch_pre', status: 'completed' }] })
  const base = await listen(server)
  t.teardown(() => server.close())

  const client = createRelayClient(base)
  const { status, job } = await client.archiveAndWait(
    { url: 'https://cdn.example/clip.mp4', title: 'My Clip', channelName: 'Mine', publish: true },
    { pollMs: 10, timeoutMs: 4000 }
  )

  t.is(status, 'completed')
  t.is(job.id, 'arch_0', 'picked the newly-created job, not the pre-existing one')
  t.is(job.videoId, 'vid456')
  t.is(job.channelKey, 'ck123')
  t.is(state.archiveForms.length, 1)
  t.is(state.archiveForms[0].url, 'https://cdn.example/clip.mp4')
  t.is(state.archiveForms[0].publish, 'true')
  t.is(state.archiveForms[0].title, 'My Clip')
})

test('publish=false is forwarded as a string flag', async (t) => {
  const { server, state } = makeMockRelay()
  const base = await listen(server)
  t.teardown(() => server.close())
  await createRelayClient(base).archiveAndWait({ url: 'https://x/y.mp4', publish: false }, { pollMs: 10, timeoutMs: 4000 })
  t.is(state.archiveForms[0].publish, 'false')
})

test('addCreator posts to /creators', async (t) => {
  const { server, state } = makeMockRelay()
  const base = await listen(server)
  t.teardown(() => server.close())
  await createRelayClient(base).addCreator({ url: 'https://youtube.com/@chan', label: 'Chan' })
  t.is(state.creatorForms.length, 1)
  t.is(state.creatorForms[0].url, 'https://youtube.com/@chan')
  t.is(state.creatorForms[0].label, 'Chan')
})

test('unreachable relay raises a usage-coded error', async (t) => {
  const client = createRelayClient('http://127.0.0.1:1')
  await t.exception(() => client.listJobs(), RelayClientError)
})

test('runAddCommand relay-scripted mode publishes via the relay and emits JSON', async (t) => {
  const { server, state } = makeMockRelay()
  const base = await listen(server)
  t.teardown(() => server.close())

  const out = []
  const code = await runAddCommand({
    mode: 'scripted',
    query: 'https://cdn.example/movie.mp4',
    fetchUrl: 'https://cdn.example/movie.mp4',
    stdout: { write: (c) => out.push(String(c)) },
    stderr: { write: () => {} },
    flags: { relayUi: base, json: true, yes: true, title: 'A Movie' },
    env: {},
    deps: {} // truthy -> skips heavy backend loadDeps; relay path uses the real client
  })

  t.is(code, 0)
  const result = JSON.parse(out.join('').trim())
  t.is(result.status, 'published')
  t.is(result.videoId, 'vid456')
  t.is(result.channelKey, 'ck123')
  t.is(result.url, 'peartube://channel/ck123/video/vid456')
  t.is(state.archiveForms[0].url, 'https://cdn.example/movie.mp4')
})

test('runAddCommand relay-creator mode posts to /creators', async (t) => {
  const { server, state } = makeMockRelay()
  const base = await listen(server)
  t.teardown(() => server.close())

  const out = []
  const code = await runAddCommand({
    mode: 'scripted',
    query: 'https://youtube.com/@creator',
    fetchUrl: 'https://youtube.com/@creator',
    stdout: { write: (c) => out.push(String(c)) },
    stderr: { write: () => {} },
    flags: { relayUi: base, json: true, yes: true, creator: true },
    env: {},
    deps: {}
  })

  t.is(code, 0)
  t.is(JSON.parse(out.join('').trim()).status, 'queued')
  t.is(state.creatorForms.length, 1)
  t.is(state.creatorForms[0].url, 'https://youtube.com/@creator')
})

class FakeInput extends PassThrough { constructor () { super(); this.isTTY = true } setRawMode () { return this } }
class FakeOutput { constructor () { this.isTTY = true; this.columns = 100; this.rows = 30; this.chunks = [] } write (c) { this.chunks.push(String(c)); return true } }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeTmdb () {
  return {
    async search () { return [{ kind: 'movie', id: 'tmdb:movie:603', title: 'The Matrix', year: 1999, mediaId: '603', description: '', artwork: [] }] },
    async getMovie (id) { return { kind: 'channel', mediaId: String(id), title: 'The Matrix' } }
  }
}

test('runAddCommand relay-interactive: pick a title, give a source URL, relay publishes', async (t) => {
  const { server, state } = makeMockRelay()
  const base = await listen(server)
  t.teardown(() => server.close())

  const stdin = new FakeInput()
  const stderr = new FakeOutput()
  const out = []
  const done = runAddCommand({
    mode: 'interactive',
    query: 'matrix',
    stdin,
    stdout: { write: (c) => out.push(String(c)) },
    stderr,
    signals: new EventEmitter(),
    flags: { relayUi: base, noColor: true },
    env: { TMDB_API_KEY: 'k' },
    deps: { runTerminal, createTmdbProvider: fakeTmdb }
  })

  await delay(40)
  stdin.write(Buffer.from('\r')) // select The Matrix -> movieSource
  await delay(40)
  stdin.write(Buffer.from('https://cdn.example/matrix.mp4'))
  await delay(60)
  stdin.write(Buffer.from('\r')) // commit URL -> review
  await delay(40)
  stdin.write(Buffer.from('\r')) // publish -> relay archive

  const code = await done
  t.is(code, 0)
  t.is(state.archiveForms.length, 1, 'relay received one archive request')
  t.is(state.archiveForms[0].url, 'https://cdn.example/matrix.mp4')
})
