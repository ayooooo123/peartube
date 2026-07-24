import test from 'brittle'

import { createArchiveManager } from '../src/archive/manager.js'

test('archive manager binds destructive offload to fresh assessment, digest, nonce, and risk ack', async (t) => {
  const manager = createArchiveManager({ now: () => 10 })
  const assessment = manager.createOffloadAssessment({ publicationId: 'a'.repeat(64), evidence: { durable: true }, expiresAt: 20 })
  t.is(manager.confirmSourceOffload({ publicationId: 'a'.repeat(64), assessmentId: assessment.assessmentId, evidenceDigest: assessment.evidenceDigest, confirmationNonce: assessment.confirmationNonce, confirmIrrecoverableRisk: false }).accepted, false)
  t.is(manager.confirmSourceOffload({ publicationId: 'b'.repeat(64), assessmentId: assessment.assessmentId, evidenceDigest: assessment.evidenceDigest, confirmationNonce: assessment.confirmationNonce, confirmIrrecoverableRisk: true }).accepted, false)
  t.is(manager.confirmSourceOffload({ publicationId: 'a'.repeat(64), assessmentId: assessment.assessmentId, evidenceDigest: assessment.evidenceDigest, confirmationNonce: assessment.confirmationNonce, confirmIrrecoverableRisk: true }).accepted, true)
  t.is(manager.confirmSourceOffload({ publicationId: 'a'.repeat(64), assessmentId: assessment.assessmentId, evidenceDigest: assessment.evidenceDigest, confirmationNonce: assessment.confirmationNonce, confirmIrrecoverableRisk: true }).accepted, false)
})
