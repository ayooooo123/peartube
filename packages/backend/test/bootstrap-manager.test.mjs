import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createBootstrapLocator } from '../src/discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../src/discovery/bootstrap-manager.js'

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

test('bootstrap manager enforces per-peer quotas and never opens media/core replication', async (t) => {
  const opened = []
  const manager = createBootstrapManager({ now: () => 15_000, trustedSigners: [signer.publicKey], maxLocatorsPerPeer: 1, openCore: key => opened.push(key) })
  t.is((await manager.ingestLocator('peer-a', locator({ publisherId: 'a'.repeat(64) }).envelope)).status, 'accepted')
  t.is((await manager.ingestLocator('peer-a', locator({ publisherId: 'e'.repeat(64) }).envelope)).status, 'quota-exceeded')
  t.alike(opened, [])
})
