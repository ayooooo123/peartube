import test from 'brittle'

import { createArchiveManager } from '../src/archive/manager.js'

const publicationId = 'a'.repeat(64)

function durableEvidence(overrides = {}) {
  return {
    byteLength: 4096,
    activePlayback: false,
    localPhysicalDeviceId: 'desktop-a',
    publisherDeviceCopies: [
      { deviceId: 'phone', physicalDeviceId: 'phone-b', connected: true, fullCopy: true, publisherControlled: true },
    ],
    ...overrides,
  }
}

function confirmation(assessment, overrides = {}) {
  return {
    publicationId: assessment.publicationId,
    assessmentId: assessment.assessmentId,
    evidenceDigest: assessment.evidenceDigest,
    confirmationNonce: assessment.confirmationNonce,
    policyVersion: assessment.policyVersion,
    confirmIrrecoverableRisk: true,
    ...overrides,
  }
}

test('source offload requires exact explicit confirmation then deletes once', async (t) => {
  let deletions = 0
  const manager = createArchiveManager({
    now: () => 100,
    collectEvidence: async () => durableEvidence(),
    deleteSource: async () => ({ success: true, freedBytes: ++deletions * 4096 }),
  })
  const assessment = await manager.createOffloadAssessment({ publicationId })
  t.is(assessment.success, true)
  t.is(assessment.eligible, true)
  t.is(assessment.byteLength, 4096)
  t.ok(assessment.limitations.includes('source-offload-may-be-irrecoverable'))
  t.is((await manager.confirmSourceOffload(confirmation(assessment, { confirmIrrecoverableRisk: false }))).reason, 'irrecoverable-risk-not-confirmed')
  const result = await manager.confirmSourceOffload(confirmation(assessment))
  t.is(result.success, true)
  t.is(result.freedBytes, 4096)
  t.is(deletions, 1)
  t.is((await manager.confirmSourceOffload(confirmation(assessment))).reason, 'nonce-used')
  t.is((await manager.getAuditLog()).at(-1).outcome, 'deleted')
})

test('concurrent confirmations atomically consume one nonce', async (t) => {
  let deletions = 0
  const manager = createArchiveManager({
    now: () => 100,
    collectEvidence: async () => durableEvidence(),
    deleteSource: async () => ({ success: true, freedBytes: ++deletions }),
  })
  const assessment = await manager.createOffloadAssessment({ publicationId })
  const results = await Promise.all([
    manager.confirmSourceOffload(confirmation(assessment)),
    manager.confirmSourceOffload(confirmation(assessment)),
  ])
  t.is(results.filter(result => result.success).length, 1)
  t.is(deletions, 1)
})

test('confirmation rejects binding changes without consuming the valid confirmation', async (t) => {
  const manager = createArchiveManager({ now: () => 100, collectEvidence: async () => durableEvidence(), deleteSource: async () => ({ success: true, freedBytes: 1 }) })
  const assessment = await manager.createOffloadAssessment({ publicationId })
  t.is((await manager.confirmSourceOffload(confirmation(assessment, { publicationId: 'b'.repeat(64) }))).reason, 'publication-mismatch')
  t.is((await manager.confirmSourceOffload(confirmation(assessment, { evidenceDigest: 'b'.repeat(64) }))).reason, 'evidence-mismatch')
  t.is((await manager.confirmSourceOffload(confirmation(assessment, { confirmationNonce: 'b'.repeat(64) }))).reason, 'nonce-mismatch')
  t.is((await manager.confirmSourceOffload(confirmation(assessment, { policyVersion: 2 }))).reason, 'policy-changed')
  t.is((await manager.confirmSourceOffload(confirmation(assessment))).success, true)
})

test('confirmation recollects evidence and rejects change or active playback', async (t) => {
  let evidence = durableEvidence()
  let deletions = 0
  const manager = createArchiveManager({
    now: () => 100,
    collectEvidence: async () => evidence,
    deleteSource: async () => ({ success: true, freedBytes: ++deletions }),
  })
  const changed = await manager.createOffloadAssessment({ publicationId })
  evidence = durableEvidence({ publisherDeviceCopies: [], viewerFullCopies: 10 })
  t.is((await manager.confirmSourceOffload(confirmation(changed))).reason, 'evidence-changed')

  evidence = durableEvidence()
  const active = await manager.createOffloadAssessment({ publicationId })
  evidence = durableEvidence({ activePlayback: true })
  t.is((await manager.confirmSourceOffload(confirmation(active))).reason, 'playback-active')
  t.is(deletions, 0)
})

test('anonymous viewers never produce an eligible assessment', async (t) => {
  const manager = createArchiveManager({
    now: () => 100,
    collectEvidence: async () => ({ byteLength: 1, viewerFullCopies: 100 }),
  })
  const assessment = await manager.createOffloadAssessment({ publicationId })
  t.is(assessment.eligible, false)
  t.is((await manager.confirmSourceOffload(confirmation(assessment))).reason, 'not-eligible')
})

test('delete failures are audited and cannot be retried with the consumed acknowledgement', async (t) => {
  const manager = createArchiveManager({
    now: () => 100,
    collectEvidence: async () => durableEvidence(),
    deleteSource: async () => { throw new Error('device busy') },
  })
  const assessment = await manager.createOffloadAssessment({ publicationId })
  t.is((await manager.confirmSourceOffload(confirmation(assessment))).reason, 'delete-failed')
  t.is((await manager.getAuditLog()).at(-1).outcome, 'failed')
  t.is((await manager.confirmSourceOffload(confirmation(assessment))).reason, 'nonce-used')
})

test('source deletion starts only after an authorization audit is durable', async (t) => {
  let saves = 0
  let deletions = 0
  const manager = createArchiveManager({
    now: () => 100,
    repository: {
      async load () { return null },
      async save () {
        saves++
        if (saves === 3) throw new Error('audit disk full')
      },
    },
    collectEvidence: async () => durableEvidence(),
    deleteSource: async () => ({ success: true, freedBytes: ++deletions }),
  })
  const assessment = await manager.createOffloadAssessment({ publicationId })

  await t.exception(manager.confirmSourceOffload(confirmation(assessment)), /audit disk full/)
  t.is(deletions, 0)
})

test('pending assessments and consumed nonces survive restart', async (t) => {
  let state = null
  const repository = {
    async load () { return state == null ? null : structuredClone(state) },
    async save (next) { state = structuredClone(next) },
  }
  const first = createArchiveManager({ now: () => 100, repository, collectEvidence: async () => durableEvidence(), deleteSource: async () => ({ success: true, freedBytes: 2 }) })
  const assessment = await first.createOffloadAssessment({ publicationId })
  await first.confirmSourceOffload(confirmation(assessment))
  const restarted = createArchiveManager({ now: () => 101, repository, collectEvidence: async () => durableEvidence() })
  await restarted.ready
  t.is((await restarted.confirmSourceOffload(confirmation(assessment))).reason, 'nonce-used')
  t.alike((await restarted.getAuditLog()).map(record => record.outcome), ['authorized', 'deleted'])
})
