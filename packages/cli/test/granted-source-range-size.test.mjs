import test from 'brittle'

import { createGrantedRangedSource } from '../src/archive-manager.js'
import { MAX_SOURCE_CHUNK_BYTES } from '../src/constants.js'
import { createSourceCallbackClient } from '../src/companion/source-client.js'

// The range size a granted ingest reads at, and the read-ahead that keeps the
// upstream pulling while a range is being consumed.
//
// The size is a shared constant on purpose: the callback refuses an over-large
// Range outright and the relay refuses a configured chunkBytes above its own
// ceiling, so a title only moves if both sides agree. client application's half is
// services/peartube/source_callback.go `defaultSourceMaxRangeBytes`, which
// carries the same figure and a pointer back here.
//
// What is asserted below is the arithmetic and the bound, not the throughput:
// the byte-exactness of a full read, the exact ranges a resumed read asks for,
// that never more than one request is open and never more than one completed
// range is held unconsumed, and that a consumer which stops leaves nothing
// transferring.

const ETAG = '"remote-sha256-0123456789abcdef"'
const CAPABILITY = 'source-capability-range-size-00000000001'
const JOB = 'ing_range_size'

// A 4.2 GiB episode: the size that took hours at 4 MiB a range.
const TITLE_BYTES = 4_509_715_660

function pattern (byteLength) {
  const bytes = Buffer.allocUnsafe(byteLength)
  for (let index = 0; index < byteLength; index++) bytes[index] = (index * 31 + 7) & 0xff
  return bytes
}

// Serves `bytes` honestly, one range at a time, recording what was asked for.
function servingClient (bytes, chunkBytes, { onRange = null } = {}) {
  const ranges = []
  let inFlight = 0
  const client = {
    ranges,
    chunkBytes,
    maxInFlight: 0,
    async head () {
      return { length: bytes.byteLength, etag: ETAG, mimeType: 'video/x-matroska' }
    },
    async getRange ({ start, end, onChunk, signal }) {
      ranges.push(`bytes=${start}-${end}`)
      inFlight += 1
      client.maxInFlight = Math.max(client.maxInFlight, inFlight)
      try {
        if (onRange !== null) await onRange({ start, end, signal })
        onChunk(bytes.subarray(start, end + 1), 0)
        return end - start + 1
      } finally {
        inFlight -= 1
      }
    },
    async revoke () { return true }
  }
  return client
}

// A grant for a title far larger than any fixture. Nothing of it is
// materialised: each range answers with a single byte, so the range PLAN can be
// checked at the size actually shipped without moving 4.2 GiB through the test.
function planningClient (length, chunkBytes) {
  const ranges = []
  return {
    ranges,
    chunkBytes,
    length,
    async getRange ({ start, end, onChunk }) {
      ranges.push({ start, end })
      onChunk(Buffer.of(start & 0xff), 0)
      return end - start + 1
    }
  }
}

function sourceFor (client, { length, ...rest } = {}) {
  return createGrantedRangedSource({
    client,
    capability: CAPABILITY,
    jobId: JOB,
    etag: ETAG,
    length,
    ...rest
  })
}

async function drain (iterable) {
  const parts = []
  for await (const chunk of iterable) parts.push(Buffer.from(chunk))
  return parts
}

test('the range size is one figure both sides of the callback agree on', async (t) => {
  t.is(MAX_SOURCE_CHUNK_BYTES, 16 * 1024 * 1024, '16 MiB — see the derivation in src/constants.js')

  const configured = createSourceCallbackClient({
    origin: 'http://127.0.0.1:8080',
    client: 'peartube-companion',
    sharedSecret: 'a'.repeat(64),
    chunkBytes: MAX_SOURCE_CHUNK_BYTES
  })
  t.is(configured.chunkBytes, MAX_SOURCE_CHUNK_BYTES, 'the client accepts the shipped size')

  // The ceiling has to move WITH the default, or the relay rejects its own
  // configuration before a single range is asked for.
  await t.exception.all(
    async () => createSourceCallbackClient({
      origin: 'http://127.0.0.1:8080',
      client: 'peartube-companion',
      sharedSecret: 'a'.repeat(64),
      chunkBytes: MAX_SOURCE_CHUNK_BYTES + 1
    }),
    /chunkBytes must be between 1 and 16777216/,
    'and refuses anything above it'
  )

  const defaulted = createSourceCallbackClient({
    origin: 'http://127.0.0.1:8080',
    client: 'peartube-companion',
    sharedSecret: 'a'.repeat(64)
  })
  t.is(defaulted.chunkBytes, MAX_SOURCE_CHUNK_BYTES, 'an unconfigured client reads at the shipped size')
})

test('a 4.2 GiB title is read as contiguous 16 MiB ranges, and a quarter as many of them', async (t) => {
  const client = planningClient(TITLE_BYTES, MAX_SOURCE_CHUNK_BYTES)
  const source = sourceFor(client, { length: TITLE_BYTES })
  await drain(source.open(0))

  const ranges = client.ranges
  t.is(ranges.length, Math.ceil(TITLE_BYTES / MAX_SOURCE_CHUNK_BYTES), 'every byte is covered')
  t.is(ranges.length, 269, '269 ranges, against 1076 at the 4 MiB size this replaces')
  t.is(ranges[0].start, 0, 'the first starts at byte zero')
  t.is(ranges.at(-1).end, TITLE_BYTES - 1, 'the last ends on the final byte')

  // Aggregated rather than asserted per range: 269 of them, and what matters is
  // that not one is out of place.
  let previousEnd = -1
  let contiguous = true
  let oversized = 0
  let full = 0
  for (const { start, end } of ranges) {
    if (start !== previousEnd + 1) contiguous = false
    const size = end - start + 1
    if (size > MAX_SOURCE_CHUNK_BYTES) oversized += 1
    if (size === MAX_SOURCE_CHUNK_BYTES) full += 1
    previousEnd = end
  }
  t.ok(contiguous, 'each follows the one before it with no gap and no overlap')
  t.is(oversized, 0, 'and none asks for more than the callback will serve')
  t.is(full, ranges.length - 1, 'all but the trailing remainder are a whole range')
  t.is(ranges.at(-1).end - ranges.at(-1).start + 1, TITLE_BYTES % MAX_SOURCE_CHUNK_BYTES, 'which is exactly what is left')
})

test('a full read is byte-exact, whether it takes one range or many', async (t) => {
  const bytes = pattern(3 * 1024)

  // The shipped size against a fixture smaller than one range: the whole title
  // in a single 206.
  const whole = servingClient(bytes, MAX_SOURCE_CHUNK_BYTES)
  t.alike(Buffer.concat(await drain(sourceFor(whole, { length: bytes.byteLength }).open(0))), bytes,
    'a title inside one range arrives byte-exact')
  t.alike(whole.ranges, [`bytes=0-${bytes.byteLength - 1}`], 'having been asked for once')

  // And across enough ranges that the read-ahead is reordering-capable if it
  // were going to be. It is not: the bytes come back in file order.
  const split = servingClient(bytes, 512)
  const parts = await drain(sourceFor(split, { length: bytes.byteLength }).open(0))
  t.alike(Buffer.concat(parts), bytes, 'a title spread over six ranges arrives byte-exact and in order')
  t.alike(
    split.ranges,
    ['bytes=0-511', 'bytes=512-1023', 'bytes=1024-1535', 'bytes=1536-2047', 'bytes=2048-2559', 'bytes=2560-3071'],
    'each range asked for once, in order'
  )
  t.is(split.maxInFlight, 1, 'and never two at a time')
})

test('a resumed read asks only for the bytes after the last confirmed one', async (t) => {
  // Resume lands mid-range, which is the case the read-ahead must not round
  // off: the first range starts exactly where the staged prefix ended, and the
  // ones after it are aligned to that offset, not to the file.
  const resumeAt = MAX_SOURCE_CHUNK_BYTES * 3 + 1_234_567
  const client = planningClient(TITLE_BYTES, MAX_SOURCE_CHUNK_BYTES)
  const confirmed = []
  const source = sourceFor(client, {
    length: TITLE_BYTES,
    onProgress: (position) => { confirmed.push(position) }
  })
  await drain(source.open(resumeAt))

  t.is(client.ranges[0].start, resumeAt, 'the first range begins at the resume offset')
  t.is(client.ranges[0].end, resumeAt + MAX_SOURCE_CHUNK_BYTES - 1, 'and is a whole range wide')
  t.is(client.ranges.at(-1).end, TITLE_BYTES - 1, 'the last ends on the final byte')
  t.is(
    client.ranges.reduce((total, { start, end }) => total + (end - start + 1), 0),
    TITLE_BYTES - resumeAt,
    'and between them they ask for the remainder and not one byte more'
  )
  t.is(client.ranges.length, Math.ceil((TITLE_BYTES - resumeAt) / MAX_SOURCE_CHUNK_BYTES), 'in whole ranges')
  t.is(confirmed[0], resumeAt + MAX_SOURCE_CHUNK_BYTES, 'progress is reported from the resumed position')
  t.is(confirmed.at(-1), TITLE_BYTES, 'up to the total length')

  // The finished-but-unsealed attempt still asks for nothing at all.
  const done = servingClient(pattern(64), MAX_SOURCE_CHUNK_BYTES)
  const nothing = await drain(sourceFor(done, { length: 64 }).open(64))
  t.is(nothing.length, 0, 'a read opened at the total length yields nothing')
  t.alike(done.ranges, [], 'and asks the grant for nothing')
})

test('exactly one range is read ahead: never two in flight, never two held', async (t) => {
  const bytes = pattern(2 * 1024)
  const client = servingClient(bytes, 256, {
    // A range that takes a turn of the loop to arrive, so an unbounded
    // read-ahead would have every remaining range in flight by the second chunk.
    onRange: () => new Promise(resolve => setTimeout(resolve, 1))
  })
  const source = sourceFor(client, { length: bytes.byteLength })
  const total = bytes.byteLength / 256

  let consumed = 0
  const observed = []
  for await (const chunk of source.open(0)) {
    consumed += 1
    // The consumer is the slow half — hashing, appending and offloading each
    // block is what the read-ahead exists to overlap.
    await new Promise(resolve => setTimeout(resolve, 2))
    observed.push({ consumed, requested: client.ranges.length, bytes: chunk.byteLength })
  }

  t.is(consumed, total, 'every range was consumed')
  t.is(client.maxInFlight, 1, 'and only ever one request was open')
  for (const point of observed) {
    const ahead = point.requested - point.consumed
    t.is(ahead, point.consumed === total ? 0 : 1,
      `after range ${point.consumed} of ${total}, exactly ${point.consumed === total ? 'nothing' : 'one range'} is read ahead`)
  }
})

test('a consumer that stops leaves no read-ahead transferring bytes nobody asked for', async (t) => {
  const bytes = pattern(2 * 1024)
  const aborts = []
  let release = null
  const held = new Promise(resolve => { release = resolve })
  const client = servingClient(bytes, 256, {
    // The read-ahead is held open, so it is still in flight when the consumer
    // walks away — which is the only moment the abort can be observed.
    onRange ({ start, signal }) {
      if (start === 0) return
      signal?.addEventListener?.('abort', () => {
        aborts.push(start)
        release()
      }, { once: true })
      return held
    }
  })
  const source = sourceFor(client, { length: bytes.byteLength })

  for await (const chunk of source.open(0)) {
    t.is(chunk.byteLength, 256, 'the first range arrived')
    break
  }
  await held

  t.alike(aborts, [256], 'the one range that was read ahead was cancelled on the way out')
  t.is(client.ranges.length, 2, 'and no further range was ever asked for')

  // Nothing is left rejecting into the void: the abandoned read-ahead's failure
  // is absorbed by the source rather than surfacing as an unhandled rejection.
  await new Promise(resolve => setTimeout(resolve, 5))
  t.pass('the abandoned read-ahead settled quietly')
})

test('a read-ahead that fails is raised at the consumer, after the bytes before it', async (t) => {
  const bytes = pattern(1024)
  const broken = new Error('range gone')
  const client = servingClient(bytes, 256, {
    onRange ({ start }) {
      if (start === 512) throw broken
    }
  })
  const failures = []
  const source = sourceFor(client, { length: bytes.byteLength, onFailure: (error) => failures.push(error) })

  const parts = []
  await t.exception(async () => {
    for await (const chunk of source.open(0)) parts.push(Buffer.from(chunk))
  }, /range gone/, 'the failure of a range read ahead still stops the read')

  t.alike(Buffer.concat(parts), bytes.subarray(0, 512), 'every byte confirmed before it was still yielded')
  t.alike(failures, [broken], 'and the caller saw the exception itself, not a flattened message')
  t.alike(client.ranges, ['bytes=0-255', 'bytes=256-511', 'bytes=512-767'], 'no range after the broken one was asked for')
})
