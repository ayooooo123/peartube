import test from 'brittle'
import b4a from 'b4a'

import { ASSET_BLOCK_SIZE } from '@peartube/backend/assets'

import { createRelayBlockOffload } from '../src/archive/block-offload.js'
import { resolveRelayConfig } from '../src/config.js'
import { boundedIngestBytes } from '../src/storage-guard.js'

// Google Drive and Mega block offload used to be unreachable: the relay's
// wiring named createS3ArchiveProvider and nothing else, so two whole providers
// were code no operator could ever run. These tests drive the selection from the
// operator's config down to the WIRE - the URL each provider actually requests -
// because that is the only evidence that a name in a config file reaches the
// provider it names. Asserting the returned `provider` string would have passed
// against the hardcoded version.
//
// The other half of this is the promise made to every relay already offloading
// to a bucket: nothing about its behaviour moves. So the S3 path is pinned at
// the same level of detail - the signed request, the object key, the window and
// the working-set arithmetic - rather than merely "still works".

const CORE_KEY = b4a.alloc(32, 7)
const CORE_KEY_HEX = '07'.repeat(32)
const core = { key: CORE_KEY }

const WINDOW_BYTES = 8 * 1024 * 1024
const BLOCK_INDEX = 7
const BLOCK_KEY = `relay-a/blocks/${CORE_KEY_HEX}/000000000007`

// The credentials each provider is configured with. Every one of them is a
// distinctive string so a leak into a log field is findable by search.
const S3_SECRET = 's3-secret-access-key-value'
const S3_ACCESS_KEY = 's3-access-key-id-value'
const DRIVE_TOKEN = 'ya29.drive-access-token-value'
const MEGA_SESSION = 'mega-session-id-value'
const CREDENTIALS = [S3_SECRET, S3_ACCESS_KEY, DRIVE_TOKEN, MEGA_SESSION]

const S3_SETTINGS = {
  endpoint: 'https://s3.example.com',
  bucket: 'peartube-blocks',
  region: 'us-east-1',
  accessKeyId: S3_ACCESS_KEY,
  secretAccessKey: S3_SECRET,
  prefix: 'relay-a',
  offload: true,
  offloadWindowBytes: WINDOW_BYTES
}

const DRIVE_SETTINGS = {
  accessToken: DRIVE_TOKEN,
  folderId: 'drive-folder-1',
  prefix: 'relay-a',
  // Operator-supplied, with no default anywhere in source: the relay refuses to
  // ship pointing at anybody's service, so an endpoint is as required as a key.
  filesEndpoint: 'https://drive.test/drive/v3/files',
  uploadEndpoint: 'https://drive.test/upload/drive/v3/files',
  offload: true,
  offloadWindowBytes: WINDOW_BYTES
}

const MEGA_SETTINGS = {
  session: MEGA_SESSION,
  folder: 'mega-folder-handle',
  apiUrl: 'https://mega.test/cs',
  prefix: 'relay-a',
  offload: true,
  offloadWindowBytes: WINDOW_BYTES
}

function response ({ status = 200, body = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json () { return body },
    async text () { return typeof body === 'string' ? body : JSON.stringify(body) },
    async arrayBuffer () { return new ArrayBuffer(0) }
  }
}

// Each recorder answers only the requests its own vendor's API defines and
// throws on anything else, so a provider aimed at the wrong service fails the
// test rather than quietly recording nothing.
function s3Recorder () {
  const calls = []
  const signed = []
  return {
    calls,
    signed,
    createSigner (request) {
      signed.push(request)
      return { url: `https://${S3_SETTINGS.bucket}.s3.example.com/${request.key}` }
    },
    async fetchImpl (url, init = {}) {
      const parsed = new URL(url)
      if (!parsed.host.endsWith('s3.example.com')) throw new Error(`not an S3 request: ${url}`)
      calls.push({ url, method: init.method || 'GET' })
      // No such object: `hasBlock` reads a 404 as "not there" without retrying.
      return response({ status: 404 })
    }
  }
}

function driveRecorder () {
  const calls = []
  return {
    calls,
    async fetchImpl (url, init = {}) {
      const parsed = new URL(url)
      if (parsed.host !== 'www.googleapis.com') throw new Error(`not a Drive request: ${url}`)
      calls.push({
        host: parsed.host,
        path: parsed.pathname,
        q: parsed.searchParams.get('q'),
        authorization: init.headers?.Authorization || null,
        method: init.method || 'GET'
      })
      if (parsed.pathname === '/drive/v3/files' && (init.method || 'GET') === 'GET') {
        return response({ body: { files: [] } })
      }
      throw new Error(`unexpected Drive request: ${init.method || 'GET'} ${url}`)
    }
  }
}

function megaRecorder () {
  const calls = []
  return {
    calls,
    async fetchImpl (url, init = {}) {
      const parsed = new URL(url)
      if (parsed.host !== 'mega.test') throw new Error(`not a Mega request: ${url}`)
      const [command] = JSON.parse(init.body)
      calls.push({
        host: parsed.host,
        path: parsed.pathname,
        sid: parsed.searchParams.get('sid'),
        command: command.a,
        method: init.method || 'GET'
      })
      // An empty account tree: no node carries this block's marker.
      if (command.a === 'f') return response({ body: [{ f: [] }] })
      throw new Error(`unexpected Mega command: ${command.a}`)
    }
  }
}

// The fields service.js logs when offload comes up. Nothing else from the
// offload object reaches an operator's log.
function enabledLogFields (offload) {
  return {
    windowBytes: offload.windowBytes,
    provider: offload.provider,
    bucket: offload.bucket,
    prefix: offload.prefix
  }
}

// Everything the offload object exposes that is not a function - the whole of
// what a caller could put in a log line, a status payload or an API response.
function exposedFields (offload) {
  return Object.fromEntries(Object.entries(offload).filter(([, value]) => typeof value !== 'function'))
}

test('an existing S3 bucket config still selects S3, with the same key, window and working set', async (t) => {
  const s3 = s3Recorder()
  // Deliberately no `provider` key: this is a config written before provider
  // selection existed.
  const offload = await createRelayBlockOffload({
    config: { archive: { s3: { ...S3_SETTINGS } } },
    fetchImpl: s3.fetchImpl,
    createSigner: s3.createSigner
  })

  t.is(offload.provider, 's3', 'S3 is what an operator who never named a provider gets')
  t.is(offload.bucket, 'peartube-blocks')
  t.is(offload.prefix, 'relay-a')
  t.is(offload.windowBytes, WINDOW_BYTES)

  t.is(await offload.createStagingStore({ core }).has(BLOCK_INDEX), false)
  t.alike(
    s3.signed,
    [{ operation: 'head', key: BLOCK_KEY, method: 'HEAD', headers: {} }],
    'the block key and the signed operation are exactly what they were'
  )
  t.alike(
    s3.calls,
    [{ url: `https://peartube-blocks.s3.example.com/${BLOCK_KEY}`, method: 'HEAD' }],
    'and the request went to the bucket, once'
  )

  // The download guard sizes its reservation with this, so a change here would
  // silently change which archives a relay accepts.
  const streamBytes = 40 * 1024 * 1024 * 1024
  t.is(
    offload.localWorkingBytes(streamBytes),
    boundedIngestBytes({ windowBytes: WINDOW_BYTES, blockBytes: ASSET_BLOCK_SIZE, streamBytes }),
    'the working set is the window plus bookkeeping, unchanged'
  )
})

test('naming s3 explicitly is the same wiring as not naming a provider at all', async (t) => {
  const implicit = s3Recorder()
  const explicit = s3Recorder()

  const before = await createRelayBlockOffload({
    config: { archive: { s3: { ...S3_SETTINGS } } },
    fetchImpl: implicit.fetchImpl,
    createSigner: implicit.createSigner
  })
  const after = await createRelayBlockOffload({
    config: { archive: { provider: 's3', s3: { ...S3_SETTINGS } } },
    fetchImpl: explicit.fetchImpl,
    createSigner: explicit.createSigner
  })

  t.alike(exposedFields(after), exposedFields(before), 'the same surface')
  t.alike(after.stats(), before.stats(), 'the same stats')

  await before.createStagingStore({ core }).has(BLOCK_INDEX)
  await after.createStagingStore({ core }).has(BLOCK_INDEX)
  t.alike(explicit.signed, implicit.signed, 'the same signed request')
  t.alike(explicit.calls, implicit.calls, 'against the same URL')
})

test('provider: google-drive reaches Drive, addressing the same block key', async (t) => {
  const drive = driveRecorder()
  // No signer is passed. If this still built the S3 provider it would either
  // fail for want of one or aim at a bucket the Drive recorder refuses.
  const offload = await createRelayBlockOffload({
    config: { archive: { provider: 'google-drive', googleDrive: { ...DRIVE_SETTINGS } } },
    fetchImpl: drive.fetchImpl
  })

  t.is(offload.provider, 'google-drive')
  t.is(offload.bucket, 'drive-folder-1', 'the folder the blocks land in, named for the operator')
  t.is(offload.windowBytes, WINDOW_BYTES)

  t.is(await offload.createStagingStore({ core }).has(BLOCK_INDEX), false)
  t.is(drive.calls.length, 1, 'one request')
  t.is(drive.calls[0].host, 'www.googleapis.com')
  t.is(drive.calls[0].path, '/drive/v3/files')
  t.ok(drive.calls[0].q.includes(`name = '${BLOCK_KEY}'`), 'looked up by the same block key S3 uses')
  t.ok(drive.calls[0].q.includes("'drive-folder-1' in parents"), 'inside the configured folder')
  t.is(drive.calls[0].authorization, `Bearer ${DRIVE_TOKEN}`, 'with the configured token')
})

test('provider: mega reaches Mega, at the configured endpoint', async (t) => {
  const mega = megaRecorder()
  const offload = await createRelayBlockOffload({
    config: { archive: { provider: 'mega', mega: { ...MEGA_SETTINGS } } },
    fetchImpl: mega.fetchImpl
  })

  t.is(offload.provider, 'mega')
  t.is(offload.bucket, 'mega-folder-handle', 'the folder handle the blocks land in')
  t.is(offload.windowBytes, WINDOW_BYTES)

  t.is(await offload.createStagingStore({ core }).has(BLOCK_INDEX), false)
  t.is(mega.calls.length, 1, 'one command')
  t.is(mega.calls[0].host, 'mega.test', 'the configured apiUrl is the one used')
  t.is(mega.calls[0].path, '/cs')
  t.is(mega.calls[0].command, 'f', 'the tree fetch that resolves a marker to a handle')
  t.is(mega.calls[0].sid, MEGA_SESSION, 'with the configured session')
})

test('the offload path cannot tell the three providers apart', async (t) => {
  const s3 = await createRelayBlockOffload({
    config: { archive: { provider: 's3', s3: { ...S3_SETTINGS } } },
    fetchImpl: s3Recorder().fetchImpl,
    createSigner: s3Recorder().createSigner
  })
  const drive = await createRelayBlockOffload({
    config: { archive: { provider: 'google-drive', googleDrive: { ...DRIVE_SETTINGS } } },
    fetchImpl: driveRecorder().fetchImpl
  })
  const mega = await createRelayBlockOffload({
    config: { archive: { provider: 'mega', mega: { ...MEGA_SETTINGS } } },
    fetchImpl: megaRecorder().fetchImpl
  })

  const surface = Object.keys(s3).sort()
  t.alike(Object.keys(drive).sort(), surface, 'Drive offers the relay the same capability')
  t.alike(Object.keys(mega).sort(), surface, 'and so does Mega')
  t.alike(drive.stats(), s3.stats(), 'the same stats shape and starting values')
  t.alike(mega.stats(), s3.stats())

  const streamBytes = 4 * 1024 * 1024 * 1024
  t.is(drive.localWorkingBytes(streamBytes), s3.localWorkingBytes(streamBytes), 'the same working set')
  t.is(mega.localWorkingBytes(streamBytes), s3.localWorkingBytes(streamBytes))

  for (const offload of [s3, drive, mega]) {
    t.ok(typeof offload.createOffloader === 'function')
    t.ok(typeof offload.createStagingStore === 'function')
    t.ok(typeof offload.wrapStorage === 'function')
  }
})

test('no credential can reach the enabled log line', async (t) => {
  const built = [
    await createRelayBlockOffload({
      config: { archive: { provider: 's3', s3: { ...S3_SETTINGS } } },
      fetchImpl: s3Recorder().fetchImpl,
      createSigner: s3Recorder().createSigner
    }),
    await createRelayBlockOffload({
      config: { archive: { provider: 'google-drive', googleDrive: { ...DRIVE_SETTINGS } } },
      fetchImpl: driveRecorder().fetchImpl
    }),
    await createRelayBlockOffload({
      config: { archive: { provider: 'mega', mega: { ...MEGA_SETTINGS } } },
      fetchImpl: megaRecorder().fetchImpl
    })
  ]

  for (const offload of built) {
    const fields = enabledLogFields(offload)
    t.ok(fields.bucket, `${offload.provider} names where its blocks go`)
    t.is(fields.prefix, 'relay-a')
    t.is(fields.windowBytes, WINDOW_BYTES)

    // Not just the four fields: nothing the offload object exposes at all may
    // carry a token, a session or a key.
    const serialized = JSON.stringify({ fields, exposed: exposedFields(offload) })
    for (const credential of CREDENTIALS) {
      t.absent(serialized.includes(credential), `${offload.provider} leaks no credential`)
    }
  }
})

test('an unknown provider name is refused at startup', async (t) => {
  t.exception(
    () => resolveRelayConfig({ archive: { provider: 'gdrive' } }, { env: {} }),
    /archive\.provider must be one of s3, google-drive, mega \(got "gdrive"\)/,
    'a typo is not silently the default'
  )
  await t.exception(
    createRelayBlockOffload({ config: { archive: { provider: 'gdrive', googleDrive: { ...DRIVE_SETTINGS } } } }),
    /archive\.provider must be one of s3, google-drive, mega/,
    'and the wiring refuses it too, not only the loader'
  )

  const defaulted = resolveRelayConfig({}, { env: {} })
  t.is(defaulted.archive.provider, 's3', 'an unset provider is S3')
})

test('a half-configured provider throws at startup rather than disabling offload', async (t) => {
  for (const field of ['accessToken', 'folderId']) {
    const googleDrive = { ...DRIVE_SETTINGS }
    delete googleDrive[field]
    t.exception(
      () => resolveRelayConfig({ archive: { provider: 'google-drive', googleDrive } }, { env: {} }),
      new RegExp(`archive\\.googleDrive is incomplete: missing ${field}`),
      `Drive offload without ${field} refuses at startup`
    )
    await t.exception(
      createRelayBlockOffload({
        config: { archive: { provider: 'google-drive', googleDrive } },
        fetchImpl: driveRecorder().fetchImpl
      }),
      new RegExp(`archive\\.googleDrive is incomplete: missing ${field}`),
      `and the wiring will not build a Drive offload without ${field}`
    )
  }

  for (const field of ['session', 'folder']) {
    const mega = { ...MEGA_SETTINGS }
    delete mega[field]
    t.exception(
      () => resolveRelayConfig({ archive: { provider: 'mega', mega } }, { env: {} }),
      new RegExp(`archive\\.mega is incomplete: missing ${field}`),
      `Mega offload without ${field} refuses at startup`
    )
    await t.exception(
      createRelayBlockOffload({
        config: { archive: { provider: 'mega', mega } },
        fetchImpl: megaRecorder().fetchImpl
      }),
      new RegExp(`archive\\.mega is incomplete: missing ${field}`),
      `and the wiring will not build a Mega offload without ${field}`
    )
  }

  // The S3 refusal an operator already relies on, worded exactly as before.
  const s3 = { ...S3_SETTINGS }
  delete s3.bucket
  t.exception(
    () => resolveRelayConfig({ archive: { s3 } }, { env: {} }),
    /archive\.s3\.offload is true but archive\.s3 is incomplete: missing bucket/
  )
})

test('offload enabled on a provider nobody selected is refused, not ignored', async (t) => {
  // The failure this prevents: a relay that starts, reports no offload, and
  // fills the volume while its operator believes block data is leaving it.
  t.exception(
    () => resolveRelayConfig({ archive: { s3: { ...S3_SETTINGS }, mega: { ...MEGA_SETTINGS } } }, { env: {} }),
    /archive\.mega\.offload is true but archive\.provider is "s3"/
  )
  t.exception(
    () => resolveRelayConfig(
      { archive: { provider: 'mega', mega: { ...MEGA_SETTINGS }, s3: { ...S3_SETTINGS } } },
      { env: {} }
    ),
    /archive\.s3\.offload is true but archive\.provider is "mega"/
  )

  const accepted = resolveRelayConfig(
    { archive: { provider: 'google-drive', googleDrive: { ...DRIVE_SETTINGS } } },
    { env: {} }
  )
  t.is(accepted.archive.provider, 'google-drive')
  t.is(accepted.archive.googleDrive.offload, true)
  t.is(accepted.archive.googleDrive.accessToken, DRIVE_TOKEN)
  t.is(accepted.archive.s3.offload, false, 'and the unselected sections stay off')
  t.is(accepted.archive.mega.offload, false)
})

test('the provider and its credentials come through the environment too', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_PROVIDER: 'mega',
      PEARTUBE_ARCHIVE_MEGA_SESSION: MEGA_SESSION,
      PEARTUBE_ARCHIVE_MEGA_FOLDER: 'mega-folder-handle',
      PEARTUBE_ARCHIVE_MEGA_API_URL: 'https://mega.test/cs',
      PEARTUBE_ARCHIVE_MEGA_PREFIX: 'relay-a',
      PEARTUBE_ARCHIVE_MEGA_OFFLOAD: 'true',
      PEARTUBE_ARCHIVE_MEGA_OFFLOAD_WINDOW_BYTES: String(WINDOW_BYTES)
    }
  })

  t.is(config.archive.provider, 'mega')
  t.alike(
    config.archive.mega,
    {
      session: MEGA_SESSION,
      folder: 'mega-folder-handle',
      apiUrl: 'https://mega.test/cs',
      prefix: 'relay-a',
      offload: true,
      offloadWindowBytes: WINDOW_BYTES
    },
    'a Mega relay is configurable without a config file'
  )

  const drive = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_PROVIDER: 'google-drive',
      PEARTUBE_ARCHIVE_GOOGLE_DRIVE_ACCESS_TOKEN: DRIVE_TOKEN,
      PEARTUBE_ARCHIVE_GOOGLE_DRIVE_FOLDER_ID: 'drive-folder-1',
      PEARTUBE_ARCHIVE_GOOGLE_DRIVE_OFFLOAD: 'true'
    }
  })
  t.is(drive.archive.provider, 'google-drive')
  t.is(drive.archive.googleDrive.folderId, 'drive-folder-1')
  t.is(drive.archive.googleDrive.offload, true)
})

test('offload stays off until the selected provider asks for it', async (t) => {
  t.absent(
    await createRelayBlockOffload({ config: { archive: { provider: 'mega', mega: { ...MEGA_SETTINGS, offload: false } } } }),
    'a fully configured Mega folder is not permission to start deleting local blocks'
  )
  t.absent(
    await createRelayBlockOffload({ config: { archive: { provider: 'google-drive', googleDrive: { ...DRIVE_SETTINGS, offload: false } } } }),
    'nor is a Drive folder'
  )
  t.absent(await createRelayBlockOffload({ config: {} }), 'and an unconfigured relay has no offload at all')
})
