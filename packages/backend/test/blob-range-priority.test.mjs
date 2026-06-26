import test from 'brittle'
import c from 'compact-encoding'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  getPrioritizedBlobDownloadRange,
  parseHttpByteRange,
  prioritizeBlobServerRangeRequest,
  publishBlobPlayheadProgress,
  releaseAllPrioritizedBlobRanges,
  subscribeBlobPlayhead,
} from '../src/blob-range-priority.js'

const blobIdEncoding = {
  preencode(state, blob) {
    c.uint.preencode(state, blob.blockOffset)
    c.uint.preencode(state, blob.blockLength)
    c.uint.preencode(state, blob.byteOffset)
    c.uint.preencode(state, blob.byteLength)
  },
  encode(state, blob) {
    c.uint.encode(state, blob.blockOffset)
    c.uint.encode(state, blob.blockLength)
    c.uint.encode(state, blob.byteOffset)
    c.uint.encode(state, blob.byteLength)
  },
  decode(state) {
    return {
      blockOffset: c.uint.decode(state),
      blockLength: c.uint.decode(state),
      byteOffset: c.uint.decode(state),
      byteLength: c.uint.decode(state),
    }
  },
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const storageSource = readFileSync(resolve(__dirname, '../src/storage.js'), 'utf8')

test('parseHttpByteRange normalizes closed and open HTTP byte ranges', (t) => {
  t.alike(parseHttpByteRange('bytes=65536-131071', 1048576), { start: 65536, end: 131071, openEnded: false })
  t.alike(parseHttpByteRange('bytes=983040-', 1048576), { start: 983040, end: 1048575, openEnded: true })
  t.alike(parseHttpByteRange('bytes=-65536', 1048576), { start: 983040, end: 1048575, openEnded: false })
  t.is(parseHttpByteRange('bytes=131071-65536', 1048576), null)
  t.is(parseHttpByteRange('items=0-10', 1048576), null)
})

test('getPrioritizedBlobDownloadRange maps a seek byte range to the matching blob core blocks', (t) => {
  const blob = {
    blockOffset: 10,
    blockLength: 100,
    byteOffset: 4096,
    byteLength: 100 * 65536,
  }

  t.alike(
    getPrioritizedBlobDownloadRange(blob, { start: 4 * 65536, end: (5 * 65536) - 1 }, { readAheadBytes: 0 }),
    { start: 14, end: 15, blocks: 1 },
  )

  t.alike(
    getPrioritizedBlobDownloadRange(blob, { start: 98 * 65536, end: (99 * 65536) - 1 }, { readAheadBytes: 4 * 65536 }),
    { start: 108, end: 110, blocks: 2 },
  )
})

test('publishBlobPlayheadProgress emits a playhead event anchored at the live read block', (t) => {
  const blob = { blockOffset: 10, blockLength: 100, byteLength: 100 * 65536 }
  const events = []
  const unsubscribe = subscribeBlobPlayhead((event) => events.push(event))
  t.teardown(unsubscribe)

  publishBlobPlayheadProgress({ keyHex: 'ab'.repeat(32), blob, blockIndex: 42 })

  t.is(events.length, 1)
  t.alike(events[0], {
    coreKeyHex: 'ab'.repeat(32),
    blockOffset: 10,
    blockLength: 100,
    byteLength: 100 * 65536,
    windowStart: 42,
    windowEnd: 42,
  })
})

test('publishBlobPlayheadProgress ignores out-of-range or malformed positions', (t) => {
  const blob = { blockOffset: 10, blockLength: 100, byteLength: 100 * 65536 }
  const events = []
  const unsubscribe = subscribeBlobPlayhead((event) => events.push(event))
  t.teardown(unsubscribe)

  publishBlobPlayheadProgress({ keyHex: 'ab'.repeat(32), blob, blockIndex: 9 }) // before blockOffset
  publishBlobPlayheadProgress({ keyHex: 'ab'.repeat(32), blob, blockIndex: 110 }) // at blockEnd
  publishBlobPlayheadProgress({ keyHex: '', blob, blockIndex: 42 }) // no key
  publishBlobPlayheadProgress({ keyHex: 'ab'.repeat(32), blob: null, blockIndex: 42 }) // no blob
  publishBlobPlayheadProgress() // no args

  t.is(events.length, 0)
})

test('getPrioritizedBlobDownloadRange keeps open-ended playback ranges bounded', (t) => {
  const blob = {
    blockOffset: 10,
    blockLength: 100,
    byteOffset: 4096,
    byteLength: 100 * 65536,
  }

  t.alike(
    getPrioritizedBlobDownloadRange(
      blob,
      { start: 0, end: blob.byteLength - 1, openEnded: true },
      { readAheadBytes: 4 * 65536 },
    ),
    { start: 10, end: 15, blocks: 5 },
  )

  t.alike(
    getPrioritizedBlobDownloadRange(
      blob,
      { start: 90 * 65536, end: blob.byteLength - 1, openEnded: true },
      { readAheadBytes: 4 * 65536 },
    ),
    { start: 100, end: 105, blocks: 5 },
  )
})

function createRangeRequest({ method = 'GET', token = 'test-token', rangeStart = 4 * 65536, rangeEnd = (5 * 65536) - 1 } = {}) {
  const key = Buffer.from('b'.repeat(64), 'hex')
  const blob = {
    blockOffset: 10,
    blockLength: 100,
    byteOffset: 4096,
    byteLength: 100 * 65536,
  }
  const encodedBlob = z32.encode(c.encode(blobIdEncoding, blob))
  const req = {
    method,
    url: `/?key=${HypercoreID.encode(key)}&blob=${encodedBlob}&type=video%2Fmp4&token=${token}`,
    headers: {
      range: `bytes=${rangeStart}-${rangeEnd == null ? '' : rangeEnd}`,
    },
  }
  return { key, blob, req }
}

function createMockBlobServer(calls, { resolveDone = true } = {}) {
  return {
    token: 'test-token',
    async _getCore(requestKey, info, active) {
      calls.push(['_getCore', requestKey.toString('hex'), info.blob, active])
      return {
        closed: false,
        download(options) {
          calls.push(['download', options])
          return {
            done: () => (resolveDone ? Promise.resolve() : new Promise(() => {})),
            destroy: () => calls.push(['destroy', options.start]),
          }
        },
        close() {
          calls.push(['close'])
        },
      }
    },
  }
}

test('prioritizeBlobServerRangeRequest starts a linear core download for the requested HTTP GET range', async (t) => {
  releaseAllPrioritizedBlobRanges()
  const calls = []
  const { key, blob, req } = createRangeRequest()
  const blobServer = createMockBlobServer(calls)

  const result = await prioritizeBlobServerRangeRequest(blobServer, req, { readAheadBytes: 0 })
  await Promise.resolve()
  await Promise.resolve()

  t.alike(result, { start: 14, end: 15, blocks: 1 })
  t.alike(calls[0], ['_getCore', key.toString('hex'), blob, true])
  t.alike(calls[1], ['download', { start: 14, end: 15, linear: true }])
  // The pooled core session must NOT be closed on default cleanup: it is kept
  // in the registry so the next range request reuses it instead of opening a
  // fresh session per request.
  t.absent(calls.some((call) => call[0] === 'close'), 'pooled core session is not closed on default cleanup')
})

test('prioritizeBlobServerRangeRequest bounds open-ended HTTP GET ranges to the read-ahead window', async (t) => {
  releaseAllPrioritizedBlobRanges()
  const calls = []
  const { req } = createRangeRequest({ rangeStart: 4 * 65536, rangeEnd: null })
  const blobServer = createMockBlobServer(calls)

  const result = await prioritizeBlobServerRangeRequest(blobServer, req, { readAheadBytes: 4 * 65536 })
  await Promise.resolve()
  await Promise.resolve()

  t.alike(result, { start: 14, end: 19, blocks: 5 })
  t.alike(calls.find((call) => call[0] === 'download'), ['download', { start: 14, end: 19, linear: true }])
})

test('a seek outside the active window drops the stale prioritized range and reuses the core session', async (t) => {
  releaseAllPrioritizedBlobRanges()
  const calls = []
  const blobServer = createMockBlobServer(calls, { resolveDone: false })

  const first = createRangeRequest({ rangeStart: 4 * 65536, rangeEnd: (5 * 65536) - 1 })
  const firstRange = await prioritizeBlobServerRangeRequest(blobServer, first.req, { readAheadBytes: 0 })
  t.alike(firstRange, { start: 14, end: 15, blocks: 1 })

  // Seek far ahead of the prioritized window while its download is in flight.
  const second = createRangeRequest({ rangeStart: 90 * 65536, rangeEnd: (91 * 65536) - 1 })
  const secondRange = await prioritizeBlobServerRangeRequest(blobServer, second.req, { readAheadBytes: 0 })
  t.alike(secondRange, { start: 100, end: 101, blocks: 1 })

  const downloads = calls.filter((call) => call[0] === 'download')
  const destroys = calls.filter((call) => call[0] === 'destroy')
  const getCores = calls.filter((call) => call[0] === '_getCore')

  t.is(getCores.length, 1, 'core session is reused across range requests for the same blob')
  t.is(downloads.length, 2, 'the seek starts a new prioritized download')
  t.alike(destroys, [['destroy', 14]], 'the pre-seek prioritized range is destroyed so the seek target gets the bandwidth')
  t.ok(calls.findIndex((call) => call[0] === 'destroy') < calls.lastIndexOf(downloads[1]), 'stale range is dropped before the new download starts')

  releaseAllPrioritizedBlobRanges()
})

test('requests inside a fresh prioritized window reuse the in-flight download', async (t) => {
  releaseAllPrioritizedBlobRanges()
  const calls = []
  const blobServer = createMockBlobServer(calls, { resolveDone: false })

  const first = createRangeRequest({ rangeStart: 4 * 65536, rangeEnd: (5 * 65536) - 1 })
  await prioritizeBlobServerRangeRequest(blobServer, first.req, { readAheadBytes: 4 * 65536 })

  // Progressive playback re-requests a couple of blocks ahead, still inside
  // the prioritized window that was just created.
  const second = createRangeRequest({ rangeStart: 6 * 65536, rangeEnd: (7 * 65536) - 1 })
  const secondRange = await prioritizeBlobServerRangeRequest(blobServer, second.req, { readAheadBytes: 4 * 65536 })

  t.ok(secondRange, 'contained request still resolves a download range')
  t.is(calls.filter((call) => call[0] === 'download').length, 1, 'in-flight window download is not restarted')
  t.is(calls.filter((call) => call[0] === 'destroy').length, 0, 'in-flight window download is not destroyed')
  t.is(calls.filter((call) => call[0] === '_getCore').length, 1, 'no extra core session is opened')

  releaseAllPrioritizedBlobRanges()
})

test('prioritizeBlobServerRangeRequest closes the core when closeCoreOnCleanup is set', async (t) => {
  const calls = []
  const { req } = createRangeRequest()
  const blobServer = {
    token: 'test-token',
    async _getCore() {
      return {
        download(options) {
          calls.push(['download', options])
          return {
            done: () => Promise.resolve(),
            destroy: () => calls.push(['destroy']),
          }
        },
        close() {
          calls.push(['close'])
        },
      }
    },
  }

  await prioritizeBlobServerRangeRequest(blobServer, req, { readAheadBytes: 0, closeCoreOnCleanup: true })
  await Promise.resolve()
  await Promise.resolve()

  t.ok(calls.some((call) => call[0] === 'close'), 'core is closed when caller opts in')
})

test('prioritizeBlobServerRangeRequest ignores HEAD range probes', async (t) => {
  const calls = []
  const { req } = createRangeRequest({ method: 'HEAD' })
  const blobServer = {
    token: 'test-token',
    async _getCore() {
      calls.push(['_getCore'])
      throw new Error('HEAD should not prioritize blob downloads')
    },
  }

  const result = await prioritizeBlobServerRangeRequest(blobServer, req)

  t.is(result, null)
  t.alike(calls, [])
})

test('storage wires blob range prioritization before delegating blob-server requests', (t) => {
  const importIndex = storageSource.indexOf("import { prioritizeBlobServerRangeRequest, releaseAllPrioritizedBlobRanges } from './blob-range-priority.js'")
  const wrapperIndex = storageSource.indexOf('blobServer._onrequest = async function (req, res)')
  const priorityIndex = storageSource.indexOf('await prioritizeBlobServerRangeRequest(blobServer, req)')
  const delegateIndex = storageSource.indexOf('return origOnRequest(req, res)')

  t.ok(importIndex >= 0, 'storage imports range priority helpers')
  t.ok(wrapperIndex >= 0, 'storage wraps blob-server requests')
  t.ok(priorityIndex > wrapperIndex, 'range priority runs inside the request wrapper')
  t.ok(priorityIndex < delegateIndex, 'range priority runs before blob-server serves the range')
})

test('storage installs blob request cancellation handling before blob-server listens', (t) => {
  const importIndex = storageSource.indexOf("import { installExpectedBlobRequestCancellationHandler } from './blob-request-cancellation.js'")
  const installIndex = storageSource.indexOf('installExpectedBlobRequestCancellationHandler()')
  const listenIndex = storageSource.indexOf('const blobServerListenPromise = blobServer.listen()')

  t.ok(importIndex >= 0, 'storage imports the blob cancellation helper')
  t.ok(installIndex >= 0, 'storage installs the blob cancellation helper')
  t.ok(installIndex < listenIndex, 'cancellation handling is installed before blob-server listens')
})

test('storage releases pooled priority ranges during backend shutdown', (t) => {
  const releaseIndex = storageSource.indexOf('releaseAllPrioritizedBlobRanges()')
  const blobServerCloseIndex = storageSource.indexOf("runShutdownStep('blobServer close'")

  t.ok(releaseIndex >= 0, 'shutdown releases pooled priority ranges')
  t.ok(blobServerCloseIndex >= 0, 'shutdown closes the blob server')
  t.ok(releaseIndex < blobServerCloseIndex, 'priority ranges are released before the blob server closes')
})
