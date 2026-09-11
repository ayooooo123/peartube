import test from 'brittle'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAddCommand } from '../src/add/index.js'

const PUBLISHER_ID = 'e'.repeat(64)
const CHANNEL = { channelKey: 'chan-1', writerKeyHex: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }

function makeContext (overrides = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'peartube-add-exec-'))
  const defaultFilePath = join(tempDir, 'test.mp4')
  writeFileSync(defaultFilePath, Buffer.from('dummy-payload'))

  const stdout = []
  const stderr = []
  const calls = {
    acquired: [],
    claims: [],
    downloads: []
  }
  const deps = {
    openAddRuntime: async () => ({
      ensureLocalPublisher: async () => ({ publisherId: PUBLISHER_ID }),
      close: async () => {}
    }),
    ensureLocalPublisher: async () => ({ publisherId: PUBLISHER_ID }),
    resolveChannel: async () => CHANNEL,
    duplicateCheck: {
      check: async () => ({ status: 'ok', advisories: [] })
    },
    arbitrateImportClaim: async () => ({ ok: true }),
    stageSource: async ({ row }) => {
      calls.downloads.push(row)
      return { artifactPath: defaultFilePath, checksum: 'sha256:1f4ce640e765845a6ae310817110c5f2fa08e2e0a1d1e70137ea6da43a8b0c90', title: 'Test Video', dispose: null }
    },
    executeLocalFileAcquisition: async (args) => {
      calls.acquired.push(args)
      return {
        acquisitionId: `acq-${args.input.idempotencyKey}`,
        state: 'completed',
        publicationId: `pub-${args.input.idempotencyKey}`,
        manifestId: 'manifest-1',
        renditionId: 'rendition-1',
        assetId: 'asset-1'
      }
    },
    createMetadataProvider: async () => ({
      async getMovie () { return { title: 'Test Movie', mediaId: '100', provider: 'tmdb', artwork: [] } },
      async getShow () { return { name: 'Test Show', mediaId: '200', provider: 'tmdb', artwork: [] } },
      async getSeason () { return [{ seasonNumber: 1, episodeNumber: 1, title: 'Test Ep', airDate: '2020-01-01', artwork: [] }] }
    }),
    ...overrides.deps
  }

  return {
    context: {
      command: 'add',
      mode: 'scripted',
      fetchUrl: defaultFilePath,
      stdout: { write (t) { stdout.push(String(t)) } },
      stderr: { write (t) { stderr.push(String(t)) } },
      env: {},
      resolveConfig: async () => ({ content: { tmdbApiKey: 'token' } }),
      deps,
      flags: { type: 'movie', provider: 'tmdb', movieId: '100', yes: true, json: true },
      ...overrides.context
    },
    calls,
    stdout,
    stderr,
    cleanup () {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
    }
  }
}

test('pre-admission duplicate check halts before transfer when item already exists', async (t) => {
  const { context, calls, stdout, cleanup } = makeContext({
    deps: {
      duplicateCheck: {
        check: async () => ({
          status: 'already-exists',
          existing: { channelKey: 'chan-1', videoId: 'existing-1', availability: 'published' }
        })
      }
    }
  })

  try {
    const code = await runAddCommand(context)
    t.is(code, 0)
    t.is(calls.downloads.length, 0, 'no source download on existing item')
    t.is(calls.acquired.length, 0, 'no provider acquisition on existing item')
    const result = JSON.parse(stdout.join(''))
    t.is(result.status, 'already-exists')
    t.is(result.videoId, 'existing-1')
  } finally {
    cleanup()
  }
})

test('pre-admission claim arbitration halts with released when another writer won', async (t) => {
  const { context, calls, stdout, cleanup } = makeContext({
    deps: {
      arbitrateImportClaim: async () => ({ ok: false, status: 'released' })
    }
  })

  try {
    const code = await runAddCommand(context)
    t.is(code, 0)
    t.is(calls.downloads.length, 0, 'no source download when claim lost')
    t.is(calls.acquired.length, 0, 'no provider acquisition when claim lost')
    const result = JSON.parse(stdout.join(''))
    t.is(result.status, 'released')
  } finally {
    cleanup()
  }
})

test('add rejects an invalid publisher before staging or acquisition', async (t) => {
  const { context, calls, stdout, cleanup } = makeContext({
    deps: {
      ensureLocalPublisher: async () => ({ publisherId: 'not-a-valid-hex-key' })
    }
  })

  try {
    t.is(await runAddCommand(context), 1)
    t.is(calls.downloads.length, 0)
    t.is(calls.acquired.length, 0)
    t.is(stdout.join(''), '')
  } finally {
    cleanup()
  }
})

test('executeSingle passes publisherId and selector to executeLocalFileAcquisition and returns publicationId', async (t) => {
  const { context, calls, stdout, cleanup } = makeContext()

  try {
    const code = await runAddCommand(context)
    t.is(code, 0)
    t.is(calls.acquired.length, 1)

    const call = calls.acquired[0]
    t.is(call.publisherId, PUBLISHER_ID)
    t.is(call.input.retentionClass, 'archive-pin')
    t.is(call.input.title, 'Test Movie')
    t.alike(call.input.selector, {
      kind: 'movie',
      namespace: 'tmdb',
      identifier: '100'
    })

    const result = JSON.parse(stdout.join(''))
    t.is(result.status, 'published')
    t.ok(result.videoId.startsWith('pub-'))
    t.is(result.url, `peartube://channel/chan-1/video/${result.videoId}`)
  } finally {
    cleanup()
  }
})

test('executeSingle fails if provider acquisition does not reach completed', async (t) => {
  const { context, stdout, cleanup } = makeContext({
    deps: {
      executeLocalFileAcquisition: async () => ({
        acquisitionId: 'acq-failed',
        state: 'failed',
        errorCode: 'ACQUISITION_VERIFICATION_FAILED'
      })
    }
  })

  try {
    t.is(await runAddCommand(context), 1)
    t.is(stdout.join(''), '', 'a failed acquisition never prints a published result')
  } finally {
    cleanup()
  }
})

test('executeSingle infers container mimeType from staged extension rather than hardcoding video/mp4', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'peartube-mime-test-'))
  try {
    for (const [ext, expectedMime] of [
      ['.webm', 'video/webm'],
      ['.mkv', 'video/x-matroska'],
      ['.mov', 'video/quicktime'],
      ['.avi', 'video/x-msvideo'],
      ['.mp4', 'video/mp4']
    ]) {
      const realFilePath = join(tempDir, `video${ext}`)
      writeFileSync(realFilePath, Buffer.from('dummy-video-data'))

      const { context, calls, cleanup } = makeContext({
        deps: {
          stageSource: async () => ({
            artifactPath: realFilePath,
            checksum: 'sha256:e8051ad8932b95a0fb97c2971a1b232b712d04bfb3e9c21ed7cb9efb9f554554',
            title: 'Format Test',
            dispose: null
          })
        }
      })

      try {
        const code = await runAddCommand(context)
        t.is(code, 0)
        t.is(calls.acquired.length, 1)
        t.is(calls.acquired[0].input.mimeType, expectedMime, `extension ${ext} must map to ${expectedMime}`)
      } finally {
        cleanup()
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('aborted add forwards its signal and disposes a staged source only once', async (t) => {
  const controller = new AbortController()
  controller.abort()
  const events = []
  const { context, stdout, cleanup } = makeContext({ context: { signal: controller.signal } })
  context.deps.stageSource = async () => ({
    artifactPath: context.fetchUrl,
    checksum: 'sha256:1f4ce640e765845a6ae310817110c5f2fa08e2e0a1d1e70137ea6da43a8b0c90',
    title: 'Test Video',
    dispose: () => events.push('dispose')
  })
  context.deps.executeLocalFileAcquisition = async ({ input }) => {
    t.is(input.signal, controller.signal)
    events.push('cancel')
    await input.dispose()
    return { acquisitionId: 'acq-cancelled', state: 'cancelled' }
  }

  try {
    t.is(await runAddCommand(context), 0)
    t.is(JSON.parse(stdout.join('')).status, 'cancelled')
    t.alike(events, ['cancel', 'dispose'])
  } finally {
    cleanup()
  }
})
