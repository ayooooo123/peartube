import test from 'brittle'
import { createGrantedRangedSource } from '../src/archive-manager.js'

// An archive's throughput was misdiagnosed twice from progress counters alone:
// cold upstream opens were eliminated and the rate did not move. The per-range
// split is what distinguishes the two remaining candidates - a slow source from
// a slow local hash/append/offload path - so it has to actually be emitted.
test('a served range reports the upstream wait and the consumer cost separately', async (t) => {
  const chunkBytes = 8
  const body = Buffer.from('0123456789abcdef')
  const lines = []
  const logger = { archive: { info: (message, fields) => lines.push({ message, ...fields }) } }
  const client = {
    chunkBytes,
    getRange: async ({ start, end, onChunk }) => {
      // Cost the fetch so a zero would have to come from the read-ahead working,
      // not from nothing ever being timed.
      await new Promise((resolve) => setTimeout(resolve, 12))
      onChunk(body.subarray(start, end + 1))
    }
  }
  const source = createGrantedRangedSource({
    client,
    capability: 'cap',
    jobId: 'ing_test',
    etag: 'etag',
    length: body.byteLength,
    logger
  })

  const received = []
  for await (const part of source.open(0)) {
    received.push(part)
    // Make the consumer the expensive side for the first range only.
    if (received.length === 1) await new Promise((resolve) => setTimeout(resolve, 30))
  }

  t.is(Buffer.concat(received).toString(), body.toString(), 'the whole body still arrives')
  t.is(lines.length, 2, 'one line per range')
  t.is(lines[0].message, '[archive-range] served')
  t.is(lines[0].jobId, 'ing_test')
  t.is(lines[0].bytes, chunkBytes, 'reports the bytes that range carried')
  t.ok(lines[0].consumeMs >= 25, `a slow consumer is attributed to consume, got ${lines[0].consumeMs}ms`)
  // The second range was fetched while the first was being consumed, so its
  // upstream wait is the read-ahead's benefit made visible.
  t.ok(lines[1].fetchMs < 12, `read-ahead hides the fetch, got ${lines[1].fetchMs}ms`)
})
