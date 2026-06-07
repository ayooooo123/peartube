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
  t.alike(parseHttpByteRange('bytes=65536-131071', 1048576), { start: 65536, end: 131071 })
  t.alike(parseHttpByteRange('bytes=983040-', 1048576), { start: 983040, end: 1048575 })
  t.alike(parseHttpByteRange('bytes=-65536', 1048576), { start: 983040, end: 1048575 })
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

function createRangeRequest({ method = 'GET', token = 'test-token' } = {}) {
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
      range: `bytes=${4 * 65536}-${(5 * 65536) - 1}`,
    },
  }
  return { key, blob, req }
}

test('prioritizeBlobServerRangeRequest starts a non-linear core download without closing the playback core', async (t) => {
  const calls = []
  const { key, blob, req } = createRangeRequest()
  const blobServer = {
    token: 'test-token',
    async _getCore(requestKey, info, active) {
      calls.push(['_getCore', requestKey.toString('hex'), info.blob, active])
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

  const result = await prioritizeBlobServerRangeRequest(blobServer, req, { readAheadBytes: 0 })
  await Promise.resolve()
  await Promise.resolve()

  t.alike(result, { start: 14, end: 15, blocks: 1 })
  t.alike(calls[0], ['_getCore', key.toString('hex'), blob, true])
  t.alike(calls[1], ['download', { start: 14, end: 15, linear: false }])
  t.is(calls.some((call) => call[0] === 'close'), false, 'cleanup should not close the blob-server playback core by default')
})

test('prioritizeBlobServerRangeRequest only closes the core when explicitly requested', async (t) => {
  const calls = []
  const { req } = createRangeRequest()
  const blobServer = {
    token: 'test-token',
    async _getCore() {
      return {
        download() {
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

  t.ok(calls.some((call) => call[0] === 'destroy'))
  t.ok(calls.some((call) => call[0] === 'close'))
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
  const importIndex = storageSource.indexOf("import { prioritizeBlobServerRangeRequest } from './blob-range-priority.js'")
  const wrapperIndex = storageSource.indexOf('blobServer._onrequest = async function (req, res)')
  const priorityIndex = storageSource.indexOf('await prioritizeBlobServerRangeRequest(blobServer, req)')
  const delegateIndex = storageSource.indexOf('return origOnRequest(req, res)')

  t.ok(importIndex >= 0, 'storage imports range priority helper')
  t.ok(wrapperIndex >= 0, 'storage wraps blob-server requests')
  t.ok(priorityIndex > wrapperIndex, 'range priority runs inside the request wrapper')
  t.ok(priorityIndex < delegateIndex, 'range priority runs before blob-server serves the range')
})
