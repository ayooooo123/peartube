import test from 'brittle'
import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { acquisitionIdForRequest, idempotencyDigestFor, fingerprintAcquisitionRequest } from '@peartube/backend/acquisition'
import { canonicalLocalResolutionRecord, executeLocalFileAcquisition, sha256File } from '../src/local-file-acquisition.js'
import { createArchiveConsole } from '../src/archive-console.js'
import { mirrorLocalDriveToRelayChannel } from '../src/local-drive-mirror.js'
import { runAddCommand } from '../src/add/index.js'

const PUBLISHER_ID = 'f'.repeat(64)
const CHANNEL = { channelKey: 'chan-parity-1', writerKeyHex: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }

test('cross-entrypoint idempotency: console, add, and mirror yield identical acquisition keys, resolution records, and acquisitionIds', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'peartube-parity-test-'))
  const consoleDir = join(tempDir, 'console')
  const mirrorDir = join(tempDir, 'mirror')
  const addDir = join(tempDir, 'add')
  mkdirSync(consoleDir)
  mkdirSync(mirrorDir)
  mkdirSync(addDir)

  const fileBytes = Buffer.from('PEARTUBE_LOCAL_FILE_SAMPLE_BYTES_FOR_PARITY_TEST_20260909')
  const byteLength = fileBytes.byteLength
  const sha256 = createHash('sha256').update(fileBytes).digest('hex')

  // Separate same-basename files in separate directories per surface
  const consoleFilePath = join(consoleDir, 'sample-video.mp4')
  const mirrorFilePath = join(mirrorDir, 'sample-video.mp4')
  const addFilePath = join(addDir, 'sample-video.mp4')
  writeFileSync(consoleFilePath, fileBytes)
  writeFileSync(mirrorFilePath, fileBytes)
  writeFileSync(addFilePath, fileBytes)

  const expectedCanon = canonicalLocalResolutionRecord({
    sha256,
    byteLength,
    fileName: 'sample-video.mp4',
    title: 'sample-video',
    kind: 'movie',
    namespace: null,
    identifier: null
  })

  // 1. Realistic store and provider seam with resolution lease tracking and cryptographic dedupe
  const resolutionLeases = new Map()
  const registeredDigests = new Map()
  const jobs = new Map()
  const executedAcquisitions = []

  function realisticAcquireOrReplay ({ principal, idempotencyKey, request }) {
    const digest = idempotencyDigestFor({
      principal,
      publisherId: request.publisherId,
      idempotencyKey
    })
    const fingerprint = fingerprintAcquisitionRequest(request)

    const existing = registeredDigests.get(digest)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const conflict = new Error(`idempotency digest was already registered with a different request: ${digest}`)
        conflict.code = 'IDEMPOTENCY_CONFLICT'
        throw conflict
      }
      return jobs.get(existing.acquisitionId)
    }

    const acquisitionId = acquisitionIdForRequest({ principal, idempotencyKey, request })
    registeredDigests.set(digest, { fingerprint, acquisitionId })
    const job = {
      acquisitionId,
      state: 'queued',
      sourceAccepted: true,
      publicationId: null
    }
    jobs.set(acquisitionId, job)
    executedAcquisitions.push({ request, job })
    return job
  }

  const mockRuntime = {
    provider: {
      async requestAcquisition ({ idempotencyKey, request, principal }) {
        return realisticAcquireOrReplay({ principal, idempotencyKey, request })
      },
      async attachSourceGrant ({ acquisitionId, principal }) {
        const job = jobs.get(acquisitionId)
        if (job) {
          job.state = 'completed'
          job.publicationId = `pub-${acquisitionId}`
          job.manifestId = 'manifest-1'
          job.renditionId = 'rendition-1'
          job.assetId = 'asset-1'
          return { ...job, sourceAccepted: true }
        }
        return {
          acquisitionId,
          state: 'completed',
          sourceAccepted: true,
          publicationId: `pub-${acquisitionId}`
        }
      },
      async getAcquisition ({ acquisitionId }) {
        return jobs.get(acquisitionId) || null
      },
      async getAcquisitionPolicy () {
        return {
          policyVersion: 1,
          migrationRequired: false,
          enabled: true,
          requesterMode: 'local-only',
          allowedPublisherIds: [PUBLISHER_ID],
          allowedAdapterIds: ['local-file'],
          sourceGrantTtlMs: 86400000,
          revision: 1
        }
      }
    },
    issueLocalProviderResolution (params) {
      const preferredRef = createHash('sha256').update(`peartube.provider.local-resolution.v1\u0000${params.publisherId}\u0000${params.idempotencyKey}`).digest('base64url').slice(0, 43)
      const existing = resolutionLeases.get(preferredRef)
      const record = {
        title: params.title,
        selector: params.selector,
        expectedBytes: params.expectedBytes,
        sourceFileName: params.sourceFileName
      }
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          const error = new Error('local resolution idempotency key is already bound')
          error.code = 'INVALID_FIELD'
          throw error
        }
      } else {
        resolutionLeases.set(preferredRef, record)
      }
      return {
        resolutionRef: preferredRef,
        ...record
      }
    },
    localFileSourceGrants: {
      issue ({ acquisitionId, principalId, path, mimeType, expiresAt }) {
        return { token: 'token-1', adapterId: 'local-file', audience: { principalId, acquisitionId }, expiresAt }
      },
      revoke () { return true }
    }
  }

  // 2. Drive Archive Console enqueue
  const consoleRequests = []
  const fakeRelayService = {
    runtime: { ctx: { metaDb: {} }, ...mockRuntime },
    async requestLocalFileAcquisition (input) {
      consoleRequests.push(input)
      return executeLocalFileAcquisition({
        runtime: mockRuntime,
        publisherId: PUBLISHER_ID,
        input: { ...input, awaitCompletion: true }
      })
    },
    async listAcquisitions () { return [] },
    async getVerifiedMediaCatalog () { return { success: true, items: [], nextCursor: null } }
  }

  const archiveConsole = await createArchiveConsole({
    service: fakeRelayService,
    downloader: { async download () { throw new Error('not used') } },
    uploadDir: consoleDir,
    publisher: {},
    port: 0
  })
  await archiveConsole.start()

  const consoleJob = await archiveConsole.manager.enqueue(
    { title: 'sample-video' },
    {
      path: consoleFilePath,
      relativePath: 'sample-video.mp4',
      filename: 'sample-video.mp4',
      mimeType: 'video/mp4',
      size: byteLength,
      dir: consoleDir
    }
  )
  await archiveConsole.close()

  t.is(consoleRequests.length, 1)
  const consoleInput = consoleRequests[0]
  t.is(consoleInput.idempotencyKey, expectedCanon.idempotencyKey)
  t.alike(consoleInput.selector, expectedCanon.selector)
  t.is(consoleInput.expectedBytes, expectedCanon.expectedBytes)
  t.is(consoleInput.sourceFileName, expectedCanon.sourceFileName)

  // 3. Drive Local Drive Mirror
  const mirrorRequests = []
  const mockMirrorFs = {
    createReadStream,
    readdirSync (dir) {
      if (dir === mirrorDir) return [{ name: 'sample-video.mp4', isDirectory: () => false, isFile: () => true }]
      return []
    },
    statSync (p) {
      return { size: byteLength, mtimeMs: 12345 }
    },
    readFileSync (p) {
      return fileBytes
    },
    existsSync (p) {
      return true
    }
  }

  const pathShim = {
    join (...parts) { return parts.join('/').replace(/\/+/g, '/') }
  }

  await mirrorLocalDriveToRelayChannel({
    rootPath: mirrorDir,
    fs: mockMirrorFs,
    path: pathShim,
    requestLocalFileAcquisition: async (input) => {
      mirrorRequests.push(input)
      return executeLocalFileAcquisition({
        runtime: mockRuntime,
        publisherId: PUBLISHER_ID,
        input: { ...input, awaitCompletion: true }
      })
    }
  })

  t.is(mirrorRequests.length, 1)
  const mirrorInput = mirrorRequests[0]
  t.is(mirrorInput.idempotencyKey, expectedCanon.idempotencyKey)
  t.alike(mirrorInput.selector, expectedCanon.selector)
  t.is(mirrorInput.expectedBytes, expectedCanon.expectedBytes)
  t.is(mirrorInput.sourceFileName, expectedCanon.sourceFileName)

  // 4. Drive CLI Add
  const addRequests = []
  const addContext = {
    command: 'add',
    mode: 'scripted',
    fetchUrl: addFilePath,
    stdout: { write () {} },
    stderr: { write () {} },
    env: {},
    resolveConfig: async () => ({}),
    deps: {
      openAddRuntime: async () => ({
        metadataBee: {},
        ensureLocalPublisher: async () => ({ publisherId: PUBLISHER_ID }),
        close: async () => {}
      }),
      ensureLocalPublisher: async () => ({ publisherId: PUBLISHER_ID }),
      resolveChannel: async () => CHANNEL,
      duplicateCheck: { check: async () => ({ status: 'ok', advisories: [] }) },
      arbitrateImportClaim: async () => ({ ok: true }),
      stageSource: async () => ({
        artifactPath: addFilePath,
        checksum: `sha256:${sha256}`,
        title: 'sample-video',
        dispose: null
      }),
      executeLocalFileAcquisition: async (args) => {
        addRequests.push(args.input)
        return executeLocalFileAcquisition({
          runtime: mockRuntime,
          publisherId: PUBLISHER_ID,
          input: { ...args.input, awaitCompletion: true }
        })
      }
    },
    flags: { type: 'video', title: 'sample-video', yes: true, json: true }
  }

  const addCode = await runAddCommand(addContext)
  t.is(addCode, 0)
  t.is(addRequests.length, 1)
  const addInput = addRequests[0]
  t.is(addInput.idempotencyKey, expectedCanon.idempotencyKey)
  t.alike(addInput.selector, expectedCanon.selector)
  t.is(addInput.expectedBytes, expectedCanon.expectedBytes)
  t.is(addInput.sourceFileName, expectedCanon.sourceFileName)

  // 5. Parity Gate Assertions:
  // All three entrypoints produce the identical idempotencyKey, selector, expectedBytes, and sourceFileName
  t.is(consoleInput.idempotencyKey, mirrorInput.idempotencyKey)
  t.is(mirrorInput.idempotencyKey, addInput.idempotencyKey)
  t.alike(consoleInput.selector, mirrorInput.selector)
  t.alike(mirrorInput.selector, addInput.selector)
  t.is(consoleInput.expectedBytes, mirrorInput.expectedBytes)
  t.is(mirrorInput.expectedBytes, addInput.expectedBytes)
  t.is(consoleInput.sourceFileName, mirrorInput.sourceFileName)
  t.is(mirrorInput.sourceFileName, addInput.sourceFileName)

  // 6. Deduplication & Idempotency: Exactly one real acquisition job was created; subsequent calls replayed without conflict
  t.is(executedAcquisitions.length, 1, 'all three surfaces map to the exact same single acquisition job')
  const initialJob = executedAcquisitions[0].job
  t.is(initialJob.acquisitionId, consoleJob.id)


  rmSync(tempDir, { recursive: true, force: true })
})

test('local digest retains standard SHA256 identity for an empty file', async (t) => {
  const digest = await sha256File('empty', { createReadStream: () => [] })
  t.is(digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('local digest hashes every streamed byte view and UTF8 chunk in order', async (t) => {
  const backing = Buffer.alloc(128 * 1024 + 29)
  for (let index = 0; index < backing.byteLength; index++) backing[index] = index & 255
  const chunks = [
    'multibyte source: \u00e9',
    new Uint8Array(backing.buffer, backing.byteOffset + 13, 128 * 1024 + 3),
    new DataView(backing.buffer, backing.byteOffset + backing.byteLength - 7, 5)
  ]
  const expected = createHash('sha256')
  for (const chunk of chunks) expected.update(chunk)
  const digest = await sha256File('streamed', {
    async * createReadStream () {
      for (const chunk of chunks) yield chunk
    }
  })
  t.is(digest, expected.digest('hex'))
})
