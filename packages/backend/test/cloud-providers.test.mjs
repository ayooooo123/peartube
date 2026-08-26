import test from 'brittle'

import b4a from 'b4a'
import { createHash } from 'node:crypto'

import { createS3ArchiveProvider } from '../src/archive/s3-provider.js'
import { createGoogleDriveArchiveProvider } from '../src/archive/google-drive-provider.js'
import { createMegaArchiveProvider } from '../src/archive/mega-provider.js'

// The provider carries no default origin — production source may not — so every
// construction states where Drive lives, the way the operator's config does.
const DRIVE_ENDPOINTS = {
  filesEndpoint: 'https://drive.test/drive/v3/files',
  uploadEndpoint: 'https://drive.test/upload/drive/v3/files'
}

// The offload path talks to a provider through five methods and nothing else, so
// these stubs answer at the wire level - URLs, methods, headers, bodies - rather
// than standing in for the provider. A test that mocked the provider would prove
// nothing about whether the real one addresses Drive or Mega correctly.

function response ({ status = 200, body = null, headers = {} } = {}) {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  const bytes = b4a.isBuffer(body) ? body : null
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(String(name).toLowerCase()) ?? null },
    async json () {
      if (bytes) throw new Error('the body is not JSON')
      return body
    },
    async text () {
      if (bytes) return b4a.toString(bytes, 'utf8')
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
    async arrayBuffer () {
      const source = bytes || b4a.alloc(0)
      return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
    }
  }
}

function sliceForRange (bytes, header) {
  if (!header) return bytes
  const match = /^bytes=(\d+)-(\d*)$/.exec(header)
  if (!match) throw new Error(`unusable range header: ${header}`)
  const start = Number(match[1])
  const end = match[2] === '' ? bytes.byteLength - 1 : Number(match[2])
  return bytes.subarray(start, end + 1)
}

// A Drive stand-in that keeps files by opaque id, the way Drive does, so the
// provider has to do its own key-to-id bookkeeping to find anything. Two things
// it does on purpose: it lists a name's files oldest-first whatever `orderBy`
// asked for, so a provider that trusts Drive's ordering binds the stale one, and
// `checksums: false` stands in for a Drive that never reports a `sha256Checksum`
// at all.
function driveStub ({ checksums = true } = {}) {
  const files = new Map()
  const uploads = new Map()
  const calls = []
  let nextId = 0
  let nextUpload = 0
  let clock = 0

  // Drive re-stamps a file whenever its content changes, and that stamp is what
  // orders a duplicate set, so the stub has to move it the way Drive does.
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + (++clock * 1000)).toISOString()

  const nameFromQuery = (q) => {
    const match = /^name = '((?:\\.|[^'\\])*)'/.exec(q)
    if (!match) throw new Error(`unusable q: ${q}`)
    return match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  }

  const findByName = (name) => [...files].filter(([, file]) => file.name === name)

  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

  const stored = (id, file) => (checksums ? { id, sha256Checksum: digest(file.data) } : { id })

  // Puts a file in the folder without going through the provider, which is how a
  // folder a crash left ambiguous is set up.
  const seed = (name, data) => {
    const id = `drive-${nextId++}`
    files.set(id, { name, parents: ['folder-1'], data, modifiedTime: stamp() })
    return id
  }

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET'
    const parsed = new URL(url)
    calls.push({ method, path: parsed.pathname, search: parsed.search, headers: init.headers || {} })

    if (init.headers?.Authorization !== 'Bearer test-token') return response({ status: 401 })

    if (parsed.pathname === '/drive/v3/files' && method === 'GET') {
      const matches = findByName(nameFromQuery(parsed.searchParams.get('q')))
      return response({ body: { files: matches.map(([id, file]) => ({ id, modifiedTime: file.modifiedTime })) } })
    }

    if (parsed.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(parsed.pathname.slice('/drive/v3/files/'.length))
      const file = files.get(id)
      if (method === 'DELETE') {
        if (!file) return response({ status: 404 })
        files.delete(id)
        return response({ status: 204 })
      }
      if (!file) return response({ status: 404 })
      if (parsed.searchParams.get('alt') === 'media') {
        const range = init.headers?.Range
        return response({ status: range ? 206 : 200, body: sliceForRange(file.data, range) })
      }
      const fields = (parsed.searchParams.get('fields') || '').split(',')
      return response({ body: fields.includes('sha256Checksum') ? stored(id, file) : { id } })
    }

    if (parsed.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const type = parsed.searchParams.get('uploadType')
      if (type === 'resumable') {
        const metadata = JSON.parse(b4a.toString(init.body, 'utf8'))
        const upload = `resumable-${nextUpload++}`
        uploads.set(upload, metadata)
        return response({
          headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${upload}` }
        })
      }
      // multipart/related: metadata part, then the media part.
      const boundary = /boundary=(.+)$/.exec(init.headers['Content-Type'])[1]
      const raw = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength)
      const metaStart = raw.indexOf('\r\n\r\n') + 4
      const metaEnd = raw.indexOf(`\r\n--${boundary}`, metaStart)
      const metadata = JSON.parse(raw.subarray(metaStart, metaEnd).toString('utf8'))
      const mediaStart = raw.indexOf('\r\n\r\n', metaEnd) + 4
      const mediaEnd = raw.indexOf(`\r\n--${boundary}--`, mediaStart)
      const data = b4a.from(raw.subarray(mediaStart, mediaEnd))
      const id = `drive-${nextId++}`
      files.set(id, { name: metadata.name, parents: metadata.parents, data, modifiedTime: stamp() })
      return response({ body: stored(id, files.get(id)) })
    }

    if (parsed.pathname === '/upload/drive/v3/files' && method === 'PUT') {
      const metadata = uploads.get(parsed.searchParams.get('upload_id'))
      if (!metadata) return response({ status: 404 })
      const data = b4a.from(init.body)
      const id = `drive-${nextId++}`
      files.set(id, { name: metadata.name, parents: metadata.parents, data, modifiedTime: stamp() })
      return response({ body: stored(id, files.get(id)) })
    }

    if (parsed.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
      const id = decodeURIComponent(parsed.pathname.slice('/upload/drive/v3/files/'.length))
      const file = files.get(id)
      if (!file) return response({ status: 404 })
      file.data = b4a.from(init.body)
      file.modifiedTime = stamp()
      return response({ body: stored(id, file) })
    }

    throw new Error(`unexpected Drive request: ${method} ${url}`)
  }

  return { fetchImpl, files, calls, seed }
}

// A Mega stand-in: the command endpoint, the transfer endpoints it hands out,
// and nodes addressed by opaque handle with an opaque attribute string.
function megaStub ({ session = 'test-sid' } = {}) {
  const nodes = new Map()
  const pending = new Map()
  const calls = []
  let nextNode = 0
  let nextTicket = 0

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET'
    const parsed = new URL(url)
    calls.push({ method, path: parsed.pathname, search: parsed.search })

    if (parsed.pathname === '/cs') {
      if (parsed.searchParams.get('sid') !== session) return response({ body: [-15] })
      const [command] = JSON.parse(init.body)
      if (command.a === 'u') {
        const ticket = `ticket-${nextTicket++}`
        pending.set(ticket, { size: command.s })
        return response({ body: [{ p: `https://mega.test/up/${ticket}` }] })
      }
      if (command.a === 'p') {
        const staged = pending.get(command.n[0].h)
        if (!staged || !staged.data) return response({ body: [-13] })
        const handle = `node-${nextNode++}`
        nodes.set(handle, { p: command.t, t: command.n[0].t, a: command.n[0].a, k: command.n[0].k, data: staged.data })
        pending.delete(command.n[0].h)
        return response({ body: [{ f: [{ h: handle, p: command.t, t: 0 }] }] })
      }
      if (command.a === 'g') {
        const node = nodes.get(command.n)
        if (!node) return response({ body: [-9] })
        return response({ body: [{ g: `https://mega.test/dl/${command.n}`, s: node.data.byteLength, at: node.a }] })
      }
      if (command.a === 'd') {
        if (!nodes.delete(command.n)) return response({ body: [-9] })
        return response({ body: [0] })
      }
      if (command.a === 'f') {
        const f = [...nodes].map(([h, node]) => ({ h, p: node.p, t: node.t, a: node.a, k: node.k, s: node.data.byteLength }))
        return response({ body: [{ f }] })
      }
      throw new Error(`unexpected Mega command: ${command.a}`)
    }

    if (parsed.pathname.startsWith('/up/') && method === 'POST') {
      const [ticket, offset] = parsed.pathname.slice('/up/'.length).split('/')
      const staged = pending.get(ticket)
      if (!staged) return response({ status: 404 })
      if (Number(offset) !== 0) throw new Error('the stub only accepts a whole-block upload')
      staged.data = b4a.from(init.body)
      if (staged.data.byteLength !== staged.size) return response({ body: '-13' })
      return response({ body: ticket })
    }

    if (parsed.pathname.startsWith('/dl/')) {
      const [handle, span] = parsed.pathname.slice('/dl/'.length).split('/')
      const node = nodes.get(handle)
      if (!node) return response({ status: 404 })
      if (!span) return response({ body: node.data })
      const [start, end] = span.split('-').map(Number)
      return response({ body: node.data.subarray(start, end + 1) })
    }

    throw new Error(`unexpected Mega request: ${method} ${url}`)
  }

  return { fetchImpl, nodes, calls }
}

const BLOCK = b4a.from('a media block that is long enough to take a range out of')
const KEY = 'relay/blocks/aa11/000000000042'

test('the Google Drive provider carries a block through put, has, ranged get and delete', async t => {
  const drive = driveStub()
  const provider = createGoogleDriveArchiveProvider({
    fetch: drive.fetchImpl,
    accessToken: 'test-token',
    folderId: 'folder-1',
    ...DRIVE_ENDPOINTS,
    prefix: 'relay'
  })

  const checksum = createHash('sha256').update(BLOCK).digest('base64')
  t.alike(await provider.putBlock({ key: KEY, data: BLOCK, checksumSha256Base64: checksum }), { success: true, key: KEY })

  const stored = [...drive.files.values()]
  t.is(stored.length, 1, 'one file landed in Drive')
  t.is(stored[0].name, KEY, 'named by the block key, so the mapping lives in Drive')
  t.alike(stored[0].parents, ['folder-1'], 'in the folder it was configured with')

  t.is(await provider.hasBlock({ key: KEY }), true)

  const whole = new Uint8Array(await provider.getBlock({ key: KEY }))
  t.alike(whole, new Uint8Array(BLOCK), 'a plain get returns the block')

  const part = new Uint8Array(await provider.getBlock({ key: KEY, range: { start: 2, end: 6 } }))
  t.alike(part, new Uint8Array(BLOCK.subarray(2, 7)), 'and a ranged get returns exactly that range')
  const ranged = drive.calls.filter(call => call.headers.Range)
  t.is(ranged.length, 1, 'through one request')
  t.is(ranged[0].headers.Range, 'bytes=2-6', 'carrying an HTTP byte range')

  const open = new Uint8Array(await provider.getBlock({ key: KEY, range: { start: 4 } }))
  t.alike(open, new Uint8Array(BLOCK.subarray(4)), 'an open-ended range runs to the end of the object')

  t.alike(await provider.deleteBlock({ key: KEY }), { success: true, key: KEY })
  t.is(drive.files.size, 0, 'the file is gone from Drive')
  t.is(await provider.hasBlock({ key: KEY }), false)
  t.ok(provider.getStatus().healthy, 'and the whole lifecycle left the provider healthy')
})

test('a re-put patches the file Drive already has instead of duplicating it', async t => {
  // Drive creates a second file with the same name rather than replacing one, so
  // a block the offloader retries would otherwise leave an orphan behind and an
  // ambiguous lookup for every later read.
  const drive = driveStub()
  const provider = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })

  await provider.putBlock({ key: KEY, data: BLOCK })
  const again = b4a.from('the same block, sent again after a retry')
  await provider.putBlock({ key: KEY, data: again })

  t.is(drive.files.size, 1, 'still one file')
  t.alike(new Uint8Array(await provider.getBlock({ key: KEY })), new Uint8Array(again), 'holding the newer bytes')
  t.ok(provider.getStatus().healthy)
})

test('a fresh Drive provider finds an already-offloaded block by name', async t => {
  // The key-to-id mapping is a cache, not the record of truth. A relay restart
  // must not orphan blocks it offloaded before, so it has to be able to look
  // them up again with nothing but the block key.
  const drive = driveStub()
  const first = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })
  await first.putBlock({ key: KEY, data: BLOCK })

  const restarted = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })
  t.is(await restarted.hasBlock({ key: KEY }), true, 'the block is found again')
  t.alike(new Uint8Array(await restarted.getBlock({ key: KEY })), new Uint8Array(BLOCK), 'and still readable')
  t.ok(restarted.getStatus().healthy)
})

test('a block Drive does not have is a normal answer, not ill health', async t => {
  const drive = driveStub()
  const provider = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })

  t.is(await provider.hasBlock({ key: 'relay/blocks/aa11/000000000099' }), false)
  const status = provider.getStatus()
  t.is(status.failures, 0, 'an absent block is not a provider failure')
  t.ok(status.healthy, 'so the tier stays healthy')

  // The same must hold once a cached id has gone stale under us, which is the
  // path the S3 provider originally got wrong.
  await provider.putBlock({ key: KEY, data: BLOCK })
  drive.files.clear()
  t.is(await provider.hasBlock({ key: KEY }), false, 'a vanished file reads as absent')
  t.ok(provider.getStatus().healthy, 'still without marking the provider unhealthy')

  await t.exception(provider.getBlock({ key: KEY }), /HTTP 404/, 'but reading it is an error, in the shape the offloader expects')
})

test('a block over the multipart limit goes through the Drive resumable upload', async t => {
  // Drive answers 400 to a multipart body over 5 MiB. Blocks are normally far
  // smaller, but a provider that cannot take a large one would fail an archive
  // rather than slow it down.
  const drive = driveStub()
  const provider = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })

  const large = b4a.alloc((5 * 1024 * 1024) + 64, 7)
  await provider.putBlock({ key: KEY, data: large })

  const types = drive.calls.filter(call => call.path === '/upload/drive/v3/files').map(call => new URLSearchParams(call.search).get('uploadType'))
  t.alike(types, ['resumable', 'resumable'], 'registered the upload, then sent the bytes')
  t.is([...drive.files.values()][0].data.byteLength, large.byteLength, 'and the whole block landed')

  const tail = new Uint8Array(await provider.getBlock({ key: KEY, range: { start: large.byteLength - 4 } }))
  t.alike(tail, new Uint8Array(4).fill(7), 'readable by range like any other block')
  t.ok(provider.getStatus().healthy)
})

test('a Drive access token that expires mid-archive is refreshed rather than failing the block', async t => {
  // An archive runs longer than an access token lives, which is the whole
  // reason `getAccessToken` exists next to `accessToken`. Drive answers a stale
  // token with 401, and that is the one 4xx worth retrying.
  const drive = driveStub()
  const tokens = ['stale-token', 'test-token']
  let issued = 0
  const provider = createGoogleDriveArchiveProvider({
    fetch: drive.fetchImpl,
    getAccessToken: async () => tokens[Math.min(issued++, tokens.length - 1)],
    folderId: 'folder-1',
    ...DRIVE_ENDPOINTS,
  })

  await provider.putBlock({ key: KEY, data: BLOCK })
  t.is(issued, 2, 'the rejected token was dropped and a fresh one asked for')
  const status = provider.getStatus()
  t.is(status.retries, 1, 'visible as one retry')
  t.is(status.failures, 0, 'and not as a failure')
  t.ok(status.healthy)
  t.alike(new Uint8Array(await provider.getBlock({ key: KEY })), new Uint8Array(BLOCK), 'and the block is readable')
})

test('a refused Drive checksum fails the put rather than dropping the local copy', async t => {
  const drive = driveStub()
  const provider = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })

  const wrong = createHash('sha256').update('some other bytes entirely').digest('base64')
  await t.exception(provider.putBlock({ key: KEY, data: BLOCK, checksumSha256Base64: wrong }), /different SHA-256/)
  t.absent(provider.getStatus().healthy, 'and it counts against health, because it is a real fault')
  t.is(drive.files.size, 0, 'and the file it could not prove is not left behind for a later lookup to bind to')
})

test('a Drive upload Drive reports no SHA-256 for is not treated as verified', async t => {
  // Verifying only when the upload response happened to carry `sha256Checksum`
  // was a fail-open at the deletion boundary: the offloader drops the local
  // block on a successful put, so "Drive did not say" must never read as "the
  // bytes are right". The metadata fetch that follows is the second chance, and
  // when that is silent too the put has to fail.
  const drive = driveStub({ checksums: false })
  const provider = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })

  await t.exception(provider.putBlock({ key: KEY, data: BLOCK }), /cannot be proved/)
  t.is(drive.files.size, 0, 'and the unproved file was discarded rather than left as the newest match for the key')
  t.absent(provider.getStatus().healthy, 'an unprovable upload is a real fault')
})

test('a duplicate left by a lost Drive create response still resolves to the current bytes', async t => {
  // Drive's create is not idempotent. When Drive commits the POST and the
  // response is lost, the retry inside `request` makes a second file with the
  // same name, and caching one arbitrary match bound the key to whichever Drive
  // listed first - stale bytes, once a later re-put patched the other one.
  const drive = driveStub()
  let lost = false
  const flaky = async (url, init) => {
    const result = await drive.fetchImpl(url, init)
    if (!lost && new URL(url).pathname === '/upload/drive/v3/files' && (init.method || 'GET') === 'POST') {
      lost = true
      return response({ status: 503 })
    }
    return result
  }
  const provider = createGoogleDriveArchiveProvider({ fetch: flaky, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })

  await provider.putBlock({ key: KEY, data: BLOCK })
  t.is(lost, true, 'the first create was committed and its response thrown away')
  t.is(drive.files.size, 1, 'the duplicate the retry created was reconciled against the id that was proved')

  const newer = b4a.from('the block as it is after the duplicate was made')
  await provider.putBlock({ key: KEY, data: newer })

  const restarted = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })
  t.alike(new Uint8Array(await restarted.getBlock({ key: KEY })), new Uint8Array(newer), 'a fresh provider reads the current bytes')
  t.ok(restarted.getStatus().healthy)
})

test('a Drive folder a crash left ambiguous binds the key to the newest file, not the first listed', async t => {
  // Two files with one name is what a crash between a create and its
  // reconciliation leaves. Resolution has to be deterministic without any local
  // state, so it is decided by modification time rather than by the order Drive
  // answered a query in - the stub lists the stale one first on purpose.
  const drive = driveStub()
  const stale = drive.seed(KEY, b4a.from('the bytes a crashed put left behind'))
  const current = drive.seed(KEY, BLOCK)
  t.is([...drive.files.keys()][0], stale, 'the stale file is the one Drive lists first')

  const provider = createGoogleDriveArchiveProvider({ fetch: drive.fetchImpl, accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })
  t.alike(new Uint8Array(await provider.getBlock({ key: KEY })), new Uint8Array(BLOCK), 'the newest file is what the key resolves to')

  const newer = b4a.from('bytes written once the folder was noticed to be ambiguous')
  await provider.putBlock({ key: KEY, data: newer })
  t.is(drive.files.size, 1, 'and the next put makes the folder unambiguous again')
  t.is([...drive.files.keys()][0], current, 'keeping the file the key was already bound to')
  t.alike(new Uint8Array(await provider.getBlock({ key: KEY })), new Uint8Array(newer), 'holding the newer bytes')
  t.ok(provider.getStatus().healthy)
})

test('the Mega provider carries a block through put, has, ranged get and delete', async t => {
  const mega = megaStub()
  const provider = createMegaArchiveProvider({
    fetch: mega.fetchImpl,
    session: 'test-sid',
    folder: 'folder-handle',
    prefix: 'relay'
  })

  t.alike(await provider.putBlock({ key: KEY, data: BLOCK }), { success: true, key: KEY })
  t.is(mega.nodes.size, 1, 'one node landed in Mega')
  const [node] = [...mega.nodes.values()]
  t.is(node.p, 'folder-handle', 'in the configured folder')
  t.is(node.t, 0, 'as a file node')

  t.is(await provider.hasBlock({ key: KEY }), true)

  const whole = new Uint8Array(await provider.getBlock({ key: KEY }))
  t.alike(whole, new Uint8Array(BLOCK), 'a plain get returns the block')

  const part = new Uint8Array(await provider.getBlock({ key: KEY, range: { start: 2, end: 6 } }))
  t.alike(part, new Uint8Array(BLOCK.subarray(2, 7)), 'and a ranged get returns exactly that range')
  const ranged = mega.calls.filter(call => call.path.startsWith('/dl/') && call.path.split('/').length > 3)
  t.is(ranged[0].path, '/dl/node-0/2-6', 'as a path suffix, which is how Mega takes a range')

  const open = new Uint8Array(await provider.getBlock({ key: KEY, range: { start: 4 } }))
  t.alike(open, new Uint8Array(BLOCK.subarray(4)), 'an open-ended range is bounded by the size Mega reports')

  t.alike(await provider.deleteBlock({ key: KEY }), { success: true, key: KEY })
  t.is(mega.nodes.size, 0, 'the node is gone from Mega')
  t.is(await provider.hasBlock({ key: KEY }), false)
  t.ok(provider.getStatus().healthy, 'and the whole lifecycle left the provider healthy')
})

test('a fresh Mega provider rebuilds its mapping from the folder', async t => {
  // Mega has no per-key lookup, so the block key is written into the node's
  // attribute field and read back out of the tree fetch. Without that, a relay
  // restart would lose every block it had already offloaded.
  const mega = megaStub()
  const first = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })
  await first.putBlock({ key: KEY, data: BLOCK })

  const restarted = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })
  t.is(await restarted.hasBlock({ key: KEY }), true, 'the block is found again')
  t.alike(new Uint8Array(await restarted.getBlock({ key: KEY })), new Uint8Array(BLOCK), 'and still readable')

  const listings = mega.calls.filter(call => call.path === '/cs').length
  t.is(await restarted.hasBlock({ key: KEY }), true, 'a second question is answered from the cache')
  t.is(mega.calls.filter(call => call.path === '/cs').length, listings + 1, 'without fetching the tree again')
  t.ok(restarted.getStatus().healthy)
})

test('a re-put retires the node it replaced', async t => {
  // Mega's `p` always creates. Two nodes carrying the same key marker would make
  // the rebuilt mapping depend on iteration order.
  const mega = megaStub()
  const provider = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })

  await provider.putBlock({ key: KEY, data: BLOCK })
  const again = b4a.from('the same block, sent again after a retry')
  await provider.putBlock({ key: KEY, data: again })

  t.is(mega.nodes.size, 1, 'still one node')
  t.alike(new Uint8Array(await provider.getBlock({ key: KEY })), new Uint8Array(again), 'holding the newer bytes')
  t.ok(provider.getStatus().healthy)
})

test('a Mega upload that lands with the wrong bytes fails the put', async t => {
  // Mega reports nothing about what it stored, so a put that took node creation
  // for success reported success for a corrupted block - and the offloader
  // deletes the local copy on that word, which made a truncated or flipped
  // upload permanent media loss. The read-back is what closes that.
  const mega = megaStub()
  const corrupting = async (url, init) => {
    if (new URL(url).pathname.startsWith('/up/') && (init.method || 'GET') === 'POST') {
      const flipped = b4a.from(init.body)
      flipped[0] = flipped[0] ^ 0xff
      return mega.fetchImpl(url, { ...init, body: flipped })
    }
    return mega.fetchImpl(url, init)
  }
  const provider = createMegaArchiveProvider({ fetch: corrupting, session: 'test-sid', folder: 'folder-handle' })

  const checksum = createHash('sha256').update(BLOCK).digest('base64')
  await t.exception(provider.putBlock({ key: KEY, data: BLOCK, checksumSha256Base64: checksum }), /did not land with the SHA-256/)
  t.is(mega.nodes.size, 0, 'and the node holding the wrong bytes was discarded, not left as the newest generation')
  t.absent(provider.getStatus().healthy, 'a block that did not land is a real fault')

  // And with no checksum handed over either: the digest of the bytes the caller
  // gave stands in, so there is no argument shape that skips the check.
  const unchecked = createMegaArchiveProvider({ fetch: corrupting, session: 'test-sid', folder: 'folder-handle' })
  await t.exception(unchecked.putBlock({ key: KEY, data: BLOCK }), /did not land with the SHA-256/)
  t.is(mega.nodes.size, 0)
})

test('a Mega retirement that fails fails the put, and a restart still finds the newer node', async t => {
  // The old code swallowed the failure and reported success, leaving two nodes
  // with the same marker for the next tree fetch to choose between by server
  // order. Both halves are tested: the put has to fail, and the folder it left
  // behind has to resolve to the newer node anyway.
  const mega = megaStub()
  let refuse = false
  const refusing = async (url, init) => {
    if (refuse && new URL(url).pathname === '/cs' && JSON.parse(init.body)[0].a === 'd') return response({ body: [-11] })
    return mega.fetchImpl(url, init)
  }
  const provider = createMegaArchiveProvider({ fetch: refusing, session: 'test-sid', folder: 'folder-handle' })

  await provider.putBlock({ key: KEY, data: BLOCK })
  const newer = b4a.from('the block as it is after the re-put')
  refuse = true
  await t.exception(provider.putBlock({ key: KEY, data: newer }), /API error -11/)
  t.is(mega.nodes.size, 2, 'both nodes are in the folder, which is exactly why the put could not report success')
  t.absent(provider.getStatus().healthy)

  // The caller keeps its local block because the put failed. What must not
  // happen is a restart binding the key to the node that failed put meant to
  // retire: the marker's generation decides, not tree-fetch order, and the stub
  // lists the stale node first.
  const restarted = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })
  t.is([...mega.nodes.keys()][0], 'node-0', 'the stale node is the one the tree fetch lists first')
  t.alike(new Uint8Array(await restarted.getBlock({ key: KEY })), new Uint8Array(newer), 'and the newest generation is still what the key resolves to')

  refuse = false
  await provider.putBlock({ key: KEY, data: newer })
  t.is(mega.nodes.size, 1, 'the retirement the failed put could not finish is retried by the next one')
  t.alike(new Uint8Array(await provider.getBlock({ key: KEY })), new Uint8Array(newer))
})

test('a Mega re-put after a restart retires the node the earlier run wrote', async t => {
  // A relay that restarted holds no mapping, so the generation for a key has to
  // come out of the folder before the upload. Without that the re-put would
  // write generation 0 over a folder that already holds one, and the next
  // hydrate would have two nodes it could not order.
  const mega = megaStub()
  const first = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })
  await first.putBlock({ key: KEY, data: BLOCK })

  const restarted = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })
  const newer = b4a.from('the block as the restarted relay re-put it')
  await restarted.putBlock({ key: KEY, data: newer })
  t.is(mega.nodes.size, 1, 'the node the earlier run wrote was retired rather than left as a duplicate')

  const third = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })
  t.alike(new Uint8Array(await third.getBlock({ key: KEY })), new Uint8Array(newer), 'and a third relay agrees on the bytes')
  t.ok(third.getStatus().healthy)
})

test('a block Mega does not have is a normal answer, not ill health', async t => {
  const mega = megaStub()
  const provider = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'test-sid', folder: 'folder-handle' })

  t.is(await provider.hasBlock({ key: 'relay/blocks/aa11/000000000099' }), false)
  let status = provider.getStatus()
  t.is(status.failures, 0, 'an absent block is not a provider failure')
  t.ok(status.healthy, 'so the tier stays healthy')

  // And once a cached handle has gone stale under us: Mega reports -9 ENOENT,
  // which must read as absence rather than as a fault.
  await provider.putBlock({ key: KEY, data: BLOCK })
  mega.nodes.clear()
  t.is(await provider.hasBlock({ key: KEY }), false, 'a removed node reads as absent')
  status = provider.getStatus()
  t.is(status.failures, 0, 'with no failure recorded')
  t.ok(status.healthy, 'still without marking the provider unhealthy')

  await provider.deleteBlock({ key: 'relay/blocks/aa11/000000000099' })
  t.ok(provider.getStatus().healthy, 'and deleting a key that was never there succeeds')

  // Reading a block the provider still believes it has is a different matter: it
  // is a real fault, and it has to arrive in the shape the offload path reads,
  // which is a status code and not a Mega error number.
  await provider.putBlock({ key: KEY, data: BLOCK })
  mega.nodes.clear()
  try {
    await provider.getBlock({ key: KEY })
    t.fail('reading a removed node must fail')
  } catch (error) {
    t.is(error.statusCode, 404, 'mapped onto the 404 the offloader understands')
    t.is(error.megaCode, -9, 'from Mega ENOENT')
  }
  t.absent(provider.getStatus().healthy, 'and that one does count against health')
})

test('a Mega session Mega refuses is a hard failure, not a retry loop', async t => {
  const mega = megaStub({ session: 'the-real-sid' })
  const provider = createMegaArchiveProvider({ fetch: mega.fetchImpl, session: 'stale-sid', folder: 'folder-handle' })

  await t.exception(provider.putBlock({ key: KEY, data: BLOCK }), /API error -15/)
  t.is(mega.calls.length, 1, 'ESID is not something a retry can fix, so it is not retried')
  t.absent(provider.getStatus().healthy)
})

test('a Mega EAGAIN in a 200 body is retried, and the block still lands', async t => {
  // Mega says "come back later" as a negative code inside an HTTP 200, not as a
  // 503. A retry policy that only read the status would fail an archive on the
  // first busy moment, which is the whole reason the S3 provider retries at all.
  const mega = megaStub()
  let refusals = 0
  const flaky = async (url, init) => {
    if (new URL(url).pathname === '/cs' && refusals < 2) {
      refusals++
      return response({ body: [-3] })
    }
    return mega.fetchImpl(url, init)
  }
  const provider = createMegaArchiveProvider({ fetch: flaky, session: 'test-sid', folder: 'folder-handle' })

  await provider.putBlock({ key: KEY, data: BLOCK })
  t.is(refusals, 2, 'both EAGAINs were absorbed')
  const status = provider.getStatus()
  t.is(status.retries, 2, 'and are visible as retries')
  t.is(status.failures, 0, 'not as failures')
  t.ok(status.healthy, 'so an absorbed blip never marks the tier unhealthy')
  t.alike(new Uint8Array(await provider.getBlock({ key: KEY })), new Uint8Array(BLOCK), 'and the block is readable')
})

test('both providers present the same interface as the S3 provider', async t => {
  const s3 = createS3ArchiveProvider({ fetch: async () => response({}), sign: async () => ({ url: 'https://s3/x' }), bucket: 'b' })
  const drive = createGoogleDriveArchiveProvider({ fetch: async () => response({}), accessToken: 'test-token', folderId: 'folder-1', ...DRIVE_ENDPOINTS })
  const mega = createMegaArchiveProvider({ fetch: async () => response({}), session: 'test-sid', folder: 'folder-handle' })

  const surface = Object.keys(s3).sort()
  t.alike(surface, ['deleteBlock', 'getBlock', 'getStatus', 'hasBlock', 'putBlock'], 'the S3 provider is the contract')
  t.alike(Object.keys(drive).sort(), surface, 'Drive exposes exactly it')
  t.alike(Object.keys(mega).sort(), surface, 'and so does Mega')

  // The offload path reads these counters straight out of getStatus() and
  // publishes them, so a provider that omits one breaks the relay status file
  // rather than only itself.
  for (const [name, provider] of [['drive', drive], ['mega', mega]]) {
    const status = provider.getStatus()
    for (const field of ['provider', 'prefix', 'requests', 'failures', 'retries', 'healthy']) {
      t.ok(field in status, `${name} reports ${field}`)
    }
    t.is(typeof status.requests, 'number')
    t.is(typeof status.failures, 'number')
    t.is(typeof status.retries, 'number')
    t.is(status.healthy, true, 'a provider that has done nothing yet is healthy')
  }
  t.is(drive.getStatus().provider, 'google-drive')
  t.is(mega.getStatus().provider, 'mega')
})

test('both providers refuse to be built without what they need', async t => {
  // `exception.all` rather than `exception`, because these are native
  // TypeErrors and brittle rethrows those out of the plain form. A falsy
  // `fetch` is not an error - it falls back to the global one, the way the S3
  // provider does - so the guard is tested with a value that is not callable.
  await t.exception.all(() => createGoogleDriveArchiveProvider({ fetch: 'not callable' }), /fetch is required/)
  await t.exception.all(() => createGoogleDriveArchiveProvider({ fetch: async () => {} }), /accessToken or getAccessToken is required/)
  await t.exception.all(() => createGoogleDriveArchiveProvider({ fetch: async () => {}, accessToken: 't' }), /folderId must be a non-empty string/)
  await t.exception.all(() => createMegaArchiveProvider({ fetch: 'not callable' }), /fetch is required/)
  await t.exception.all(() => createMegaArchiveProvider({ fetch: async () => {} }), /session must be a non-empty string/)
  await t.exception.all(() => createMegaArchiveProvider({ fetch: async () => {}, session: 's' }), /folder must be a non-empty string/)
})
