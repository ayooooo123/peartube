import test from 'brittle'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import { createIndexFeedPage } from '../src/indexing/feed-contract.js'
import {
  decodeFeedPageRequest,
  decodeFeedPageResponse,
  encodeFeedPageRequest,
  encodeFeedPageResponse,
} from '../src/network/scoped-runtime.js'

const curator = crypto.keyPair(Buffer.alloc(32, 44))
const curatorId = Buffer.from(curator.publicKey).toString('hex')

test('scoped feed request framing is exact, versioned, bounded, and canonical', (t) => {
  const encoded = encodeFeedPageRequest({ purpose: 'index', cursor: '0' })
  t.alike(decodeFeedPageRequest(encoded, { purpose: 'index' }), {
    cursor: '0',
    minimumProtocolMajor: 1,
    protocolMinor: 0,
    requiredCapabilities: ['index-feed:v1'],
  })
  t.exception(() => encodeFeedPageRequest({ purpose: 'index', cursor: '0', extra: true }))
  t.exception(() => encodeFeedPageRequest({ purpose: 'index', cursor: 'x'.repeat(257) }))
  t.exception(() => decodeFeedPageRequest(Buffer.concat([encoded, Buffer.from([0])]), { purpose: 'index' }))
  t.exception(() => decodeFeedPageRequest(
    Buffer.concat([Buffer.from('fd0100', 'hex'), encoded.subarray(1)]),
    { purpose: 'index' },
  ), 'alternate non-minimal varint is noncanonical')
  t.exception(() => decodeFeedPageRequest(
    c.encode(c.any, { cursor: '0', extra: true }),
    { purpose: 'index' },
  ), 'legacy any/object framing is rejected')
  t.exception(() => decodeFeedPageRequest(encoded, { purpose: 'moderation' }), 'capability mismatch is rejected')
})

test('scoped feed response framing bounds authenticated page bytes and rejects trailing data', (t) => {
  const page = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:frame',
      publicationId: 'a'.repeat(64),
      publisherId: 'b'.repeat(64),
    }],
    keyPair: curator,
    expiresAt: 100,
  })
  const encoded = encodeFeedPageResponse({
    purpose: 'index',
    cursor: '0',
    envelope: page.envelope,
  })
  const decoded = decodeFeedPageResponse(encoded, { purpose: 'index' })
  t.is(decoded.cursor, '0')
  t.alike(decoded.requiredCapabilities, ['index-feed:v1'])
  t.alike(decoded.envelope.recordId, page.envelope.recordId)
  t.exception(() => encodeFeedPageResponse({
    purpose: 'index',
    cursor: '0',
    envelope: page.envelope,
    extra: true,
  }))
  t.exception(() => decodeFeedPageResponse(Buffer.concat([encoded, Buffer.from([0])]), { purpose: 'index' }))
})
