import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createArchiveProtocol } from '../src/archive/protocol.js'
import { createArchivePledge } from '../src/archive/pledge.js'

const archivist = crypto.keyPair(Buffer.alloc(32, 1))
const archivistId = Buffer.from(archivist.publicKey).toString('hex')

function pledge() {
  return createArchivePledge({ archivistId, publicationId: 'a'.repeat(64), renditionId: 'b'.repeat(64), ranges: [{ coreKey: 'c'.repeat(64), start: 0, end: 1 }], retentionUntil: 1000, uploadCeilingBytes: 1, keyPair: archivist }).envelope
}

test('archive protocol applies common frame/admission limits and per-peer challenge quotas', async (t) => {
  const protocol = createArchiveProtocol({ maxFrameBytes: 256, maxChallengesPerPeer: 1 })
  const peerId = 'p1'
  t.is(await protocol.ingestPledge({ peerId, envelope: pledge() }), true)
  t.is(protocol.beginChallenge(peerId), true)
  t.is(protocol.beginChallenge(peerId), false)
  t.is(await protocol.ingestFrame({ peerId, bytes: Buffer.alloc(512) }), false)
  protocol.endChallenge(peerId)
  t.is(protocol.beginChallenge(peerId), true)
})
