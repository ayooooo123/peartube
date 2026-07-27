import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  BOOTSTRAP_LOCATOR_CAPABILITY,
  BOOTSTRAP_LOCATOR_RECORD_TYPE,
  MAX_BOOTSTRAP_EXTRA_LOCATOR_BYTES,
  MAX_BOOTSTRAP_EXTRA_LOCATORS_BYTES,
  createBootstrapLocator,
  verifyBootstrapLocator
} from '../src/discovery/bootstrap-protocol.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'
import { encodeCanonical } from '../src/publisher/canonical.js'
import { PROTOCOL_ERROR_CODES } from '../src/network/index.js'

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
test('bootstrap locator advertises canonical compatibility and rejects unknown requirements before catalog verification', async (t) => {
  const record = locator({ requiredCapabilities: ['z-extension:v1', 'a-extension:v1', 'z-extension:v1'], protocolMinor: 9 })
  t.is(record.body.minimumProtocolMajor, 1)
  t.is(record.body.protocolMinor, 9)
  t.alike(record.body.requiredCapabilities, [
    'a-extension:v1',
    BOOTSTRAP_LOCATOR_CAPABILITY,
    'z-extension:v1',
  ])
  let catalogVerifications = 0
  try {
    await verifyBootstrapLocator(record.envelope, {
      now: 15_000,
      trustedSigners: [signer.publicKey],
      supportedCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
      verifyCatalogChain() {
        catalogVerifications++
        return true
      },
    })
    t.fail('unknown required locator capability must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  }
  t.is(catalogVerifications, 0, 'compatibility rejection does not fall through to another catalog path')
  t.ok(await verifyBootstrapLocator(record.envelope, {
    now: 15_000,
    trustedSigners: [signer.publicKey],
    supportedCapabilities: [
      BOOTSTRAP_LOCATOR_CAPABILITY,
      'a-extension:v1',
      'z-extension:v1',
    ],
  }), 'newer minor metadata is accepted when every required capability is supported')
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

test('bootstrap extra locators are exact bounded metadata strings before signing or acceptance', async (t) => {
  t.exception(
    () => locator({ extraLocators: [{ mediaBytes: Buffer.alloc(4096) }] }),
    /extra locator.*metadata string/i
  )
  t.exception(
    () => locator({ extraLocators: ['x'.repeat(MAX_BOOTSTRAP_EXTRA_LOCATOR_BYTES + 1)] }),
    /extra locator.*byte limit/i
  )
  t.exception(
    () => locator({
      extraLocators: Array.from(
        { length: MAX_BOOTSTRAP_EXTRA_LOCATORS_BYTES / MAX_BOOTSTRAP_EXTRA_LOCATOR_BYTES + 1 },
        (_, index) => `${index}:`.padEnd(MAX_BOOTSTRAP_EXTRA_LOCATOR_BYTES, 'x')
      ),
    }),
    /extra locators.*total byte limit/i
  )

  const valid = locator()
  const maliciousBody = { ...valid.body, mediaBytes: '00'.repeat(4096) }
  const maliciousEnvelope = createApplicationEnvelope({
    recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE,
    body: encodeCanonical(maliciousBody),
    keyPair: signer,
    issuedAt: maliciousBody.issuedAt,
    expiresAt: maliciousBody.expiresAt,
  })
  t.absent(await verifyBootstrapLocator(maliciousEnvelope, {
    now: 15_000,
    trustedSigners: [signer.publicKey],
  }), 'signed unknown fields do not bypass the metadata-only locator schema')
})

test('online bootstrap verifier never opts locator omissions into legacy compatibility', async (t) => {
  const valid = locator()
  const {
    minimumProtocolMajor: _minimumProtocolMajor,
    protocolMinor: _protocolMinor,
    requiredCapabilities: _requiredCapabilities,
    ...legacyBody
  } = valid.body
  const envelope = createApplicationEnvelope({
    recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE,
    body: encodeCanonical(legacyBody),
    keyPair: signer,
    issuedAt: legacyBody.issuedAt,
    expiresAt: legacyBody.expiresAt,
  })
  try {
    await verifyBootstrapLocator(envelope, {
      now: 15_000,
      trustedSigners: [signer.publicKey],
      legacyCompatibility: {
        minimumProtocolMajor: 1,
        protocolMinor: 0,
        requiredCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
      },
    })
    t.fail('online bootstrap omission must fail closed')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
})

// Two devices never agree on the time to the millisecond. With no tolerance a
// consumer whose clock sat seconds behind a publisher rejected every locator
// the publisher issued "now" as INVALID_LOCATOR, and could never discover
// anything at all - which is exactly what an emulator running ~27s behind its
// host did.
test('a locator issued slightly ahead of this clock is still usable', async (t) => {
  const record = locator({ issuedAt: 10_000, expiresAt: 20_000 })

  t.absent(
    await verifyBootstrapLocator(record.envelope, { now: 9_970, trustedSigners: [signer.publicKey] }),
    'with no tolerance a locator 30s in the future is refused',
  )
  t.ok(
    await verifyBootstrapLocator(record.envelope, {
      now: 9_970,
      maxClockSkewMs: 60_000,
      trustedSigners: [signer.publicKey],
    }),
    'modest drift is tolerated when a skew allowance is configured',
  )
})

// Tolerance must not become an unbounded window: the locator's own lifetime
// still decides when it stops being usable.
test('clock tolerance does not resurrect a locator that has genuinely expired', async (t) => {
  const record = locator({ issuedAt: 10_000, expiresAt: 20_000 })

  t.ok(
    await verifyBootstrapLocator(record.envelope, {
      now: 20_030,
      maxClockSkewMs: 60_000,
      trustedSigners: [signer.publicKey],
    }),
    'a locator just past expiry is still accepted inside the allowance',
  )
  t.absent(
    await verifyBootstrapLocator(record.envelope, {
      now: 200_000,
      maxClockSkewMs: 60_000,
      trustedSigners: [signer.publicKey],
    }),
    'a long-expired locator stays refused',
  )
})
