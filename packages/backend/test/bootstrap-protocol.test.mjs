import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createBootstrapLocator, verifyBootstrapLocator } from '../src/discovery/bootstrap-protocol.js'

const signer = crypto.keyPair(Buffer.alloc(32, 1))
const trustedRoot = crypto.keyPair(Buffer.alloc(32, 2))

function locator(overrides = {}) {
  return createBootstrapLocator({
    publisherId: 'a'.repeat(64),
    catalogBootstrapKey: 'b'.repeat(64),
    catalogHead: 'c'.repeat(64),
    catalogEpoch: 2,
    authorizationChainDigest: 'd'.repeat(64),
    expiresAt: 20_000,
    issuedAt: 10_000,
    keyPair: signer,
    ...overrides,
  })
}

test('bootstrap locator is bounded, signed, expiring, and metadata-only', async (t) => {
  const record = locator()
  t.ok(record.locatorId)
  t.is(record.body.publisherId, 'a'.repeat(64))
  t.absent(record.body.mediaCoreKey)
  t.absent(record.body.mirrorKey)
  t.ok(await verifyBootstrapLocator(record.envelope, { now: 15_000, trustedSigners: [signer.publicKey] }))
  t.absent(await verifyBootstrapLocator(record.envelope, { now: 21_001, trustedSigners: [signer.publicKey], maxClockSkewMs: 1000 }))
  t.absent(await verifyBootstrapLocator({ ...record.envelope, body: b4a.from(record.envelope.body).subarray(0, 8) }, { now: 15_000, trustedSigners: [signer.publicKey] }))
})

test('unknown bootstrap signer stays an untrusted locator until catalog chain verifies', async (t) => {
  const record = locator({ rootSignerId: b4a.toString(trustedRoot.publicKey, 'hex') })
  const result = await verifyBootstrapLocator(record.envelope, {
    now: 15_000,
    trustedSigners: [],
    trustedRootIds: [b4a.toString(trustedRoot.publicKey, 'hex')],
    verifyCatalogChain({ catalogBootstrapKey, authorizationChainDigest }) {
      t.is(catalogBootstrapKey, 'b'.repeat(64))
      t.is(authorizationChainDigest, 'd'.repeat(64))
      return true
    },
  })
  t.is(result.trusted, false)
  t.is(result.catalogChainVerified, true)
  t.is(result.acceptedHead, 'c'.repeat(64))
})

test('bootstrap locator rejects oversized announcements and malformed fixed hashes', (t) => {
  t.exception(() => locator({ catalogHead: 'x' }), /catalogHead/)
  t.exception(() => locator({ extraLocators: Array.from({ length: 65 }, (_, index) => String(index)) }), /too many/)
  t.exception(() => locator({ label: 'x'.repeat(2049) }), /too large/)
})
