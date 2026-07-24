import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createArchiveChallenge, createArchiveChallengeResponse, verifyArchiveChallengeResponse } from '../src/archive/challenge.js'
import { createArchiveManager } from '../src/archive/manager.js'

const archivist = crypto.keyPair(Buffer.alloc(32, 9))
const auditor = crypto.keyPair(Buffer.alloc(32, 8))
const transport = crypto.keyPair(Buffer.alloc(32, 7))
const archivistId = Buffer.from(archivist.publicKey).toString('hex')
const transportPeerId = Buffer.from(transport.publicKey).toString('hex')
const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)

test('archivist pledge and possession challenge survive adversarial source offload checks', async (t) => {
  const pledge = createArchivePledge({ archivistId, publicationId, renditionId, ranges: [{ coreKey, start: 0, end: 10 }], retentionUntil: 1000, uploadCeilingBytes: 1024, keyPair: archivist })
  const challenge = createArchiveChallenge({ pledgeEnvelope: pledge.envelope, auditorEntropy: Buffer.alloc(32, 6), auditorPublicKey: auditor.publicKey, coreKey, range: { start: 0, end: 10 }, deadline: 50 })
  const response = createArchiveChallengeResponse({ challenge, pledgeEnvelope: pledge.envelope, proof: 'proof', transportPeerId, keyPair: archivist, issuedAt: 10 })
  t.ok(await verifyArchiveChallengeResponse(response.envelope, { challenge, pledgeEnvelope: pledge.envelope, transportPeerId, now: 20 }))

  const manager = createArchiveManager({ now: () => 10 })
  const assessment = manager.createOffloadAssessment({ publicationId, evidence: { durable: true }, expiresAt: 20 })
  t.is(manager.confirmSourceOffload({ publicationId, assessmentId: assessment.assessmentId, evidenceDigest: assessment.evidenceDigest, confirmationNonce: assessment.confirmationNonce, confirmIrrecoverableRisk: true }).accepted, true)
})
