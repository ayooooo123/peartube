import assert from 'node:assert/strict'
import test from 'node:test'

import { runCrashRecoveryScenario } from './helpers/process-chaos-harness.mjs'

const TIMEOUT_MS = 30_000

async function run(t, scenario, options = {}) {
  return runCrashRecoveryScenario(t, {
    scenario,
    timeoutMs: TIMEOUT_MS,
    ...options,
  })
}

test('chaos: upload bytes survive SIGKILL before publication seal and seal on reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'upload-before-publication-seal')
  assert.equal(result.status, 'recovered')
  assert.equal(result.bytes, 'durable-upload-bytes')
  assert.equal(result.catalogCommitted, true)
})

test('chaos: migration killed while running before checkpoint retries from prior durable checkpoint', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'migration-running-before-checkpoint')
  assert.equal(result.state, 'complete')
  assert.equal(result.attempts, 2)
  assert.equal(result.resumedCheckpoint, null)
  assert.equal(result.processedCount, 1)
})

test('chaos: offload assessment killed before confirmation retains source and fails closed', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'offload-assessment-before-confirmation')
  assert.equal(result.confirmation.accepted, false)
  assert.equal(result.confirmation.reason, 'assessment-not-found')
  assert.equal(result.confirmation.errorCode, 'SOURCE_OFFLOAD_ASSESSMENT_NOT_FOUND')
  assert.equal(result.sourceRetained, true)
})

test('chaos: live epoch survives SIGKILL before VOD seal and seals on reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'live-epoch-before-vod-seal')
  assert.equal(result.epochRecovered, true)
  assert.equal(result.epochs, 2)
  assert.equal(result.terminalState, 'ended')
})

test('chaos: missing half blob after SIGKILL is structured unavailable without graph corruption', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'missing-half-blob')
  assert.deepEqual(result.availability, {
    available: false,
    errorCode: 'MEDIA_BYTES_UNAVAILABLE',
    availableBlocks: 1,
    requiredBlocks: 2,
  })
  assert.equal(result.graphPublicationId, 'stable-publication')
})

test('chaos: stale publisher catalog during active transfer is quarantined after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'stale-publisher-during-transfer')
  assert.equal(result.status, 'quarantined')
  assert.equal(result.errorCode, 'STALE_OR_FORKED_CURSOR')
  assert.equal(result.projectedCount, 0)
})

test('chaos: equivocated index page during active transfer is quarantined after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'equivocated-index-during-transfer')
  assert.equal(result.status, 'quarantined')
  assert.equal(result.errorCode, 'STALE_OR_FORKED_CURSOR')
  assert.equal(result.projectedCount, 1)
})

test('chaos: changed moderation feed during active transfer is quarantined after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'changed-moderation-during-transfer')
  assert.equal(result.status, 'quarantined')
  assert.equal(result.errorCode, 'STALE_OR_FORKED_CURSOR')
  assert.equal(result.projectedCount, 0)
})

test('chaos: root rotation while old catalog is held revokes publication authority after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'root-rotation-old-catalog-held')
  assert.equal(result.status, 'authority-lost')
  assert.equal(result.reasonCode, 'ROOT_AUTHORITY_ROTATED')
  assert.equal(result.canPublish, false)
})

test('chaos: live epoch fails closed across backward and forward clock jumps after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'live-clock-jumps')
  assert.equal(result.inWindow, true)
  assert.equal(result.backwardAccepted, false)
  assert.equal(result.forwardAccepted, false)
})

test('chaos: archive proof fails closed across backward and forward clock jumps after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'archive-clock-jumps')
  assert.equal(result.inWindow, true)
  assert.equal(result.backwardAccepted, false)
  assert.equal(result.forwardAccepted, false)
})

test('chaos: moderation page fails closed across backward and forward clock jumps after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'moderation-clock-jumps')
  assert.equal(result.inWindow, true)
  assert.equal(result.backwardAccepted, false)
  assert.equal(result.forwardAccepted, false)
})

test('chaos: offload confirmation fails closed across backward and forward clock jumps after reopen', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'offload-clock-jumps')
  assert.equal(result.inWindow.accepted, true)
  assert.equal(result.backward.accepted, false)
  assert.equal(result.backward.reason, 'assessment-not-yet-valid')
  assert.equal(result.forward.accepted, false)
  assert.equal(result.forward.reason, 'assessment-expired')
})

test('chaos: mobile backend entry survives Node SIGKILL and reopens the same storage', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'mobile-backend-restart', { runtime: 'node' })
  assert.equal(result.platform, 'mobile')
  assert.equal(result.startupCount, 2)
  assert.equal(result.coreState, 'started')
})

test('chaos: mobile backend entry survives Bare SIGKILL and reopens the same storage', { timeout: TIMEOUT_MS * 2 }, async (t) => {
  const result = await run(t, 'mobile-backend-restart', { runtime: 'bare' })
  assert.equal(result.platform, 'mobile')
  assert.equal(result.startupCount, 2)
  assert.equal(result.coreState, 'started')
})
