import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { hashCanonical, toHex } from '../publisher/canonical.js'

function hex32(value, name) {
  return toHex(value, 32, name)
}

function randomHex32() {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

export function createArchiveManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const assessments = new Map()
  const usedNonces = new Set()

  return {
    createOffloadAssessment(input = {}) {
      const publicationId = hex32(input.publicationId, 'publicationId')
      const evidence = input.evidence || {}
      const evidenceDigest = b4a.toString(hashCanonical('peartube.archive.offload-evidence.v1', evidence), 'hex')
      const assessmentId = b4a.toString(hashCanonical('peartube.archive.offload-assessment.v1', { publicationId, evidenceDigest, issuedAt: now() }), 'hex')
      const assessment = {
        publicationId,
        assessmentId,
        evidenceDigest,
        expiresAt: Number(input.expiresAt) || now() + 5 * 60 * 1000,
        policyVersion: 1,
        confirmationNonce: randomHex32(),
        eligible: Boolean(evidence.durable),
      }
      assessments.set(assessmentId, assessment)
      return assessment
    },
    confirmSourceOffload(input = {}) {
      const assessment = assessments.get(String(input.assessmentId || ''))
      if (!assessment) return { accepted: false, reason: 'assessment-not-found' }
      if (usedNonces.has(assessment.confirmationNonce)) return { accepted: false, reason: 'nonce-used' }
      if (now() > assessment.expiresAt) return { accepted: false, reason: 'assessment-expired' }
      if (!input.confirmIrrecoverableRisk) return { accepted: false, reason: 'irrecoverable-risk-not-confirmed' }
      if (hex32(input.publicationId, 'publicationId') !== assessment.publicationId) return { accepted: false, reason: 'publication-mismatch' }
      if (input.evidenceDigest !== assessment.evidenceDigest) return { accepted: false, reason: 'evidence-mismatch' }
      if (input.confirmationNonce !== assessment.confirmationNonce) return { accepted: false, reason: 'nonce-mismatch' }
      if (!assessment.eligible) return { accepted: false, reason: 'not-eligible' }
      usedNonces.add(assessment.confirmationNonce)
      return { accepted: true, assessment }
    },
  }
}
