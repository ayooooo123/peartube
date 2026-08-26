import fs from 'node:fs/promises'
import path from 'node:path'

import b4a from 'b4a'
import Corestore from 'corestore'
import crypto from 'hypercore-crypto'
import Hyperblobs from 'hyperblobs'

import { createBackend } from '../../src/backend-entry.js'
import { createArchiveChallenge, createArchiveChallengeResponse, createArchivePossessionProof, verifyArchiveChallengeResponse } from '../../src/archive/challenge.js'
import { createArchiveManager } from '../../src/archive/manager.js'
import { createArchivePledge } from '../../src/archive/pledge.js'
import { createPublicationBatch } from '../../src/assets/publication-batch.js'
import { createPublisherManager } from '../../src/discovery/publisher-manager.js'
import { createPublisherCatalogPage } from '../../src/discovery/publisher-protocol.js'
import { createIndexFeedPage } from '../../src/indexing/feed-contract.js'
import { createIndexFeedManager } from '../../src/indexing/feed-manager.js'
import { createLiveEpochDescriptor, verifyLiveEpochChain, verifyLiveEpochDescriptor } from '../../src/live/live-descriptor.js'
import { createMigrationLifecycle } from '../../src/migrations/observability.js'
import { createModerationFeedPage, verifyModerationFeedPage } from '../../src/moderation/feed-contract.js'
import { createModerationManager } from '../../src/moderation/manager.js'
import { decodeApplicationEnvelope, encodeApplicationEnvelope } from '../../src/records/application-envelope.js'
import { projectPublisherDeviceStatus } from '../../src/publisher/device-status.js'

const [scenario, phase, storagePath] = process.argv.slice(2)
const controlPath = path.join(storagePath, 'chaos-control.json')

function seed(value) { return b4a.alloc(32, value) }
function keyPair(value) { return crypto.keyPair(seed(value)) }
function hex(value) { return b4a.toString(value, 'hex') }

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value))
  await fs.rename(temporary, file)
}

function barrier(name = scenario) {
  process.stdout.write(`${JSON.stringify({ type: 'barrier', scenario, name })}\n`)
  setInterval(() => {}, 60_000)
  return new Promise(() => {})
}

function result(value) {
  process.stdout.write(`${JSON.stringify({ type: 'result', scenario, result: value })}\n`)
}

class JsonMigrationStore {
  constructor(file) { this.file = file }
  async get(key) {
    const state = await readJson(this.file, {})
    return Object.hasOwn(state, key) ? { value: state[key] } : null
  }
  async put(key, value) {
    const state = await readJson(this.file, {})
    state[key] = value
    await writeJson(this.file, state)
  }
}
function fileStateRepository(file) {
  return {
    async load() {
      return readJson(file, null)
    },
    async save(state) {
      await writeJson(file, state)
    }
  }
}

function publicationBatch(sequence = 1) {
  const publisher = keyPair(31)
  const publisherId = hex(publisher.publicKey)
  const batch = createPublicationBatch({ publisherId, sequence })
  batch.addClaim({
    claimType: 'EntityMetadataClaim',
    claimId: `${sequence}`.repeat(64).slice(0, 64),
    subjectRefs: [`work:${sequence}`],
    payload: { title: `Chaos ${sequence}` },
  })
  return { publisher, publisherId, batch }
}

function publisherPage(cursor, nextCursor, sequence, title = `Chaos ${sequence}`) {
  const { publisher, publisherId, batch } = publicationBatch(sequence)
  if (title !== `Chaos ${sequence}`) {
    batch.addClaim({
      claimType: 'EntityMetadataClaim',
      claimId: 'f'.repeat(64),
      subjectRefs: ['work:fork'],
      payload: { title },
    })
  }
  return createPublisherCatalogPage({
    publisherId,
    pageCursor: cursor,
    nextCursor,
    catalogHead: `${sequence}`.repeat(64).slice(0, 64),
    batches: [batch.seal()],
    keyPair: publisher,
  })
}

function indexPage(cursor = '0', title = 'Stable', curator = keyPair(41)) {
  const curatorId = hex(curator.publicKey)
  return {
    curatorId,
    page: createIndexFeedPage({
      curatorId,
      pageCursor: cursor,
      nextCursor: null,
      records: [{
        kind: 'publication-reference',
        entityRef: `work:${title.toLowerCase()}`,
        publicationId: 'a'.repeat(64),
        publisherId: 'b'.repeat(64),
        title,
      }],
      keyPair: curator,
      issuedAt: 100,
      expiresAt: 1_000,
    }),
  }
}

function moderationPage(cursor = '0', action = 'block') {
  const moderator = keyPair(51)
  const moderatorId = hex(moderator.publicKey)
  return {
    moderatorId,
    page: createModerationFeedPage({
      moderatorId,
      pageCursor: cursor,
      nextCursor: null,
      records: [{ action, targetType: 'publication', targetId: 'a'.repeat(64), label: 'chaos', reason: 'checkpoint-change' }],
      keyPair: moderator,
      issuedAt: 100,
      expiresAt: 1_000,
    }),
  }
}

async function uploadBeforeSeal() {
  const store = new Corestore(path.join(storagePath, 'corestore'))
  await store.ready()
  const core = store.get({ name: 'chaos-upload-blobs' })
  await core.ready()
  const blobs = new Hyperblobs(core)
  if (phase === 'prepare') {
    const blobId = await blobs.put(b4a.from('durable-upload-bytes'))
    await writeJson(controlPath, { blobId, publicationSealed: false })
    return barrier('upload-bytes-written')
  }
  const control = await readJson(controlPath)
  const bytes = await blobs.get(control.blobId)
  const { batch } = publicationBatch(1)
  batch.addClaim({
    claimType: 'AvailabilityObservation',
    claimId: 'e'.repeat(64),
    subjectRefs: ['work:upload'],
    payload: { publicationId: 'd'.repeat(64), availabilityStatus: 'available' },
  })
  batch.seal()
  const catalogCommit = batch.commit()
  await writeJson(controlPath, { ...control, publicationSealed: true, catalogCommit })
  await store.close()
  result({ status: 'recovered', bytes: b4a.toString(bytes), catalogCommitted: Boolean(catalogCommit?.batchDigest) })
}

async function migrationBeforeCheckpoint() {
  const store = new JsonMigrationStore(path.join(storagePath, 'migration-state.json'))
  let resumedCheckpoint = 'unset'
  const lifecycle = createMigrationLifecycle({
    store,
    migrations: {
      'media-v2': async ({ checkpoint, persistCheckpoint }) => {
        resumedCheckpoint = checkpoint
        if (phase === 'prepare') return barrier('migration-running')
        await persistCheckpoint({ checkpoint: 'item-1', processedCount: 1 })
        return { state: 'complete', checkpoint: 'item-1', processedCount: 1 }
      },
    },
    now: () => phase === 'prepare' ? 100 : 200,
  })
  const status = await lifecycle.retryMigration({ migrationId: 'media-v2' })
  if (phase === 'recover') {
    const stored = await readJson(store.file, {})
    const durableState = Object.values(stored)[0]
    result({ state: status.state, attempts: durableState?.attempts, resumedCheckpoint, processedCount: status.processedCount })
  }
}

async function offloadBeforeConfirmation() {
  const publicationId = 'a'.repeat(64)
  if (phase === 'prepare') {
    const manager = createArchiveManager({
      now: () => 100,
      collectEvidence: async () => ({
        byteLength: 4096,
        localPhysicalDeviceId: 'desktop-a',
        publisherDeviceCopies: [
          { deviceId: 'phone', physicalDeviceId: 'phone-b', connected: true, fullCopy: true, publisherControlled: true },
        ],
      }),
    })
    const assessment = await manager.createOffloadAssessment({ publicationId })
    await writeJson(controlPath, { assessment, sourceRetained: true })
    return barrier('offload-assessed')
  }
  const control = await readJson(controlPath)
  const manager = createArchiveManager({ now: () => 150 })
  const confirmation = await manager.confirmSourceOffload({
    publicationId,
    assessmentId: control.assessment.assessmentId,
    evidenceDigest: control.assessment.evidenceDigest,
    confirmationNonce: control.assessment.confirmationNonce,
    policyVersion: control.assessment.policyVersion,
    confirmIrrecoverableRisk: true,
  })
  result({ confirmation, sourceRetained: control.sourceRetained })
}

function liveEpoch(terminalState = null, previousEpochDigest = null, epoch = 0) {
  const device = keyPair(61)
  return createLiveEpochDescriptor({
    eventId: seed(62),
    epoch,
    previousEpochDigest,
    writableCoreKey: seed(63),
    startsAt: 100,
    expiresAt: 300,
    codec: 'video/mp4',
    dvrWindowBlocks: 128,
    terminalState,
    keyPair: device,
    issuedAt: terminalState ? 150 : 100,
  })
}

async function liveBeforeSeal() {
  const store = new Corestore(path.join(storagePath, 'corestore'))
  await store.ready()
  const epochCore = store.get({ name: 'chaos-live-epochs' })
  await epochCore.ready()
  const first = liveEpoch()
  if (phase === 'prepare') {
    await epochCore.append(encodeApplicationEnvelope(first.envelope))
    await writeJson(controlPath, { epochDigest: first.epochDigest, vodSealed: false })
    return barrier('live-epoch-written')
  }
  const control = await readJson(controlPath)
  const recoveredEnvelope = decodeApplicationEnvelope(await epochCore.get(0))
  const recovered = await verifyLiveEpochDescriptor(recoveredEnvelope, { eventId: seed(62), deviceId: keyPair(61).publicKey, now: 150 })
  const terminal = liveEpoch('ended', first.epochDigest, 1)
  await epochCore.append(encodeApplicationEnvelope(terminal.envelope))
  const terminalEnvelope = decodeApplicationEnvelope(await epochCore.get(1))
  const chain = await verifyLiveEpochChain([recoveredEnvelope, terminalEnvelope], { eventId: seed(62), deviceId: keyPair(61).publicKey, now: 150 })
  await writeJson(controlPath, { ...control, vodSealed: true, terminalDigest: terminal.epochDigest })
  await store.close()
  result({ epochRecovered: Boolean(recovered && recovered.body.epochDigest === control.epochDigest), epochs: chain?.epochs, terminalState: chain?.terminalState })
}

async function missingHalfBlob() {
  const store = new Corestore(path.join(storagePath, 'corestore'))
  await store.ready()
  const core = store.get({ name: 'chaos-half-blob' })
  await core.ready()
  if (phase === 'prepare') {
    await core.append(b4a.from('first-half'))
    await writeJson(controlPath, { requiredBlocks: 2, graphPublicationId: 'stable-publication' })
    return barrier('half-blob-written')
  }
  const control = await readJson(controlPath)
  await core.update()
  const availability = {
    available: core.length >= control.requiredBlocks,
    errorCode: core.length >= control.requiredBlocks ? null : 'MEDIA_BYTES_UNAVAILABLE',
    availableBlocks: core.length,
    requiredBlocks: control.requiredBlocks,
  }
  await store.close()
  result({ availability, graphPublicationId: control.graphPublicationId })
}

async function stalePublisher() {
  const publisherId = hex(keyPair(31).publicKey)
  if (phase === 'prepare') {
    const manager = createPublisherManager({ ingestBatch: async () => barrier('publisher-transfer-active') })
    await manager.syncPublisher({ publisherId, startCursor: '0', fetchPage: async () => publisherPage('0', '1', 1) })
    return
  }
  let projectedCount = 0
  const manager = createPublisherManager({ ingestBatch: async () => { projectedCount++ } })
  const outcome = await manager.syncPublisher({ publisherId, startCursor: '1', fetchPage: async () => publisherPage('0', null, 2) })
  result({ ...outcome, projectedCount })
}

async function equivocatedIndex() {
  const stateFile = path.join(storagePath, 'chaos-index-state.json')
  const stateRepository = fileStateRepository(stateFile)
  const stable = indexPage('0', 'Stable', keyPair(40))
  const original = indexPage('0', 'Original', keyPair(41))
  if (phase === 'prepare') {
    const manager = createIndexFeedManager({ now: () => 150, stateRepository })
    await manager.subscribe(stable.curatorId)
    await manager.syncFeed({ curatorId: stable.curatorId, fetchPage: async () => stable.page })
    await manager.subscribe(original.curatorId)
    const activeManager = createIndexFeedManager({
      now: () => 150,
      stateRepository,
      acceptRecord: async () => barrier('index-transfer-active')
    })
    await activeManager.syncFeed({ curatorId: original.curatorId, fetchPage: async () => original.page })
    return
  }
  const manager = createIndexFeedManager({ now: () => 150, stateRepository })
  await manager.subscribe(original.curatorId)
  await manager.syncFeed({ curatorId: original.curatorId, fetchPage: async () => original.page })
  const fork = indexPage('0', 'Equivocated', keyPair(41))
  const outcome = await manager.syncFeed({ curatorId: fork.curatorId, fetchPage: async () => fork.page })
  result({ ...outcome, projectedCount: manager.getRecords().length })
}

async function changedModeration() {
  const original = moderationPage('0', 'block')
  if (phase === 'prepare') {
    const manager = createModerationManager({ now: () => 150, acceptRecord: async () => barrier('moderation-transfer-active') })
    manager.subscribe(original.moderatorId)
    await manager.syncFeed({ moderatorId: original.moderatorId, fetchPage: async () => original.page })
    return
  }
  const changed = moderationPage('stale', 'allow')
  const manager = createModerationManager({ now: () => 150 })
  manager.subscribe(changed.moderatorId)
  const outcome = await manager.syncFeed({ moderatorId: changed.moderatorId, startCursor: '0', fetchPage: async () => changed.page })
  result({ ...outcome, projectedCount: manager.getRecords().length })
}

async function rootRotation() {
  if (phase === 'prepare') {
    await writeJson(controlPath, { heldRoot: hex(seed(71)), heldCatalogEpoch: 0 })
    return barrier('old-catalog-held')
  }
  const control = await readJson(controlPath)
  const writerKey = seed(72)
  const deviceKey = seed(73)
  const projected = projectPublisherDeviceStatus({
    authorizationState: {
      publisherId: seed(74),
      activeRootKey: seed(75),
      catalogEpoch: 1,
      policyEpoch: 1,
      writers: new Map([[hex(writerKey), { signerKey: deviceKey, expiresAt: 1_000 }]]),
    },
    localDevice: {
      devicePublicKey: deviceKey,
      writerKey,
      rootPublicKey: b4a.from(control.heldRoot, 'hex'),
      hasRootAuthority: true,
      catalogEpoch: control.heldCatalogEpoch,
      policyEpoch: 0,
    },
  })
  result({ status: projected.status, reasonCode: projected.reasonCode, canPublish: projected.canPublish })
}

async function liveClockJumps() {
  const epoch = liveEpoch()
  if (phase === 'prepare') {
    await writeJson(controlPath, { epochDigest: epoch.epochDigest })
    return barrier('live-token-written')
  }
  const options = { eventId: seed(62), deviceId: keyPair(61).publicKey }
  result({
    inWindow: Boolean(await verifyLiveEpochDescriptor(epoch.envelope, { ...options, now: 150 })),
    backwardAccepted: Boolean(await verifyLiveEpochDescriptor(epoch.envelope, { ...options, now: 50 })),
    forwardAccepted: Boolean(await verifyLiveEpochDescriptor(epoch.envelope, { ...options, now: 301 })),
  })
}

function archiveFixture() {
  const archivist = keyPair(81)
  const auditor = keyPair(82)
  const transport = keyPair(83)
  const publicationId = 'a'.repeat(64)
  const renditionId = 'b'.repeat(64)
  const coreKey = 'c'.repeat(64)
  const pledgeEnvelope = createArchivePledge({
    archivistId: hex(archivist.publicKey), publicationId, renditionId,
    ranges: [{ coreKey, start: 0, end: 10 }], retentionUntil: 500,
    uploadCeilingBytes: 1024, keyPair: archivist, issuedAt: 100,
  }).envelope
  const challenge = createArchiveChallenge({
    pledgeEnvelope, auditorEntropy: seed(84), coreKey, range: { start: 0, end: 1 },
    deadline: 200, auditorPublicKey: auditor.publicKey,
  })
  const proofBytes = b4a.from('bounded-hypercore-proof')
  const response = createArchiveChallengeResponse({
    challenge, pledgeEnvelope, proof: createArchivePossessionProof({ challenge, proofBytes }), transportPeerId: hex(transport.publicKey),
    keyPair: archivist, issuedAt: 100,
  })
  return { challenge, pledgeEnvelope, proofBytes, response, transportPeerId: hex(transport.publicKey) }
}

async function archiveClockJumps() {
  const fixture = archiveFixture()
  if (phase === 'prepare') {
    await writeJson(controlPath, { responseId: hex(fixture.response.responseId) })
    return barrier('archive-proof-written')
  }
  const verifyAt = now => verifyArchiveChallengeResponse(fixture.response.envelope, {
    ...fixture,
    now,
    replayCache: new Set(),
    verifyProof: async () => true,
  })
  result({
    inWindow: Boolean(await verifyAt(150)),
    backwardAccepted: Boolean(await verifyAt(50)),
    forwardAccepted: Boolean(await verifyAt(201)),
  })
}

async function moderationClockJumps() {
  const fixture = moderationPage('0', 'block')
  if (phase === 'prepare') {
    await writeJson(controlPath, { moderatorId: fixture.moderatorId })
    return barrier('moderation-page-written')
  }
  const verifyAt = now => verifyModerationFeedPage(fixture.page.envelope, { moderatorId: fixture.moderatorId, now })
  result({
    inWindow: Boolean(await verifyAt(150)),
    backwardAccepted: Boolean(await verifyAt(50)),
    forwardAccepted: Boolean(await verifyAt(1_001)),
  })
}

async function confirmAssessmentAt(createAt, confirmAt) {
  let now = createAt
  const publicationId = 'a'.repeat(64)
  const evidence = {
    byteLength: 4096,
    localPhysicalDeviceId: 'desktop-a',
    publisherDeviceCopies: [
      { deviceId: 'phone', physicalDeviceId: 'phone-b', connected: true, fullCopy: true, publisherControlled: true },
    ],
  }
  const manager = createArchiveManager({
    now: () => now,
    collectEvidence: async () => evidence,
    deleteSource: async ({ authorize }) => {
      const authorization = await authorize()
      return authorization.success ? { success: true, freedBytes: evidence.byteLength } : authorization
    },
    assessmentTtlMs: 100,
  })
  const assessment = await manager.createOffloadAssessment({ publicationId })
  now = confirmAt
  return manager.confirmSourceOffload({
    publicationId,
    assessmentId: assessment.assessmentId,
    evidenceDigest: assessment.evidenceDigest,
    confirmationNonce: assessment.confirmationNonce,
    policyVersion: assessment.policyVersion,
    confirmIrrecoverableRisk: true,
  })
}

async function offloadClockJumps() {
  if (phase === 'prepare') {
    await writeJson(controlPath, { assessmentCreatedAt: 100 })
    return barrier('offload-token-written')
  }
  result({
    inWindow: await confirmAssessmentAt(100, 150),
    backward: await confirmAssessmentAt(100, 50),
    forward: await confirmAssessmentAt(100, 201),
  })
}

async function mobileBackendRestart() {
  const startupFile = path.join(storagePath, 'mobile-startup-count.json')
  const prior = await readJson(startupFile, { count: 0 })
  const startupCount = prior.count + 1
  await writeJson(startupFile, { count: startupCount })
  const metaDb = { async get() { return null }, async put() {} }
  const session = await createBackend({
    storagePath,
    stream: {},
    platform: 'mobile',
    protocolVersion: 1,
    createBackendContext: async () => ({
      ctx: { metaDb }, api: {}, identityManager: { getIdentities: () => [] }, uploadManager: {}, async destroy() {},
    }),
    createGossipService: () => ({}),
    createMirrorSeedWorker: () => ({}),
    createStorageService: () => ({}),
    loadNativeModules: async () => ({ libhc: { async create() { return { async init() {}, async flush() {}, async start() {}, async shutdown() {} } } } }),
    HRPCImpl: class MockHRPC { respond() {} eventReady() {} eventError() {} },
  })
  if (phase === 'prepare') return barrier('mobile-backend-ready')
  result({ platform: 'mobile', startupCount, coreState: session.core.state })
  await session.destroy()
}

const scenarios = {
  'upload-before-publication-seal': uploadBeforeSeal,
  'migration-running-before-checkpoint': migrationBeforeCheckpoint,
  'offload-assessment-before-confirmation': offloadBeforeConfirmation,
  'live-epoch-before-vod-seal': liveBeforeSeal,
  'missing-half-blob': missingHalfBlob,
  'stale-publisher-during-transfer': stalePublisher,
  'equivocated-index-during-transfer': equivocatedIndex,
  'changed-moderation-during-transfer': changedModeration,
  'root-rotation-old-catalog-held': rootRotation,
  'live-clock-jumps': liveClockJumps,
  'archive-clock-jumps': archiveClockJumps,
  'moderation-clock-jumps': moderationClockJumps,
  'offload-clock-jumps': offloadClockJumps,
  'mobile-backend-restart': mobileBackendRestart,
}

try {
  if (!scenarios[scenario]) throw new Error(`Unknown product chaos scenario: ${scenario}`)
  await scenarios[scenario]()
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`)
  process.exitCode = 1
}
