import test from 'brittle'
import { createArchivePolicy } from '../src/archive/policy.js'
import { createArchiveManager } from '../src/archive/manager.js'
import { createArchiveStore } from '../src/archive/store.js'

const diagnosticsModule = import('../src/archive/diagnostics.js').catch(() => ({}))

const OPERATOR_MODES = [
  'local-first',
  'altruistic',
  'friend-family',
  'community',
  'paid',
]

test('archive diagnostics declares every operator mode and defaults to untrusted local-first operation', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  t.is(typeof createArchiveDiagnostics, 'function')
  if (!createArchiveDiagnostics) return

  for (const operatorMode of OPERATOR_MODES) {
    const diagnostics = createArchiveDiagnostics({ operatorMode, now: () => 10 })
    const status = diagnostics.getArchiveOperatorStatus()
    t.is(status.success, true)
    t.is(status.operatorMode, operatorMode)
  }

  const status = createArchiveDiagnostics({ now: () => 10 }).getArchiveOperatorStatus()
  t.is(status.operatorMode, 'local-first')
  t.absent(status.trustedRelay)
  t.absent(status.paidOperator)
  t.absent(status.mediaOrigin)
})

test('archive diagnostics transitions active pledge health from unknown through challenge success and failure', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const diagnostics = createArchiveDiagnostics({ now: () => 10 })

  diagnostics.recordPledgeHealth({ pledgeId: 'p1', health: 'unknown', active: true, observedAt: 11 })
  t.is(diagnostics.getArchiveOperatorStatus().activePledgeCount, 1)

  diagnostics.recordChallengeOutcome({ pledgeId: 'p1', outcome: 'passed', observedAt: 12 })
  let status = diagnostics.getArchiveOperatorStatus()
  t.is(status.healthyPledgeCount, 1)
  t.is(status.failedPledgeCount, 0)
  t.is(status.challengeSuccessCount, 1)

  diagnostics.recordChallengeOutcome({ pledgeId: 'p1', outcome: 'failed', failureCode: 'INVALID_PROOF', observedAt: 13 })
  status = diagnostics.getArchiveOperatorStatus()
  t.is(status.healthyPledgeCount, 0)
  t.is(status.failedPledgeCount, 1)
  t.is(status.challengeFailureCount, 1)
  t.is(status.recentFailureCodes[0], 'ARCHIVE_CHALLENGE_INVALID_PROOF')
})

test('archive diagnostics records expired and failed possession challenge outcomes', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const diagnostics = createArchiveDiagnostics({ now: () => 20 })

  diagnostics.recordChallengeOutcome({ pledgeId: 'p1', outcome: 'expired', observedAt: 21 })
  diagnostics.recordChallengeOutcome({ pledgeId: 'p2', outcome: 'failed', failureCode: 'RESPONSE_INVALID', observedAt: 22 })

  const status = diagnostics.getArchiveOperatorStatus()
  t.is(status.challengeFailureCount, 2)
  t.is(status.failedPledgeCount, 2)
  t.is(status.recentFailureCodes[0], 'ARCHIVE_CHALLENGE_EXPIRED')
  t.is(status.recentFailureCodes[1], 'ARCHIVE_CHALLENGE_RESPONSE_INVALID')

  const state = diagnostics.exportState()
  t.is(state.recentChallenges[0].outcome, 'expired')
  t.is(state.recentChallenges[1].outcome, 'failed')
  t.is(state.recentChallenges[1].failureCode, 'ARCHIVE_CHALLENGE_RESPONSE_INVALID')
})

test('archive policy reports capacity gauges, exhaustion, and rejected reservations', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const diagnostics = createArchiveDiagnostics({ now: () => 30 })
  const policy = createArchivePolicy({ capacityBytes: 10, diagnostics, now: () => 30 })
  await policy.ready

  let status = diagnostics.getArchiveOperatorStatus()
  t.is(status.capacityTotalBytes, 10)
  t.is(status.capacityReservedBytes, 0)
  t.is(status.capacityAvailableBytes, 10)

  t.is((await policy.reserve({ pledgeId: 'p1', bytes: 8, expiresAt: 50 })).accepted, true)
  t.is((await policy.reserve({ pledgeId: 'p2', bytes: 3, expiresAt: 50 })).reason, 'capacity-exceeded')
  t.is((await policy.reserve({ pledgeId: '', bytes: 1, expiresAt: 50 })).reason, 'invalid-reservation')

  status = diagnostics.getArchiveOperatorStatus()
  t.is(status.capacityReservedBytes, 8)
  t.is(status.capacityAvailableBytes, 2)
  t.is(status.capacityRejectionCount, 2)
  t.is(status.recentFailureCodes[0], 'ARCHIVE_CAPACITY_EXHAUSTED')
  t.is(status.recentFailureCodes[1], 'ARCHIVE_CAPACITY_INVALID_RESERVATION')
})

test('archive manager accounts for bounded offload rejection reasons', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const diagnostics = createArchiveDiagnostics({ now: () => 40 })
  const manager = createArchiveManager({ diagnostics, now: () => 40 })
  await manager.ready

  t.is((await manager.confirmSourceOffload({
    publicationId: 'a'.repeat(64),
    assessmentId: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
    confirmationNonce: 'd'.repeat(64),
    policyVersion: 1,
    confirmIrrecoverableRisk: true,
  })).reason, 'assessment-not-found')
  const assessment = await manager.createOffloadAssessment({
    publicationId: 'a'.repeat(64),
  })
  t.is((await manager.confirmSourceOffload({
    publicationId: assessment.publicationId,
    assessmentId: assessment.assessmentId,
    evidenceDigest: assessment.evidenceDigest,
    confirmationNonce: assessment.confirmationNonce,
    policyVersion: assessment.policyVersion,
    confirmIrrecoverableRisk: true,
  })).reason, 'not-eligible')

  const status = diagnostics.getArchiveOperatorStatus()
  t.is(status.offloadRejectionCount, 2)
  t.is(status.recentFailureCodes[0], 'ARCHIVE_OFFLOAD_ASSESSMENT_NOT_FOUND')
  t.is(status.recentFailureCodes[1], 'ARCHIVE_OFFLOAD_NOT_ELIGIBLE')

  const state = diagnostics.exportState()
  t.is(state.offloadRejectionCounts.ARCHIVE_OFFLOAD_ASSESSMENT_NOT_FOUND, 1)
  t.is(state.offloadRejectionCounts.ARCHIVE_OFFLOAD_NOT_ELIGIBLE, 1)
})

test('archive store emits pledge health and possession challenge observations', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const diagnostics = createArchiveDiagnostics({ now: () => 50 })
  const store = createArchiveStore({ diagnostics, now: () => 50 })

  await store.putPledge({ recordId: 'p1' })
  t.is(diagnostics.getArchiveOperatorStatus().activePledgeCount, 1)

  store.putObservation({ pledgeId: 'p1', status: 'challenge-passed', observedAt: 51, transportPeerSecret: 'never-export' })
  t.is(diagnostics.getArchiveOperatorStatus().healthyPledgeCount, 1)
  store.putObservation({ pledgeId: 'p1', status: 'challenge-expired', observedAt: 52, transportPeerId: 'never-export' })
  const status = diagnostics.getArchiveOperatorStatus()
  t.is(status.failedPledgeCount, 1)
  t.is(status.challengeSuccessCount, 1)
  t.is(status.challengeFailureCount, 1)
  t.is(status.recentFailureCodes[0], 'ARCHIVE_CHALLENGE_EXPIRED')
})

test('archive diagnostics preserves the offload clock-skew refusal code', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const diagnostics = createArchiveDiagnostics({ now: () => 55 })
  diagnostics.recordOffloadRejection({ reason: 'assessment-not-yet-valid', observedAt: 55 })
  t.is(diagnostics.getArchiveOperatorStatus().recentFailureCodes[0], 'ARCHIVE_OFFLOAD_ASSESSMENT_NOT_YET_VALID')
})

test('archive diagnostics persists bounded operator state across restart', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  let persisted = null
  const diagnostics = createArchiveDiagnostics({
    operatorMode: 'community',
    now: () => 60,
    persist(state) {
      persisted = state
    },
  })

  diagnostics.recordPledgeHealth({ pledgeId: 'p1', health: 'healthy', active: true, observedAt: 61 })
  diagnostics.recordChallengeOutcome({ pledgeId: 'p1', outcome: 'failed', failureCode: 'INVALID_PROOF', observedAt: 62 })
  diagnostics.recordCapacity({ totalBytes: 100, reservedBytes: 70, availableBytes: 30, observedAt: 63 })
  diagnostics.recordCapacityRejection({ reason: 'capacity-exceeded', observedAt: 64 })
  diagnostics.recordOffloadRejection({ reason: 'assessment-expired', observedAt: 65 })
  await diagnostics.flush()

  const restarted = createArchiveDiagnostics({ state: persisted, now: () => 999 })
  const status = restarted.getArchiveOperatorStatus()
  t.is(status.operatorMode, 'community')
  t.is(status.activePledgeCount, 1)
  t.is(status.failedPledgeCount, 1)
  t.is(status.challengeFailureCount, 1)
  t.is(status.capacityTotalBytes, 100)
  t.is(status.capacityReservedBytes, 70)
  t.is(status.capacityAvailableBytes, 30)
  t.is(status.capacityRejectionCount, 1)
  t.is(status.offloadRejectionCount, 1)
  t.is(status.recentFailureCodes.length, 3)
  t.is(status.updatedAt, 65)
})

test('archive diagnostics bounds rolling histories and tracked pledge health', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const diagnostics = createArchiveDiagnostics({ maxHistory: 2, maxPledges: 2, now: () => 70 })

  for (let index = 0; index < 4; index++) {
    diagnostics.recordChallengeOutcome({
      pledgeId: `p${index}`,
      outcome: 'failed',
      failureCode: index % 2 === 0 ? 'INVALID_PROOF' : 'RESPONSE_INVALID',
      observedAt: 71 + index,
    })
  }

  const status = diagnostics.getArchiveOperatorStatus()
  t.is(status.activePledgeCount, 2)
  t.is(status.failedPledgeCount, 2)
  t.is(status.challengeFailureCount, 4)
  t.is(status.recentFailureCodes.length, 2)

  const state = diagnostics.exportState()
  t.is(state.pledges.length, 2)
  t.is(state.recentChallenges.length, 2)
})

test('archive diagnostics redacts peer secrets and unknown external failure details', async (t) => {
  const { createArchiveDiagnostics } = await diagnosticsModule
  const secret = 'peer-private-token-123'
  const diagnostics = createArchiveDiagnostics({ now: () => 80 })

  diagnostics.recordChallengeOutcome({
    pledgeId: 'p1',
    outcome: 'failed',
    failureCode: secret,
    peerSecret: secret,
    transportPeerId: secret,
    observedAt: 81,
  })
  diagnostics.recordCapacityRejection({ reason: secret, peerSecret: secret, observedAt: 82 })
  diagnostics.recordOffloadRejection({ reason: secret, confirmationNonce: secret, peerId: secret, observedAt: 83 })

  const serialized = JSON.stringify(diagnostics.exportState())
  t.absent(serialized.includes(secret))
  t.is(diagnostics.getArchiveOperatorStatus().recentFailureCodes[0], 'ARCHIVE_CHALLENGE_FAILED')
  t.is(diagnostics.getArchiveOperatorStatus().recentFailureCodes[1], 'ARCHIVE_CAPACITY_REJECTED')
  t.is(diagnostics.getArchiveOperatorStatus().recentFailureCodes[2], 'ARCHIVE_OFFLOAD_REJECTED')
})
