import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createArchiveChallenge, createArchiveChallengeEnvelope, createArchiveChallengeResponse, createArchivePossessionProof, verifyArchiveChallengeEnvelope, verifyArchiveChallengeResponse } from '../src/archive/challenge.js'

const archivist = crypto.keyPair(Buffer.alloc(32, 1))
const auditor = crypto.keyPair(Buffer.alloc(32, 2))
const transport = crypto.keyPair(Buffer.alloc(32, 3))
const archivistId = Buffer.from(archivist.publicKey).toString('hex')
const transportPeerId = Buffer.from(transport.publicKey).toString('hex')
const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)
const proofBytes = Buffer.from('bounded-hypercore-proof')
const verifyProof = async (bytes) => b4a.equals(bytes, proofBytes)

function pledge() {
  return createArchivePledge({ archivistId, publicationId, renditionId, ranges: [{ coreKey, start: 0, end: 10 }], retentionUntil: 1000, uploadCeilingBytes: 1024, keyPair: archivist }).envelope
}

test('archive challenges bind fresh auditor nonce, pledge id, core/range, proof, transport, and deadline', async (t) => {
  const pledgeEnvelope = pledge()
  const challenge = createArchiveChallenge({ pledgeEnvelope, auditorEntropy: Buffer.alloc(32, 9), coreKey, range: { start: 2, end: 3 }, deadline: 100, auditorPublicKey: auditor.publicKey })
  const proof = createArchivePossessionProof({ challenge, proofBytes })
  const response = createArchiveChallengeResponse({ challenge, pledgeEnvelope, proof, transportPeerId, keyPair: archivist, issuedAt: 20 })
  const verified = await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId, now: 50, proofBytes, verifyProof, replayCache: new Set() })
  t.ok(verified)
  t.is(verified.body.challengeNonce, challenge.challengeNonce)
  t.is(verified.body.pledgeId, b4a.toString(pledgeEnvelope.recordId, 'hex'))
})

test('archive challenge response rejects replay, stale proof, wrong range/core, late response, and transport substitution', async (t) => {
  const pledgeEnvelope = pledge()
  const challenge = createArchiveChallenge({ pledgeEnvelope, auditorEntropy: Buffer.alloc(32, 9), coreKey, range: { start: 2, end: 3 }, deadline: 100, auditorPublicKey: auditor.publicKey })
  const proof = createArchivePossessionProof({ challenge, proofBytes })
  const response = createArchiveChallengeResponse({ challenge, pledgeEnvelope, proof, transportPeerId, keyPair: archivist, issuedAt: 20 })
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge: { ...challenge, range: { start: 1, end: 2 } }, pledgeEnvelope, transportPeerId, now: 50, proofBytes, verifyProof, replayCache: new Set() }))
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId: 'd'.repeat(64), now: 50, proofBytes, verifyProof, replayCache: new Set() }))
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId, now: 101, proofBytes, verifyProof, replayCache: new Set() }))
  t.absent(await verifyArchiveChallengeResponse(response.envelope, {
    challenge,
    pledgeEnvelope,
    transportPeerId,
    now: 50,
    proofBytes: Buffer.from('stale-hypercore-proof'),
    verifyProof,
    replayCache: new Set(),
  }))
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId, now: 50, proofBytes, replayCache: new Set() }))
  const forgedPledge = { ...pledgeEnvelope, body: b4a.from(pledgeEnvelope.body) }
  forgedPledge.body[0] ^= 1
  t.absent(await verifyArchiveChallengeResponse(response.envelope, {
    challenge,
    pledgeEnvelope: forgedPledge,
    transportPeerId,
    now: 50,
    proofBytes,
    verifyProof,
    replayCache: new Set(),
  }))
  const replayCache = new Set()
  t.ok(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId, now: 50, proofBytes, verifyProof, replayCache }))
  t.absent(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope, transportPeerId, now: 50, proofBytes, verifyProof, replayCache }))
})

test('archive challenge requests are signed by the unpredictable auditor identity', async (t) => {
  const pledgeEnvelope = pledge()
  const challenge = createArchiveChallenge({ pledgeEnvelope, auditorEntropy: Buffer.alloc(32, 7), coreKey, range: { start: 2, end: 3 }, deadline: 100, auditorPublicKey: auditor.publicKey })
  const signed = createArchiveChallengeEnvelope({ challenge, keyPair: auditor, issuedAt: 10 })
  t.alike(await verifyArchiveChallengeEnvelope(signed.envelope, { now: 50 }), challenge)
  t.absent(await verifyArchiveChallengeEnvelope({ ...signed.envelope, signer: archivist.publicKey }, { now: 50 }))
  t.absent(await verifyArchiveChallengeEnvelope(signed.envelope, { now: 101 }))
})
