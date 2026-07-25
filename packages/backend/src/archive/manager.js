import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { hashCanonical, toHex } from '../publisher/canonical.js'
import { assessArchiveConfidence, normalizeArchiveEvidence } from './confidence.js'

export const SOURCE_OFFLOAD_POLICY_VERSION = 1
const DEFAULT_ASSESSMENT_TTL_MS = 5 * 60 * 1000
const MAX_ASSESSMENTS = 256
const MAX_AUDIT_RECORDS = 256

function hex32(value, name) {
  return toHex(value, 32, name)
}

function randomHex32() {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

function digestEvidence(evidence) {
  return b4a.toString(hashCanonical('peartube.archive.offload-evidence.v1', evidence), 'hex')
}

function stateForPersistence(assessments, audits) {
  return {
    version: 1,
    assessments: Array.from(assessments.values(), assessment => ({ ...assessment, limitations: assessment.limitations.slice() })),
    audits: audits.map(audit => ({ ...audit })),
  }
}

function restoreState(value) {
  const assessments = new Map()
  const audits = []
  if (value == null) return { assessments, audits }
  if (value.version !== 1 || !Array.isArray(value.assessments) || !Array.isArray(value.audits) ||
      value.assessments.length > MAX_ASSESSMENTS || value.audits.length > MAX_AUDIT_RECORDS) {
    throw new Error('source offload state is invalid')
  }
  for (const assessment of value.assessments) {
    const assessmentId = hex32(assessment.assessmentId, 'assessmentId')
    const publicationId = hex32(assessment.publicationId, 'publicationId')
    const evidenceDigest = hex32(assessment.evidenceDigest, 'evidenceDigest')
    const confirmationNonce = hex32(assessment.confirmationNonce, 'confirmationNonce')
    assessments.set(assessmentId, {
      ...assessment,
      assessmentId,
      publicationId,
      evidenceDigest,
      confirmationNonce,
      limitations: Array.isArray(assessment.limitations) ? assessment.limitations.slice(0, 32).map(String) : [],
      consumed: assessment.consumed === true,
    })
  }
  for (const audit of value.audits.slice(-MAX_AUDIT_RECORDS)) audits.push({ ...audit })
  return { assessments, audits }
}

export function createArchiveManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const collectEvidence = typeof options.collectEvidence === 'function' ? options.collectEvidence : async () => ({})
  const deleteSource = typeof options.deleteSource === 'function' ? options.deleteSource : async () => ({ success: false, reason: 'delete-unavailable' })
  const diagnostics = options.diagnostics || null
  const repository = options.repository || null
  const policyVersion = Number.isSafeInteger(options.policyVersion) ? options.policyVersion : SOURCE_OFFLOAD_POLICY_VERSION
  const ttlMs = Number.isSafeInteger(options.assessmentTtlMs) && options.assessmentTtlMs > 0
    ? Math.min(options.assessmentTtlMs, 10 * 60 * 1000)
    : DEFAULT_ASSESSMENT_TTL_MS
  let assessments = new Map()
  let audits = []
  let tail = Promise.resolve()
  const ready = Promise.resolve(repository?.load?.()).then(value => {
    const restored = restoreState(value)
    assessments = restored.assessments
    audits = restored.audits
  })

  function serialize(operation) {
    const result = tail.then(async () => {
      await ready
      return operation()
    })
    tail = result.catch(() => {})
    return result
  }

  async function persist() {
    await repository?.save?.(stateForPersistence(assessments, audits))
  }

  function rejection(reason, context = {}) {
    try { diagnostics?.recordOffloadRejection?.({ reason, observedAt: now() }) } catch {}
    return {
      success: false,
      accepted: false,
      publicationId: context.publicationId || '',
      assessmentId: context.assessmentId || '',
      freedBytes: 0,
      reason,
      errorCode: `SOURCE_OFFLOAD_${String(reason).replace(/-/g, '_').toUpperCase()}`,
    }
  }

  function assessmentRejection(reason, context = {}) {
    return {
      ...rejection(reason, context),
      eligible: false,
      evidenceDigest: '',
      confirmationNonce: '',
      expiresAt: 0,
      policyVersion,
      byteLength: 0,
      limitations: [],
    }
  }

  async function recordAudit(input) {
    const audit = {
      ...input,
      auditId: b4a.toString(hashCanonical('peartube.archive.offload-audit.v1', {
        ...input,
        ordinal: audits.length,
      }), 'hex'),
    }
    audits.push(audit)
    while (audits.length > MAX_AUDIT_RECORDS) audits.shift()
    await repository?.appendAudit?.({ ...audit })
    await persist()
    return audit
  }

  function pruneAssessments(currentTime) {
    for (const [assessmentId, assessment] of assessments) {
      if (assessment.expiresAt < currentTime && assessment.consumed) assessments.delete(assessmentId)
    }
    while (assessments.size >= MAX_ASSESSMENTS) assessments.delete(assessments.keys().next().value)
  }

  return {
    ready,

    createOffloadAssessment(input = {}) {
      return serialize(async () => {
        let publicationId
        try { publicationId = hex32(input.publicationId, 'publicationId') } catch { return assessmentRejection('publication-invalid') }
        const issuedAt = now()
        pruneAssessments(issuedAt)
        let evidence
        try {
          evidence = normalizeArchiveEvidence({
            ...(await collectEvidence(publicationId)),
            publicationId,
            policyVersion,
          })
        } catch {
          return assessmentRejection('evidence-unavailable', { publicationId })
        }
        const confidence = assessArchiveConfidence(evidence)
        const evidenceDigest = digestEvidence(confidence.evidence)
        const confirmationNonce = randomHex32()
        const assessmentId = b4a.toString(hashCanonical('peartube.archive.offload-assessment.v1', {
          publicationId,
          evidenceDigest,
          issuedAt,
          confirmationNonce,
          policyVersion,
        }), 'hex')
        const assessment = {
          success: true,
          eligible: confidence.eligible,
          publicationId,
          assessmentId,
          evidenceDigest,
          confirmationNonce,
          issuedAt,
          expiresAt: issuedAt + ttlMs,
          policyVersion,
          byteLength: confidence.evidence.byteLength,
          limitations: confidence.limitations.slice(),
          consumed: false,
        }
        assessments.set(assessmentId, assessment)
        await persist()
        const { consumed: _consumed, issuedAt: _issuedAt, ...response } = assessment
        return response
      })
    },

    confirmSourceOffload(input = {}) {
      return serialize(async () => {
        let publicationId
        let assessmentId
        let evidenceDigest
        let confirmationNonce
        try {
          publicationId = hex32(input.publicationId, 'publicationId')
          assessmentId = hex32(input.assessmentId, 'assessmentId')
          evidenceDigest = hex32(input.evidenceDigest, 'evidenceDigest')
          confirmationNonce = hex32(input.confirmationNonce, 'confirmationNonce')
        } catch {
          return rejection('confirmation-invalid')
        }
        const context = { publicationId, assessmentId }
        const assessment = assessments.get(assessmentId)
        if (!assessment) return rejection('assessment-not-found', context)
        if (assessment.consumed) return rejection('nonce-used', context)
        if (input.confirmIrrecoverableRisk !== true) return rejection('irrecoverable-risk-not-confirmed', context)
        if (publicationId !== assessment.publicationId) return rejection('publication-mismatch', context)
        if (evidenceDigest !== assessment.evidenceDigest) return rejection('evidence-mismatch', context)
        if (confirmationNonce !== assessment.confirmationNonce) return rejection('nonce-mismatch', context)
        if (Number(input.policyVersion) !== assessment.policyVersion || assessment.policyVersion !== policyVersion) {
          return rejection('policy-changed', context)
        }
        if (now() > assessment.expiresAt) return rejection('assessment-expired', context)
        if (!assessment.eligible) return rejection('not-eligible', context)

        // Consume and persist before recollection/deletion so concurrent confirmations
        // cannot race through the same user acknowledgement.
        assessment.consumed = true
        await persist()

        let freshEvidence
        let confidence
        try {
          freshEvidence = normalizeArchiveEvidence({
            ...(await collectEvidence(publicationId)),
            publicationId,
            policyVersion,
          })
          confidence = assessArchiveConfidence(freshEvidence)
        } catch {
          const result = rejection('evidence-unavailable', context)
          await recordAudit({ publicationId, assessmentId, outcome: 'rejected', reason: result.reason, observedAt: now() })
          return result
        }
        const freshDigest = digestEvidence(confidence.evidence)
        let reason = null
        if (freshEvidence.activePlayback) reason = 'playback-active'
        else if (freshDigest !== assessment.evidenceDigest) reason = 'evidence-changed'
        else if (!confidence.eligible) reason = 'not-eligible'
        if (reason) {
          const result = rejection(reason, context)
          await recordAudit({ publicationId, assessmentId, outcome: 'rejected', reason, evidenceDigest: freshDigest, observedAt: now() })
          return result
        }

        await recordAudit({
          publicationId,
          assessmentId,
          outcome: 'authorized',
          evidenceDigest: freshDigest,
          observedAt: now(),
        })

        let deletion
        try { deletion = await deleteSource({ publicationId, assessment, evidence: freshEvidence }) } catch {
          deletion = { success: false, reason: 'delete-failed' }
        }
        if (!deletion?.success) {
          const reason = String(deletion?.reason || 'delete-failed')
          const result = rejection(reason, context)
          await recordAudit({ publicationId, assessmentId, outcome: 'failed', reason, evidenceDigest: freshDigest, observedAt: now() })
          return result
        }
        const freedBytes = Number.isSafeInteger(Number(deletion.freedBytes)) && Number(deletion.freedBytes) >= 0
          ? Number(deletion.freedBytes)
          : 0
        const audit = await recordAudit({
          publicationId,
          assessmentId,
          outcome: 'deleted',
          evidenceDigest: freshDigest,
          freedBytes,
          observedAt: now(),
        })
        return { success: true, accepted: true, publicationId, assessmentId, freedBytes, auditId: audit.auditId }
      })
    },

    async getAuditLog() {
      await ready
      return audits.map(audit => ({ ...audit }))
    },
  }
}
