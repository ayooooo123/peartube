import test from 'brittle'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePeartubeArgv, PeartubeUsageError } from '../src/add/argv.js'
import { PEARTUBE_USAGE, runPeartube } from '../peartube.js'
import { runSearchCommand } from '../src/network/query.js'
import { runGetCommand } from '../src/network/fetch.js'

const nonTty = { stdin: { isTTY: false }, stderr: { isTTY: false } }

function capture () {
  const chunks = []
  return { chunks, write (text) { chunks.push(String(text)) }, text () { return chunks.join('') } }
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function tempDir (t) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-network-cli-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function availability (overrides = {}) {
  return {
    state: 'healthy',
    renditionId: null,
    observedAt: 1000,
    expiresAt: 2000,
    requiredRangeCount: 1,
    reachableRangeCount: 1,
    independentPeerCount: 3,
    completePeerCount: 2,
    measuredLatencyMs: 40,
    offlinePlayable: false,
    archivePledged: false,
    reasonCodes: [],
    ...overrides
  }
}

// A stand-in for the backend media-graph surface the CLI is allowed to touch.
// Every call is recorded so a test can prove the CLI reused the catalog rather
// than inventing a second lookup path.
function fakeApi ({
  items = [],
  entities = {},
  sources = {},
  rendition = null,
  catalogError = null
} = {}) {
  const calls = []
  return {
    calls,
    async getMediaCatalog (request = {}) {
      calls.push(['getMediaCatalog', request])
      if (catalogError) return catalogError
      const start = request.cursor == null ? 0 : items.findIndex(item => item.entityId === request.cursor) + 1
      const limit = request.limit || 50
      const page = items.slice(start, start + limit)
      return {
        success: true,
        items: page,
        nextCursor: start + limit < items.length ? page.at(-1).entityId : null
      }
    },
    async getMediaEntity (request = {}) {
      calls.push(['getMediaEntity', request])
      const entity = entities[request.entityId]
      if (!entity) return { success: false, errorCode: 'MEDIA_ENTITY_NOT_FOUND', error: 'Media entity not found' }
      return { success: true, entity, claims: [], conflicts: [] }
    },
    async getPublicationSources (request = {}) {
      calls.push(['getPublicationSources', request])
      const rows = sources[request.entityId]
      if (!rows) return { success: false, errorCode: 'MEDIA_ENTITY_NOT_FOUND', error: 'Media entity not found', items: [], nextCursor: null }
      return { success: true, items: rows, nextCursor: null }
    },
    async openMediaRendition (request = {}) {
      calls.push(['openMediaRendition', request])
      if (!rendition) return { success: false, errorCode: 'MEDIA_RENDITION_NOT_FOUND', error: 'Media rendition not found' }
      return rendition.open(request)
    }
  }
}

// Serves bytes the way `openMediaRendition` does: an async iterator of chunks,
// where asking for a range is what fetches it.
function fakeRendition ({ bytes, byteLength = bytes.length, chunkSize = 7, failAfter = null, openError = null, openThrows = null }) {
  const reads = []
  let closed = 0
  return {
    reads,
    get closed () { return closed },
    async open ({ publicationId, renditionId }) {
      if (openThrows) throw openThrows
      if (openError) return openError
      return {
        success: true,
        publicationId,
        renditionId,
        contentType: 'video/mp4',
        byteLength,
        read ({ start = 0, length = byteLength - start } = {}) {
          reads.push({ start, length })
          return (async function * () {
            const end = Math.min(start + length, bytes.length)
            for (let offset = start; offset < end; offset += chunkSize) {
              if (failAfter != null && offset - start >= failAfter) {
                throw new Error(`rendition block ${offset} is unavailable`)
              }
              yield bytes.subarray(offset, Math.min(offset + chunkSize, end))
            }
          })()
        },
        async close () { closed += 1 }
      }
    }
  }
}

function networkContext ({ command, query, flags = {}, api, onClose = () => {}, openThrows = null }) {
  const stdout = capture()
  const stderr = capture()
  const closes = []
  return {
    stdout,
    stderr,
    closes,
    context: {
      command,
      query,
      mode: 'scripted',
      flags,
      stdout,
      stderr,
      env: {},
      resolveConfig: async () => ({ content: { storagePath: '/tmp/peartube-network-cli-storage' } }),
      deps: {
        openAddRuntime: async () => {
          if (openThrows) throw openThrows
          return {
            api,
            async close () { closes.push(true); onClose() }
          }
        }
      }
    }
  }
}

const MOVIE = {
  entityId: 'work:movie:the-matrix',
  entityKind: 'work',
  title: 'The Matrix',
  subtitle: 'Wachowskis',
  claimCount: 1,
  conflictCount: 0,
  availability: availability(),
  sources: [{ publicationId: 'pub-matrix', publisherId: 'pk-1', availability: availability() }],
  renditions: []
}

const BARE = {
  entityId: 'work:movie:unreported',
  entityKind: 'work',
  title: 'Unreported Reel',
  subtitle: null,
  claimCount: 1,
  conflictCount: 0,
  availability: null,
  sources: [{ publicationId: 'pub-bare', publisherId: 'pk-2', availability: null }],
  renditions: []
}

/* ------------------------------------------------------------------ argv -- */

test('search and get parse into their own command shapes', (t) => {
  t.alike(parsePeartubeArgv(['search', 'the', 'matrix', '--json'], nonTty), {
    command: 'search',
    query: 'the matrix',
    fetchUrl: null,
    flags: { json: true },
    mode: 'scripted'
  })

  t.alike(parsePeartubeArgv([
    'get', 'work:movie:the-matrix',
    '--output', '/tmp/out.mp4',
    '--rendition', 'rend-1',
    '--timeout', '30',
    '--storage', '/srv/content'
  ], nonTty), {
    command: 'get',
    query: 'work:movie:the-matrix',
    fetchUrl: null,
    flags: { output: '/tmp/out.mp4', rendition: 'rend-1', timeout: 30, storage: '/srv/content' },
    mode: 'scripted'
  })

  t.is(parsePeartubeArgv(['search', 'matrix', '--limit', '5'], nonTty).flags.limit, 5)
})

test('search and get reject each other and add-only flags', (t) => {
  t.exception(() => parsePeartubeArgv(['search'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['get'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['get', 'a', 'b'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['search', 'matrix', '--output', '/tmp/x'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['get', 'ent', '--limit', '3'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['get', 'ent', '--movie-id', '603'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['config', '--output', '/tmp/x'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['search', 'matrix', '--limit', 'lots'], nonTty), PeartubeUsageError)
  t.exception(() => parsePeartubeArgv(['get', 'ent', '--timeout', '0'], nonTty), PeartubeUsageError)
})

/* ----------------------------------------------------------------- entry -- */

test('peartube routes search and get to their own lazy modules', async (t) => {
  for (const [argv, specifier, handlerName] of [
    [['search', 'matrix'], './src/network/query.js', 'runSearchCommand'],
    [['get', 'work:movie:the-matrix'], './src/network/fetch.js', 'runGetCommand']
  ]) {
    const loaded = []
    let received = null
    const stdout = capture()
    const exitCode = await runPeartube({
      argv,
      stdin: { isTTY: false },
      stdout,
      stderr: capture(),
      env: {},
      loadModule: async (name) => {
        loaded.push(name)
        return { [handlerName]: async (context) => { received = context; return 0 } }
      }
    })
    t.is(exitCode, 0)
    t.alike(loaded, [specifier])
    t.is(received.command, argv[0])
  }

  t.ok(PEARTUBE_USAGE.includes('search <query>'), 'usage advertises search')
  t.ok(PEARTUBE_USAGE.includes('get <entity-or-publication>'), 'usage advertises get')
})

/* ---------------------------------------------------------------- search -- */

test('search prints a hit with availability and peer count from catalog fields', async (t) => {
  const api = fakeApi({ items: [MOVIE, BARE] })
  const { context, stdout, stderr, closes } = networkContext({ command: 'search', query: 'matrix', api })

  const exitCode = await runSearchCommand(context)

  t.is(exitCode, 0)
  const out = stdout.text()
  t.ok(out.includes('The Matrix'), 'title is printed')
  t.ok(out.includes('work:movie:the-matrix'), 'entity id is printed')
  t.ok(out.includes('availability=healthy'), 'availability state comes from the catalog')
  t.ok(out.includes('independent-peers=3'), 'independent peer count comes from the catalog')
  t.ok(out.includes('complete-peers=2'), 'complete peer count comes from the catalog')
  t.absent(out.includes('Unreported Reel'), 'non-matching titles are not printed')
  t.is(closes.length, 1, 'runtime closed')
  t.ok(stderr.text().includes('Joining the network'), 'progress goes to stderr')
})

test('search omits availability and peers when the catalog does not report them', async (t) => {
  const api = fakeApi({ items: [MOVIE, BARE] })
  const { context, stdout } = networkContext({ command: 'search', query: 'unreported', api })

  t.is(await runSearchCommand(context), 0)
  const out = stdout.text()
  t.ok(out.includes('Unreported Reel'))
  t.absent(out.includes('availability='), 'no availability is invented')
  t.absent(out.includes('peers='), 'no peer count is invented')
})

test('search miss reports an honest empty result and exits 0', async (t) => {
  const api = fakeApi({ items: [MOVIE] })
  const { context, stdout, closes } = networkContext({ command: 'search', query: 'nothing here', api })

  t.is(await runSearchCommand(context), 0)
  t.ok(stdout.text().includes('No titles match "nothing here"'))
  t.is(closes.length, 1)
})

test('search --json writes one structured line to stdout and progress to stderr', async (t) => {
  const api = fakeApi({ items: [MOVIE, BARE] })
  const { context, stdout, stderr } = networkContext({ command: 'search', query: 'the', flags: { json: true }, api })

  t.is(await runSearchCommand(context), 0)
  const lines = stdout.text().trim().split('\n')
  t.is(lines.length, 1, 'stdout carries exactly the JSON result')
  const parsed = JSON.parse(lines[0])
  t.is(parsed.command, 'search')
  t.is(parsed.count, 1)
  t.is(parsed.results[0].entityId, 'work:movie:the-matrix')
  t.alike(parsed.results[0].availability, { state: 'healthy', independentPeerCount: 3, completePeerCount: 2 })
  t.ok(stderr.text().includes('Joining the network'), 'progress stays on stderr')
})

test('search closes the runtime when the catalog fails', async (t) => {
  const api = fakeApi({ catalogError: { success: false, errorCode: 'CONSUMER_CATALOG_UPDATE_FAILED', error: 'nope', items: [], nextCursor: null } })
  const { context, stdout, closes } = networkContext({ command: 'search', query: 'matrix', flags: { json: true }, api })

  t.is(await runSearchCommand(context), 1)
  t.is(JSON.parse(stdout.text().trim()).errorCode, 'CONSUMER_CATALOG_UPDATE_FAILED')
  t.is(closes.length, 1)
})

/* ------------------------------------------------------------------- get -- */

const BYTES = Buffer.from(Array.from({ length: 96 }, (_, index) => index % 251))

function getFixture ({ rendition, sourceRows, entity = MOVIE }) {
  return fakeApi({
    items: [MOVIE],
    entities: { [entity.entityId]: entity },
    sources: { [entity.entityId]: sourceRows },
    rendition
  })
}

const SOURCE_ROWS = [
  {
    publicationId: 'pub-matrix',
    publisherId: 'pk-1',
    manifestId: 'man-1',
    renditionId: 'rend-1080p',
    selected: true,
    availability: availability({ renditionId: 'rend-1080p' })
  }
]

test('get retrieves a rendition, verifies it, and leaves a complete file', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const rendition = fakeRendition({ bytes: BYTES })
  const api = getFixture({ rendition, sourceRows: SOURCE_ROWS })
  const { context, stdout, stderr, closes } = networkContext({
    command: 'get',
    query: 'work:movie:the-matrix',
    flags: { output, json: true },
    api
  })

  t.is(await runGetCommand(context), 0)
  const result = JSON.parse(stdout.text().trim())
  t.is(result.status, 'complete')
  t.is(result.publicationId, 'pub-matrix')
  t.is(result.renditionId, 'rend-1080p')
  t.is(result.byteLength, BYTES.length)
  t.is(result.bytesWritten, BYTES.length)
  t.is(result.resumedFrom, 0)
  t.is(result.sha256, sha256(BYTES))
  t.alike(readFileSync(output), BYTES)
  t.absent(existsSync(`${output}.part`), 'temp file is gone')
  t.absent(existsSync(`${output}.part.json`), 'resume sidecar is gone')
  t.ok(stderr.text().includes('bytes'), 'progress goes to stderr')
  t.is(closes.length, 1, 'runtime closed')
  t.is(rendition.closed, 1, 'rendition reader closed')
  t.alike(rendition.reads, [{ start: 0, length: BYTES.length }])
})

test('get resumes from a partial temp file instead of restarting', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const half = 40
  writeFileSync(`${output}.part`, BYTES.subarray(0, half))
  writeFileSync(`${output}.part.json`, JSON.stringify({
    publicationId: 'pub-matrix',
    renditionId: 'rend-1080p',
    byteLength: BYTES.length,
    bytesWritten: half,
    sha256: sha256(BYTES.subarray(0, half))
  }))

  const rendition = fakeRendition({ bytes: BYTES })
  const api = getFixture({ rendition, sourceRows: SOURCE_ROWS })
  const { context, stdout } = networkContext({
    command: 'get',
    query: 'work:movie:the-matrix',
    flags: { output, json: true },
    api
  })

  t.is(await runGetCommand(context), 0)
  const result = JSON.parse(stdout.text().trim())
  t.is(result.resumedFrom, half)
  t.is(result.bytesWritten, BYTES.length)
  t.alike(rendition.reads, [{ start: half, length: BYTES.length - half }], 'only the missing range is requested')
  t.alike(readFileSync(output), BYTES)
})

test('get discards a partial file whose sidecar does not match', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  writeFileSync(`${output}.part`, Buffer.alloc(40, 9))
  writeFileSync(`${output}.part.json`, JSON.stringify({
    publicationId: 'pub-matrix',
    renditionId: 'rend-1080p',
    byteLength: BYTES.length,
    bytesWritten: 40,
    sha256: sha256(BYTES.subarray(0, 40))
  }))

  const rendition = fakeRendition({ bytes: BYTES })
  const api = getFixture({ rendition, sourceRows: SOURCE_ROWS })
  const { context } = networkContext({ command: 'get', query: 'work:movie:the-matrix', flags: { output, json: true }, api })

  t.is(await runGetCommand(context), 0)
  t.alike(rendition.reads, [{ start: 0, length: BYTES.length }], 'a corrupt prefix restarts the transfer')
  t.alike(readFileSync(output), BYTES)
})

test('get fails loudly on a length mismatch and leaves nothing at the destination', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const rendition = fakeRendition({ bytes: BYTES.subarray(0, 60), byteLength: BYTES.length })
  const api = getFixture({ rendition, sourceRows: SOURCE_ROWS })
  const { context, stdout, closes } = networkContext({
    command: 'get',
    query: 'work:movie:the-matrix',
    flags: { output, json: true },
    api
  })

  t.is(await runGetCommand(context), 1)
  const result = JSON.parse(stdout.text().trim())
  t.is(result.status, 'failed')
  t.is(result.errorCode, 'INTEGRITY_MISMATCH')
  t.absent(existsSync(output), 'no partial file at the final path')
  t.absent(existsSync(`${output}.part`), 'the unverifiable temp file is discarded')
  t.absent(existsSync(`${output}.part.json`))
  t.is(closes.length, 1)
})

test('get exits non-zero with AVAILABILITY_BOUNDARY when no peer serves the ranges', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const rendition = fakeRendition({ bytes: BYTES, failAfter: 21 })
  const api = getFixture({ rendition, sourceRows: SOURCE_ROWS })
  const { context, stdout, closes } = networkContext({
    command: 'get',
    query: 'work:movie:the-matrix',
    flags: { output, json: true },
    api
  })

  t.is(await runGetCommand(context), 1)
  const result = JSON.parse(stdout.text().trim())
  t.is(result.errorCode, 'AVAILABILITY_BOUNDARY')
  t.is(result.error, 'Unavailable - no peer currently serves the required ranges.')
  t.absent(existsSync(output), 'nothing lands at the final path')
  t.ok(existsSync(`${output}.part`), 'the verified prefix is kept for a resume')
  t.is(closes.length, 1)
})

test('get exits with AVAILABILITY_BOUNDARY when the entity has no source to read', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const api = getFixture({ rendition: null, sourceRows: [] })
  const { context, stdout, closes } = networkContext({
    command: 'get',
    query: 'work:movie:the-matrix',
    flags: { output, json: true },
    api
  })

  t.is(await runGetCommand(context), 1)
  t.is(JSON.parse(stdout.text().trim()).errorCode, 'AVAILABILITY_BOUNDARY')
  t.absent(existsSync(output))
  t.is(closes.length, 1)
})

test('get resolves a bare publication id through the catalog', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const rendition = fakeRendition({ bytes: BYTES })
  const api = getFixture({ rendition, sourceRows: SOURCE_ROWS })
  const { context, stdout } = networkContext({
    command: 'get',
    query: 'pub-matrix',
    flags: { output, json: true },
    api
  })

  t.is(await runGetCommand(context), 0)
  const result = JSON.parse(stdout.text().trim())
  t.is(result.entityId, 'work:movie:the-matrix')
  t.is(result.publicationId, 'pub-matrix')
})

test('get closes the runtime when opening the rendition throws', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const rendition = fakeRendition({ bytes: BYTES, openThrows: new Error('swarm exploded') })
  const api = getFixture({ rendition, sourceRows: SOURCE_ROWS })
  const { context, stdout, closes } = networkContext({
    command: 'get',
    query: 'work:movie:the-matrix',
    flags: { output, json: true },
    api
  })

  t.is(await runGetCommand(context), 1)
  t.is(JSON.parse(stdout.text().trim()).status, 'failed')
  t.is(closes.length, 1, 'runtime closed on the failure path')
  t.absent(existsSync(output))
})

test('search and get never reach an HTTP origin', async (t) => {
  const dir = tempDir(t)
  const output = join(dir, 'matrix.mp4')
  const attempts = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { attempts.push(args[0]); throw new Error('HTTP is forbidden') }
  t.teardown(() => { globalThis.fetch = originalFetch })

  const rendition = fakeRendition({ bytes: BYTES })
  const searchApi = fakeApi({ items: [MOVIE] })
  const getApi = getFixture({ rendition, sourceRows: SOURCE_ROWS })

  t.is(await runSearchCommand(networkContext({ command: 'search', query: 'matrix', api: searchApi }).context), 0)
  t.is(await runGetCommand(networkContext({
    command: 'get',
    query: 'work:movie:the-matrix',
    flags: { output },
    api: getApi
  }).context), 0)

  t.alike(attempts, [], 'no HTTP request was attempted')
})
