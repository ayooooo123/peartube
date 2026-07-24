import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createArchiveChallenge, createArchiveChallengeResponse, verifyArchiveChallengeResponse } from '../src/archive/challenge.js'

const archivist = crypto.keyPair(Buffer.alloc(32, 1))
const auditor = crypto.keyPair(Buffer.alloc(32, 2))
const transport = crypto.keyPair(Buffer.alloc(32, 3))
const archivistId = Buffer.from(archivist.publicKey).toString('hex')
const transportPeerId = Buffer.from(transport.publicKey).toString('hex')
const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)

function pledge() {
  return createArchivePledge({ archivistId, publicationId, renditionId, ranges: [{ coreKey, start: 0, end: 10 }], retentionUntil: 1000, uploadCeilingBytes: 1024, keyPair: archivist }).envelope
}

test('archive challenges bind fresh auditor nonce, pledge id, core/range, proof, transport, and deadline', async (t) => {
  const pledgeEnvelope = pledge()
  const challenge = createArchiveChallenge({ pledgeEnvelope, auditorEntropy: Buffer.alloc(32, 9), coreKey, range: { start: 0, end: 4 }, deadline: 100, auditorPublicKey: auditor.publicKey })
  const response = createArchiveChallengeResponse({ challenge, pledgeEnvelope, proof: 'feedface', transportPeerId, keyPair: archivist, issuedAt: 20 })
  const verified = await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId, now: 50 })
  t.ok(verified)
  t.is(verified.body.challengeNonce, challenge.challengeNonce)
  t.is(verified.body.pledgeId, b4a.toString(pledgeEnvelope.recordId, 'hex'))
})

test('archive challenge response rejects replay, stale proof, wrong range/core, late response, and transport substitution', async (t) => {
  const pledgeEnvelope = pledge()
  const challenge = createArchiveChallenge({ pledgeEnvelope, auditorEntropy: Buffer.alloc(32, 9), coreKey, range: { start: 0, end: 4 }, deadline: 100, auditorPublicKey: auditor.publicKey })
  const response = createArchiveChallengeResponse({ challenge, pledgeEnvelope, proof: 'feedface', transportPeerId, keyPair: archivist, issuedAt: 20 })
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge: { ...challenge, range: { start: 1, end: 4 } }, pledgeEnvelope, transportPeerId, now: 50 }))
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId: 'd'.repeat(64), now: 50 }))
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId, now: 101 }))
})
