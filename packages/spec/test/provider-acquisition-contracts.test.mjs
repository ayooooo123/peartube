import test from 'brittle'
import c from 'compact-encoding'
import { createRequire } from 'node:module'

const schema = createRequire(import.meta.url)('../spec/schema/index.js')

// Frames emitted before structured provider selectors and index-service policy.
// Generated codecs must continue to interpret the existing flag positions.
test('structured provider search preserves historical query cursor and limit bytes', (t) => {
  const frame = Buffer.from('074172726976616c03096e6578742d7061676514', 'hex')
  const encoding = schema.getEncoding('@peartube/provider-search-request')
  const request = c.decode(encoding, frame)
  t.is(request.query, 'Arrival')
  t.is(request.cursor, 'next-page')
  t.is(request.limit, 20)
  t.alike(c.encode(encoding, request), frame)
})

test('index-service policy additions do not reinterpret historical policy flags', (t) => {
  for (const [name, hex] of [
    ['get-network-policy-response', 'fd8007095b22696e646578225d0d5b226d6f64657261746f72225d036f66660862616c616e636564'],
    ['set-network-policy-request', 'fd001e095b22696e646578225d0d5b226d6f64657261746f72225d036f66660862616c616e636564'],
  ]) {
    const frame = Buffer.from(hex, 'hex')
    const encoding = schema.getEncoding(`@peartube/${name}`)
    const policy = c.decode(encoding, frame)
    t.is(policy.followedIndexesJson, '["index"]')
    t.is(policy.trustedModerationFeedsJson, '["moderator"]')
    t.is(policy.aiAnalysis, 'off')
    t.is(policy.participationMode, 'balanced')
    t.alike(c.encode(encoding, policy), frame)
  }
})

test('acquisition labels and structured coordinates survive the wire without private locators', t => {
  const request = {
    schemaVersion: 1, resolutionRef: 'r'.repeat(43), publisherId: 'p'.repeat(64),
    retentionClass: 'archive-pin', retentionUntil: 9000, retentionUntilPresent: true,
    sourceFileName: 'Episode.S01E02.mp4',
  }
  const requestCodec = schema.getEncoding('@peartube/acquisition-request-v1')
  t.alike(c.decode(requestCodec, c.encode(requestCodec, request)), request)
  const codec = schema.getEncoding('@peartube/acquisition-v1')
  const result = c.decode(codec, c.encode(codec, {
    schemaVersion: 1, acquisitionId: 'acq_wire', state: 'queued', retentionClass: 'archive-pin',
    bytesAcquired: 0, recoverable: false, createdAt: 1, updatedAt: 1,
    title: 'Episode title', sourceFileName: request.sourceFileName,
    mediaContext: { kind: 'episode', namespace: 'catalog', identifier: 'series-1', season: 1, episode: 2 },
  }))
  t.is(result.title, 'Episode title')
  t.is(result.sourceFileName, request.sourceFileName)
  t.is(result.mediaContext.identifier, 'series-1')
  t.is(result.mediaContext.episode, 2)
})
