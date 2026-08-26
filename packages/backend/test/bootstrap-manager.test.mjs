import test from 'brittle'
import crypto from 'hypercore-crypto'

import {
  BOOTSTRAP_LOCATOR_RECORD_TYPE,
  createBootstrapLocator
} from '../src/discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../src/discovery/bootstrap-manager.js'
import { encodeCanonical } from '../src/publisher/canonical.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'

const signer = crypto.keyPair(Buffer.alloc(32, 1))

function locator(input = {}) {
  return createBootstrapLocator({
    publisherId: input.publisherId || 'a'.repeat(64),
    catalogBootstrapKey: input.catalogBootstrapKey || 'b'.repeat(64),
    catalogHead: input.catalogHead || 'c'.repeat(64),
    catalogEpoch: input.catalogEpoch ?? 1,
    authorizationChainDigest: 'd'.repeat(64),
    expiresAt: 20_000,
    issuedAt: input.issuedAt ?? 10_000,
    keyPair: signer,
    requiredCapabilities: input.requiredCapabilities,
  })
}

test('bootstrap manager replaces per-publisher locators and suppresses replay', async (t) => {
  const manager = createBootstrapManager({ now: () => 15_000, trustedSigners: [signer.publicKey] })
  const first = locator({ catalogHead: '1'.repeat(64), issuedAt: 10_000 })
  const second = locator({ catalogHead: '2'.repeat(64), issuedAt: 11_000 })

  t.is((await manager.ingestLocator('peer-a', first.envelope)).status, 'accepted')
  t.is((await manager.ingestLocator('peer-a', first.envelope)).status, 'replay')
  t.is((await manager.ingestLocator('peer-a', second.envelope)).status, 'accepted')
  t.is(manager.getLocator(first.body.publisherId).catalogHead, '2'.repeat(64))
})

test('bootstrap manager removes an expired availability locator from every read surface', async (t) => {
  let time = 15_000
  const manager = createBootstrapManager({ now: () => time })
  const advertised = locator()
  t.is((await manager.ingestLocator('peer-a', advertised.envelope)).status, 'accepted')
  t.is(manager.listLocators().length, 1)
  time = advertised.body.expiresAt + 1
  t.absent(manager.getLocator(advertised.body.publisherId))
  t.alike(manager.listLocators(), [])
  t.alike(manager.getIntroducedPublisherIds(), [])
})

test('a structurally valid unknown locator is retained only as an unverified proof candidate', async (t) => {
  const manager = createBootstrapManager({ now: () => 15_000, trustedSigners: [] })
  const result = await manager.ingestLocator('peer-a', locator().envelope)
  t.is(result.status, 'accepted')
  t.is(manager.getLocator('a'.repeat(64)).trusted, false)
  t.is(manager.getLocator('a'.repeat(64)).catalogChainVerified, false)
})

test('bootstrap manager enforces per-peer quotas and never opens media/core replication', async (t) => {
  const opened = []
  const manager = createBootstrapManager({ now: () => 15_000, trustedSigners: [signer.publicKey], maxLocatorsPerPeer: 1, openCore: key => opened.push(key) })
  t.is((await manager.ingestLocator('peer-a', locator({ publisherId: 'a'.repeat(64) }).envelope)).status, 'accepted')
  t.is((await manager.ingestLocator('peer-a', locator({ publisherId: 'e'.repeat(64) }).envelope)).status, 'quota-exceeded')
  t.alike(opened, [])
})

test('bootstrap manager quarantines compatibility failures before locator projection', async (t) => {
  const accepted = []
  const manager = createBootstrapManager({
    now: () => 15_000,
    trustedSigners: [signer.publicKey],
    acceptLocator: body => accepted.push(body),
  })
  const incompatible = locator({ requiredCapabilities: ['future-bootstrap:v1'] })
  const result = await manager.ingestLocator('peer-a', incompatible.envelope)
  t.is(result.status, 'quarantined')
  t.is(result.errorCode, 'PROTOCOL_CAPABILITY_UNSUPPORTED')
  t.alike(accepted, [], 'compatibility failure precedes locator projection')
  t.absent(manager.getLocator(incompatible.body.publisherId))
})

test('bootstrap manager preserves the stable code for malformed compatibility advertisements', async (t) => {
  const valid = locator()
  const malformedBody = { ...valid.body, protocolMinor: '0' }
  const envelope = createApplicationEnvelope({
    recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE,
    body: encodeCanonical(malformedBody),
    keyPair: signer,
    issuedAt: malformedBody.issuedAt,
    expiresAt: malformedBody.expiresAt,
  })
  const manager = createBootstrapManager({
    now: () => 15_000,
    trustedSigners: [signer.publicKey],
  })
  const result = await manager.ingestLocator('peer-a', envelope)
  t.is(result.status, 'quarantined')
  t.is(result.errorCode, 'PROTOCOL_ADVERTISEMENT_REQUIRED')
})
