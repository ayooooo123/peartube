import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createArchivePledge, verifyArchivePledge } from '../src/archive/pledge.js'

const archivist = crypto.keyPair(Buffer.alloc(32, 1))
const archivistId = Buffer.from(archivist.publicKey).toString('hex')
const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)

function ranges() {
  return [{ coreKey, start: 0, end: 10 }]
}

test('archive pledge signs bounded canonical retention facts without self-hashing envelope id', async (t) => {
  const pledge = createArchivePledge({ archivistId, publicationId, renditionId, ranges: ranges(), retentionUntil: 1000, uploadCeilingBytes: 1024, policyEpoch: 0, nonce: 'n1', keyPair: archivist, issuedAt: 10 })
  const verified = await verifyArchivePledge(pledge.envelope, { archivistId, now: 20 })
  t.ok(verified)
  t.is(verified.body.publicationId, publicationId)
  t.is(verified.body.ranges[0].coreKey, coreKey)
  t.absent(verified.body.pledgeId)
  t.is(pledge.pledgeId, b4a.toString(pledge.envelope.recordId, 'hex'))
})

test('archive pledge rejects malformed, oversized, expired, and wrong-signer pledges', async (t) => {
  t.exception(() => createArchivePledge({ archivistId, publicationId, renditionId, ranges: [], retentionUntil: 1000, uploadCeilingBytes: 1, keyPair: archivist }), /ranges/)
  t.exception(() => createArchivePledge({ archivistId, publicationId, renditionId, ranges: Array.from({ length: 65 }, () => ranges()[0]), retentionUntil: 1000, uploadCeilingBytes: 1, keyPair: archivist }), /too many/)
  const other = crypto.keyPair(Buffer.alloc(32, 2))
  const pledge = createArchivePledge({ archivistId, publicationId, renditionId, ranges: ranges(), retentionUntil: 1000, uploadCeilingBytes: 1, keyPair: other })
  t.absent(await verifyArchivePledge(pledge.envelope, { archivistId, now: 10 }))
  const expired = createArchivePledge({ archivistId, publicationId, renditionId, ranges: ranges(), retentionUntil: 1, uploadCeilingBytes: 1, keyPair: archivist })
  t.absent(await verifyArchivePledge(expired.envelope, { archivistId, now: 2 }))
})
