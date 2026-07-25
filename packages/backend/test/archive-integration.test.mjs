import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createArchiveChallenge, createArchiveChallengeResponse, createArchivePossessionProof, verifyArchiveChallengeResponse } from '../src/archive/challenge.js'
import { createArchiveManager } from '../src/archive/manager.js'

const archivist = crypto.keyPair(Buffer.alloc(32, 9))
const auditor = crypto.keyPair(Buffer.alloc(32, 8))
const transport = crypto.keyPair(Buffer.alloc(32, 7))
const archivistId = Buffer.from(archivist.publicKey).toString('hex')
const transportPeerId = Buffer.from(transport.publicKey).toString('hex')
const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)
const proofBytes = Buffer.from('bounded-hypercore-proof')
const verifyProof = async bytes => Buffer.from(bytes).equals(proofBytes)

test('archivist pledge and possession challenge survive adversarial source offload checks', async (t) => {
  const pledge = createArchivePledge({ archivistId, publicationId, renditionId, ranges: [{ coreKey, start: 0, end: 10 }], retentionUntil: 1000, uploadCeilingBytes: 1024, keyPair: archivist })
  const challenge = createArchiveChallenge({ pledgeEnvelope: pledge.envelope, auditorEntropy: Buffer.alloc(32, 6), auditorPublicKey: auditor.publicKey, coreKey, range: { start: 7, end: 8 }, deadline: 50 })
  const proof = createArchivePossessionProof({ challenge, proofBytes })
  const response = createArchiveChallengeResponse({ challenge, pledgeEnvelope: pledge.envelope, proof, transportPeerId, keyPair: archivist, issuedAt: 10 })
  t.ok(await verifyArchiveChallengeResponse(response.envelope, {
    challenge,
    pledgeEnvelope: pledge.envelope,
    transportPeerId,
    now: 20,
    proofBytes,
    verifyProof,
    replayCache: new Set(),
  }))

  const manager = createArchiveManager({
    now: () => 10,
    collectEvidence: async () => ({
      byteLength: 1024,
      activePlayback: false,
      localPhysicalDeviceId: 'desktop-a',
      publisherDeviceCopies: [
        { deviceId: 'phone', physicalDeviceId: 'phone-b', connected: true, fullCopy: true, publisherControlled: true },
      ],
    }),
    deleteSource: async ({ authorize }) => {
      const authorization = await authorize()
      return authorization.success ? { success: true, freedBytes: 1024 } : authorization
    },
  })
  const assessment = await manager.createOffloadAssessment({ publicationId })
  t.is((await manager.confirmSourceOffload({
    publicationId,
    assessmentId: assessment.assessmentId,
    evidenceDigest: assessment.evidenceDigest,
    confirmationNonce: assessment.confirmationNonce,
    policyVersion: assessment.policyVersion,
    confirmIrrecoverableRisk: true,
  })).accepted, true)
})
