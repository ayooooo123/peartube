import test from 'brittle'
import c from 'compact-encoding'
import * as schema from '../../spec/spec/schema/index.js'

import { createApi } from '../src/api.js'

const publicationId = 'a'.repeat(64)
const publisherId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)
const renditionId = 'd'.repeat(64)

function manifest(overrides = {}) {
  return {
    publicationId,
    body: {
      publisherId,
      renditions: [{ renditionId, purpose: 'original', core: { key: coreKey, length: 9, byteLength: 4096 } }],
      provenance: [{ type: 'upload', renditionId, coreKey, blobId: '2:7:0:4096', start: 2, end: 9 }],
      ...overrides,
    },
  }
}

function createHarness(options = {}) {
  const state = new Map()
  let currentEvidence = options.evidence || {
    localPhysicalDeviceId: 'desktop',
    publisherDeviceCopies: [{ deviceId: 'phone', physicalDeviceId: 'phone', connected: true, fullCopy: true, publisherControlled: true }],
  }
  let playbackActive = options.playbackActive === true
  let evidenceCalls = 0
  let authorizationChecks = 0
  let deleteCalls = 0
  const storedManifest = options.manifest || manifest()
  const clearCalls = []
  const sourceCore = {
    key: Buffer.from(coreKey, 'hex'),
    async ready() {},
    async clear(start, end) { clearCalls.push({ start, end }) },
    async close() {},
  }
  const api = createApi({
    ctx: {
      store: {
        get() {
          if (options.sourceCore) return options.sourceCore
          if (options.useDefaultDeletion === true) return sourceCore
          throw new Error('source core must not open when hooks are injected')
        },
      },
      metaDb: {
        async get(key) { return state.has(key) ? { value: state.get(key) } : null },
        async put(key, value) { state.set(key, structuredClone(value)) },
      },
      metaSubspaces: {
        downloadIntents: {
          async get() { return null },
          async * createReadStream() {},
        },
      },
      assetManifestStore: {
        getManifest(id) { return id === publicationId ? storedManifest : null },
      },
    },
    catalogRegistry: { async resolve(id) { return id === publisherId ? { catalog: { writable: true } } : null } },
    sourceOffload: {
      async authorizePublication(input) {
        authorizationChecks++
        options.onAuthorizePublication?.(authorizationChecks, input)
        if (typeof options.authorizePublication === 'function') return options.authorizePublication(input)
        return input.publicationId === publicationId
      },
      isPlaybackActive(input) {
        if (typeof options.isPlaybackActive === 'function') return options.isPlaybackActive(input)
        return playbackActive
      },
      async collectEvidence(input) {
        evidenceCalls++
        if (typeof options.collectEvidence === 'function') return options.collectEvidence(input)
        const { locators } = input
        if (locators.length !== 1 || locators[0].start !== 2 || locators[0].end !== 9) throw new Error('locator mismatch')
        return currentEvidence
      },
      ...(options.useDefaultDeletion === true ? {} : {
        async deleteSource(input) {
          deleteCalls++
          if (typeof options.deleteSource === 'function') return options.deleteSource(input)
          const { locators } = input
          return { success: locators.length === 1 && locators[0].coreKey === coreKey, freedBytes: 4096 }
        },
      }),
    },
  })
  return {
    api,
    setEvidence(value) { currentEvidence = value },
    setPlaybackActive(value) { playbackActive = value === true },
    deleteCalls: () => deleteCalls,
    clearCalls: () => clearCalls.slice(),
    evidenceCalls: () => evidenceCalls,
    authorizationChecks: () => authorizationChecks,
    sourceOffloadState: () => state.get('archive:source-offload-state:v1'),
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

async function holdPlaybackMutationLock(harness) {
  let enterPlayback
  let releasePlayback
  const playbackEntered = new Promise(resolve => { enterPlayback = resolve })
  const playbackRelease = new Promise(resolve => { releasePlayback = resolve })
  harness.api.getVideoUrl = async () => {
    enterPlayback()
    await playbackRelease
    return { url: 'http://127.0.0.1/video.mp4' }
  }
  harness.api.prefetchVideo = async () => ({ success: false, reason: 'test' })
  const playback = harness.api.preparePlayback(
    'channel',
    'videos/demo.mp4',
    null,
    '2:7:0:4096',
    coreKey,
    'video/mp4',
  )
  await playbackEntered
  return {
    playback,
    release() { releasePlayback() },
  }
}

test('backend source offload resolves exact publication source and requires confirmation', async (t) => {
  const harness = createHarness()

  const assessment = await harness.api.assessSourceOffload({ publicationId })
  t.is(assessment.success, true)
  t.is(assessment.eligible, true)
  t.is(harness.deleteCalls(), 0, 'assessment never deletes')
  const result = await harness.api.confirmSourceOffload(confirmation(assessment))
  t.is(result.success, true)
  t.is(result.freedBytes, 4096)
  t.is(harness.deleteCalls(), 1)
})

test('backend source offload rejects unknown publication and anonymous viewer copies', async (t) => {
  const harness = createHarness({ evidence: { viewerFullCopies: 100 } })
  const missing = await harness.api.assessSourceOffload({ publicationId: 'e'.repeat(64) })
  t.is(missing.success, false)
  t.is(missing.reason, 'evidence-unavailable')
  t.execution(() => c.encode(
    schema.getEncoding('@peartube/assess-source-offload-response'),
    missing,
  ), 'expected assessment rejection crosses HRPC')
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  t.is(assessment.eligible, false)
  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).reason, 'not-eligible')
  t.is(harness.deleteCalls(), 0)
})

test('backend source offload rechecks playback and evidence immediately before deletion', async (t) => {
  const harness = createHarness()
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  harness.setEvidence({
    activePlayback: true,
    publisherDeviceCopies: [{ deviceId: 'phone', physicalDeviceId: 'phone', connected: true, fullCopy: true, publisherControlled: true }],
  })
  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).reason, 'playback-active')
  t.is(harness.deleteCalls(), 0)
})

test('backend source offload fails closed for ambiguous source locators', async (t) => {
  const malformed = manifest({ provenance: [] })
  const harness = createHarness({ manifest: malformed })
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  t.is(assessment.success, false)
  t.is(assessment.reason, 'evidence-unavailable')
  t.is(harness.deleteCalls(), 0)
})

test('backend source offload rejects multiple original ranges before assessment', async (t) => {

  const secondCoreKey = 'e'.repeat(64)
  const secondRenditionId = 'f'.repeat(64)
  let evidenceCalls = 0
  const harness = createHarness({
    manifest: manifest({
      renditions: [
        { renditionId, purpose: 'original', core: { key: coreKey, length: 9, byteLength: 4096 } },
        { renditionId: secondRenditionId, purpose: 'original', core: { key: secondCoreKey, length: 6, byteLength: 2048 } },
      ],
      provenance: [
        { type: 'upload', renditionId, coreKey, blobId: '2:7:0:4096', start: 2, end: 9 },
        { type: 'upload', renditionId: secondRenditionId, coreKey: secondCoreKey, blobId: '1:5:0:2048', start: 1, end: 6 },
      ],
    }),
    collectEvidence: async () => {
      evidenceCalls++
      return {}
    },
  })

  const assessment = await harness.api.assessSourceOffload({ publicationId })
  t.is(assessment.success, false)
  t.is(assessment.reason, 'evidence-unavailable')
  t.is(evidenceCalls, 0)
  t.is(harness.deleteCalls(), 0)
})

test('source offload recollects remote-copy evidence only after acquiring the source lock', async (t) => {
  let reachDeletePrecheck
  const deletePrecheckReached = new Promise(resolve => { reachDeletePrecheck = resolve })
  const harness = createHarness({
    useDefaultDeletion: true,
    onAuthorizePublication(checks) {
      if (checks === 2) reachDeletePrecheck()
    },
  })
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  const heldPlayback = await holdPlaybackMutationLock(harness)
  const confirmationResult = harness.api.confirmSourceOffload(confirmation(assessment))
  await deletePrecheckReached
  await Promise.resolve()

  t.is(harness.evidenceCalls(), 1, 'confirmation evidence waits for the source mutation lock')
  harness.setEvidence({ viewerFullCopies: 10 })
  heldPlayback.release()
  await heldPlayback.playback

  t.is((await confirmationResult).reason, 'evidence-changed')
  t.alike(harness.clearCalls(), [])
  t.is(harness.sourceOffloadState().audits.at(-1).outcome, 'rejected')
  harness.setEvidence({
    localPhysicalDeviceId: 'desktop',
    publisherDeviceCopies: [{ deviceId: 'phone', physicalDeviceId: 'phone', connected: true, fullCopy: true, publisherControlled: true }],
  })
  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).success, true)
  t.alike(harness.clearCalls(), [{ start: 2, end: 9 }])
})

test('playback starting before the source lock causes a durable retryable refusal', async (t) => {
  let reachDeletePrecheck
  const deletePrecheckReached = new Promise(resolve => { reachDeletePrecheck = resolve })
  const harness = createHarness({
    useDefaultDeletion: true,
    onAuthorizePublication(checks) {
      if (checks === 2) reachDeletePrecheck()
    },
  })
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  harness.setPlaybackActive(true)
  const heldPlayback = await holdPlaybackMutationLock(harness)
  const confirmationResult = harness.api.confirmSourceOffload(confirmation(assessment))
  await deletePrecheckReached
  heldPlayback.release()
  await heldPlayback.playback

  t.is((await confirmationResult).reason, 'playback-active')
  t.alike(harness.clearCalls(), [])
  t.alike(
    harness.sourceOffloadState().audits.map(audit => [audit.outcome, audit.reason || null]),
    [['rejected', 'playback-active']],
  )
  harness.setPlaybackActive(false)
  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).success, true)
  t.alike(harness.clearCalls(), [{ start: 2, end: 9 }])
})

test('locked evidence collector errors refuse without consuming or clearing', async (t) => {
  let evidenceUnavailable = false
  const durable = {
    localPhysicalDeviceId: 'desktop',
    publisherDeviceCopies: [{ deviceId: 'phone', physicalDeviceId: 'phone', connected: true, fullCopy: true, publisherControlled: true }],
  }
  const harness = createHarness({
    useDefaultDeletion: true,
    async collectEvidence() {
      if (evidenceUnavailable) throw new Error('peer disconnected')
      return durable
    },
  })
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  evidenceUnavailable = true

  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).reason, 'evidence-unavailable')
  t.alike(harness.clearCalls(), [])
  t.alike(
    harness.sourceOffloadState().audits.map(audit => [audit.outcome, audit.reason || null]),
    [['rejected', 'evidence-unavailable']],
  )

  evidenceUnavailable = false
  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).success, true)
  t.alike(harness.clearCalls(), [{ start: 2, end: 9 }])
})

test('prefetch startup causes a retryable refusal before source deletion', async (t) => {
  let enterCoreReady
  let releaseCoreReady
  const coreReadyEntered = new Promise(resolve => { enterCoreReady = resolve })
  const coreReadyRelease = new Promise(resolve => { releaseCoreReady = resolve })
  const sourceCore = {
    key: Buffer.from(coreKey, 'hex'),
    async ready() {
      enterCoreReady()
      await coreReadyRelease
      throw new Error('stop test prefetch')
    },
    async close() {},
  }
  const harness = createHarness({ sourceCore })
  harness.api.getVideoData = async () => ({
    blobsCoreKey: coreKey,
    blobId: '2:7:0:4096',
    size: 4096,
  })
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  const prefetch = harness.api.prefetchVideo('channel', 'videos/demo.mp4')
  await coreReadyEntered

  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).reason, 'playback-active')
  t.is(harness.deleteCalls(), 0)

  releaseCoreReady()
  t.is((await prefetch).success, false)
  t.is((await harness.api.confirmSourceOffload(confirmation(assessment))).success, true)
  t.is(harness.deleteCalls(), 1)
})

test('source deletion serializes against playback startup for the same core', async (t) => {
  let deletionStarted
  let finishDeletion
  const started = new Promise(resolve => { deletionStarted = resolve })
  const finish = new Promise(resolve => { finishDeletion = resolve })
  const harness = createHarness({
    deleteSource: async () => {
      deletionStarted()
      await finish
      return { success: true, freedBytes: 4096 }
    },
  })
  const assessment = await harness.api.assessSourceOffload({ publicationId })
  const deletion = harness.api.confirmSourceOffload(confirmation(assessment))
  await started

  let urlReads = 0
  harness.api.getVideoUrl = async () => {
    urlReads++
    return { url: 'http://127.0.0.1/video.mp4' }
  }
  harness.api.prefetchVideo = async () => ({ success: false, reason: 'test' })
  const playback = harness.api.preparePlayback(
    'channel',
    'videos/demo.mp4',
    null,
    '2:7:0:4096',
    coreKey,
    'video/mp4',
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(urlReads, 0, 'playback cannot acquire the source while deletion holds its mutation lock')

  finishDeletion()
  t.is((await deletion).success, true)
  t.is((await playback).url, 'http://127.0.0.1/video.mp4')
  t.is(urlReads, 1)
})
