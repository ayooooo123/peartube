import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createPublicationBatch } from '../src/assets/index.js'
import { createPublisherCatalogPage, verifyPublisherCatalogPage } from '../src/discovery/publisher-protocol.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))

function batch(id = 'one') {
  const builder = createPublicationBatch({
    publisherId: Buffer.from(publisher.publicKey).toString('hex'),
    sequence: id === 'one' ? 1 : 2,
  })
  builder.addClaim({
    claimType: 'EntityMetadataClaim',
    claimId: (id === 'one' ? '1' : '2').repeat(64).slice(0, 64),
    subjectRefs: [`work:${id}`],
    payload: { title: `Title ${id}` },
  })
  return builder.seal()
}

test('publisher catalog page signs bounded atomic batches and resumes by cursor', async (t) => {
  const page = createPublisherCatalogPage({
    publisherId: Buffer.from(publisher.publicKey).toString('hex'),
    pageCursor: '0',
    nextCursor: '1',
    catalogHead: 'a'.repeat(64),
    batches: [batch('one')],
    keyPair: publisher,
    issuedAt: 10,
  })
  const verified = await verifyPublisherCatalogPage(page.envelope, { publisherId: Buffer.from(publisher.publicKey).toString('hex'), now: 20 })
  t.is(verified.body.nextCursor, '1')
  t.is(verified.body.batches[0].catalogDigest, batch('one').digest)
  t.is(verified.body.batches[0].entries[0].claimType, 'EntityMetadataClaim')
})

test('publisher catalog page rejects stale heads, oversized pages, forks, and wrong signers', async (t) => {
  t.exception(() => createPublisherCatalogPage({ publisherId: Buffer.from(publisher.publicKey).toString('hex'), pageCursor: '0', nextCursor: '1', catalogHead: 'x', batches: [], keyPair: publisher }), /catalogHead/)
  t.exception(() => createPublisherCatalogPage({ publisherId: Buffer.from(publisher.publicKey).toString('hex'), pageCursor: '0', nextCursor: '1', catalogHead: 'a'.repeat(64), batches: Array.from({ length: 65 }, () => batch('one')), keyPair: publisher }), /too many/)
  const other = crypto.keyPair(Buffer.alloc(32, 2))
  const page = createPublisherCatalogPage({ publisherId: Buffer.from(publisher.publicKey).toString('hex'), pageCursor: '0', nextCursor: null, catalogHead: 'a'.repeat(64), batches: [], keyPair: other })
  t.absent(await verifyPublisherCatalogPage(page.envelope, { publisherId: Buffer.from(publisher.publicKey).toString('hex') }))
})
