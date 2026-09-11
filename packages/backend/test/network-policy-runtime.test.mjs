import test from 'brittle'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { createNetworkLifecycleApi } from '../src/api/network-lifecycle.js'
import { createArchivePolicy } from '../src/archive/policy.js'
import { registerSharedHandlers, SHARED_HANDLER_NAMES } from '../src/hrpc-handlers.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

import {
  createNetworkPolicyRuntime,
  createPolicyApi,
  loadNetworkPolicy,
  normalizeNetworkPolicy,
} from '../src/api/policy.js'
import {
  createIndexServiceAnnouncement,
  deriveIndexerId,
  encodeIndexServiceAnnouncement,
} from '../src/indexer/service-announcement.js'

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

// Every OS signal a contributing device needs, all permissive. Tests narrow one
// signal at a time so a failure names the gate that closed.
const CLEAR_DEVICE_CONDITIONS = Object.freeze({
  metered: false,
  thermalState: 'nominal',
  batteryPercent: 80,
  charging: false,
  backgroundPermitted: true,
  freeDiskBytes: 300 * GIB,
  totalDiskBytes: 500 * GIB,
})

function participationHarness({
  policyApi,
  outboundBytesTotal = 0,
  repository = null,
  networkPolicyRuntime = null,
  startAt = 1_700_000_000_000,
} = {}) {
  const decisions = []
  const published = []
  let clock = startAt
  let outbound = outboundBytesTotal
  let suspends = 0
  const transitions = []
  const api = createNetworkLifecycleApi({
    policyApi,
    repository,
    networkPolicyRuntime: networkPolicyRuntime || {
      async setEnvironment(environment) {
        transitions.push(environment)
      },
      async setParticipationDecision(decision) {
        published.push(decision)
      },
    },
    onParticipationDecision: decision => decisions.push(decision),
    now: () => clock,
    readOutboundBytesTotal: () => outbound,
    suspendTransport: async () => {
      suspends++
    },
  })
  return {
    api,
    decisions,
    published,
    transitions,
    advance(ms) { clock += ms },
    upload(bytes) { outbound += bytes },
    get clock() { return clock },
    get suspends() { return suspends },
  }
}

// A metadata store for the rolling ledgers, shared across "restarts" of the
// lifecycle API the way ctx.metaDb is shared across launches of the process.
function ledgerRepository() {
  let state = null
  return {
    async load() { return state === null ? null : structuredClone(state) },
    async save(next) { state = structuredClone(next) },
    get state() { return state },
  }
}

function lastEvent(harness, name) {
  const event = harness.events.filter(([recorded]) => recorded === name).at(-1)
  return event === undefined ? null : event[1]
}

function asyncPolicyStore(initial = null) {
  const values = new Map()
  if (initial) values.set('network-policy:v1', structuredClone(initial))
  return {
    values,
    async get(key) {
      return values.has(key) ? { value: structuredClone(values.get(key)) } : null
    },
    async put(key, value) {
      values.set(key, structuredClone(value))
    },
  }
}

function runtimeHarness(initialPolicy, environment = {}) {
  const events = []
  let reservations = 4096
  const scopedNetwork = {
    async applyNetworkPolicy(policy) {
      events.push(['scoped', structuredClone(policy)])
    },
  }
  const seedingManager = {
    async applyNetworkPolicy(policy) {
      events.push(['seeding', structuredClone(policy)])
    },
  }
  const archiveNetwork = {
    async setParticipation(policy) {
      events.push(['archive', structuredClone(policy)])
      if (policy.enabled === false) reservations = 0
      return { ...policy }
    },
  }
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork,
    seedingManager,
    archiveNetwork,
    ...environment,
  })
  return { runtime, events, get reservations() { return reservations } }
}

test('persisted policy loads before manager startup and survives restart', async (t) => {
  const store = asyncPolicyStore()
  const firstApi = createPolicyApi({ store })
  const saved = await firstApi.setNetworkPolicy({
    uploadPermission: 'enabled',
    meteredNetwork: 'allow',
    backgroundMode: 'allow',
    diskCeilingBytes: 2048,
    uploadCeilingBytes: 512,
    retentionMode: 'archive-pledges',
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: true,
    contributionBudgetBytes: 1536,
    archiveBudgetBytes: 2048,
  })
  t.is(saved.success, true)

  const persisted = await loadNetworkPolicy({ store })
  const restarted = runtimeHarness(persisted)
  await restarted.runtime.start()

  t.alike(restarted.events.map(([name]) => name), ['scoped', 'archive', 'seeding'])
  t.is(restarted.events[0][1].uploadAllowed, true)
  t.is(restarted.events[0][1].networkEnabled, true)
  t.is(restarted.events[2][1].contributionBudgetBytes, 1536)
  t.is(restarted.events[1][1].enabled, true)
  t.is(restarted.events[1][1].capacityBytes, 2048)
})

test('runtime policy transitions stop forbidden work, release reservations, and restart allowed work', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const harness = runtimeHarness(initialPolicy)
  await harness.runtime.start()

  await harness.runtime.apply({
    ...initialPolicy,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024,
    retentionMode: 'archive-pledges',
    diskCeilingBytes: 4096,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: true,
    contributionBudgetBytes: 2048,
    archiveBudgetBytes: 4096,
  })
  await harness.runtime.setEnvironment({ background: true })
  const backgrounded = harness.events.filter(([name]) => name === 'scoped').at(-1)[1]
  t.is(backgrounded.networkEnabled, true,
    'the shipped default leaves backgrounded work to the participation gates')

  // An operator narrowing is what stops it.
  await harness.runtime.apply({
    ...initialPolicy,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024,
    retentionMode: 'archive-pledges',
    diskCeilingBytes: 4096,
    backgroundMode: 'local-only',
  })
  const stopped = harness.events.filter(([name]) => name === 'scoped').at(-1)[1]
  t.is(stopped.networkEnabled, false)
  t.is(stopped.uploadAllowed, false)

  await harness.runtime.apply({
    ...initialPolicy,
    uploadPermission: 'disabled',
    uploadCeilingBytes: 0,
    retentionMode: 'none',
    diskCeilingBytes: 0,
    contributeWatchedMedia: false,
    archiveEnabled: false,
    contributionBudgetBytes: 0,
    archiveBudgetBytes: 0,
  })
  t.is(harness.reservations, 0, 'disabling archive retention releases reservations')
  t.is(harness.events.filter(([name]) => name === 'seeding').at(-1)[1].contributionBudgetBytes, 0)

  await harness.runtime.setEnvironment({ background: false })
  const restarted = harness.events.filter(([name]) => name === 'scoped').at(-1)[1]
  t.is(restarted.networkEnabled, true)
  t.is(restarted.uploadAllowed, false, 'network restarts without overriding disabled upload')
})

test('deferred runtime startup applies the latest policy exactly once', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const harness = runtimeHarness(initialPolicy)
  await harness.runtime.start({
    ...initialPolicy,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 77,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    contributionBudgetBytes: 77,
  })
  t.alike(harness.events.map(([name]) => name), ['scoped', 'archive', 'seeding'])
  t.is(harness.events[0][1].uploadCeilingBytes, 77)
})

test('failed manager reconfiguration rolls runtime and persisted policy back', async (t) => {
  const store = asyncPolicyStore()
  // Serving needs an answered consent question, so the rollback fixture carries
  // one: without it the policy is watch-only and no upload assertion means
  // anything.
  const initialPolicy = normalizeNetworkPolicy({
    ...await loadNetworkPolicy({ store }),
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
  })
  const applied = []
  const managerEvents = []
  let rejectArchive = true
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork: {
      async applyNetworkPolicy(policy) {
        applied.push(structuredClone(policy))
        managerEvents.push(['scoped', policy.permissions?.archive === true])
      },
    },
    seedingManager: {
      async applyNetworkPolicy(policy) {
        managerEvents.push(['seeding', policy.permissions?.archive === true])
      },
    },
    archiveNetwork: {
      async setParticipation({ enabled }) {
        managerEvents.push(['archive', enabled])
        if (enabled && rejectArchive) {
          rejectArchive = false
          return { errorCode: 'ARCHIVE_CAPACITY_EXHAUSTED' }
        }
        return { enabled }
      },
    },
  })
  await runtime.start()
  managerEvents.length = 0
  const api = createPolicyApi({
    store,
    initialPolicy,
    validatePolicy: policy => runtime.assertSupported(policy),
    onPolicyChange: policy => runtime.apply(policy),
  })

  const result = await api.setNetworkPolicy({
    retentionMode: 'archive-pledges',
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024,
    consentVersion: 1,
    migrationRequired: false,
    archiveEnabled: true,
    archiveBudgetBytes: 1024,
  })

  t.is(result.success, false)
  t.alike((await api.getNetworkPolicy()).policy, initialPolicy)
  // Rolling back means landing on the policy we started from, whatever that
  // is - pinning the old non-seeding defaults here would test the fixture.
  t.is(applied.at(-1).uploadCeilingBytes, initialPolicy.uploadCeilingBytes)
  t.is(applied.at(-1).uploadAllowed, initialPolicy.uploadPermission === 'enabled' && initialPolicy.uploadCeilingBytes > 0)
  t.alike(managerEvents, [
    ['scoped', true],
    ['archive', true],
    ['scoped', false],
    ['archive', false],
    ['seeding', false],
  ], 'failed archive admission never reaches seeding and rollback restores every earlier manager')
})

test('archive consent is unsupported when the archive runtime is unavailable', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  t.exception(() => createNetworkPolicyRuntime({
    initialPolicy: {
      ...initialPolicy,
      consentVersion: 1,
      migrationRequired: false,
      archiveEnabled: true,
      archiveBudgetBytes: 1024,
    },
  }), /archiveEnabled is unsupported/)
})

test('policy API rejects fields with no production runtime consumer', async (t) => {
  const store = asyncPolicyStore()
  const initialPolicy = await loadNetworkPolicy({ store })
  const harness = runtimeHarness(initialPolicy)
  await harness.runtime.start()
  const api = createPolicyApi({
    store,
    initialPolicy,
    onPolicyChange: policy => harness.runtime.apply(policy),
    validatePolicy: policy => harness.runtime.assertSupported(policy),
  })

  for (const patch of [
    { followedIndexes: ['b'.repeat(64)] },
    { trustedModerationFeeds: ['c'.repeat(64)] },
    { aiAnalysis: 'local-only' },
    { retentionMode: 'local-pin' },
  ]) {
    const result = await api.setNetworkPolicy(patch)
    t.is(result.success, false)
    t.is(result.errorCode, 'UNSUPPORTED_POLICY_FIELD')
  }
  t.alike((await api.getNetworkPolicy()).policy, initialPolicy)
})

test('policy reconciles bounded publisher, index, and moderation subscriptions through the scoped runtime', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const calls = []
  const scopedNetwork = {
    async applyNetworkPolicy() {},
    async addPublisherFollowReason({ publisherId, reason }) { calls.push(['follow-publisher', publisherId, reason]) },
    async removePublisherFollowReason({ publisherId, reason }) { calls.push(['unfollow-publisher', publisherId, reason]) },
    async followIndexFeed({ curatorId }) { calls.push(['follow-index', curatorId]) },
    async unfollowIndexFeed({ curatorId }) { calls.push(['unfollow-index', curatorId]) },
    async followModerationFeed({ moderatorId }) { calls.push(['follow-moderation', moderatorId]) },
    async unfollowModerationFeed({ moderatorId }) { calls.push(['unfollow-moderation', moderatorId]) },
  }
  const runtime = createNetworkPolicyRuntime({ initialPolicy, scopedNetwork })
  const publisher = '0'.repeat(64)
  const index = '1'.repeat(64)
  const moderator = '2'.repeat(64)
  await runtime.start()
  await runtime.apply({ ...initialPolicy, followedPublishers: [publisher], followedIndexes: [index], trustedModerationFeeds: [moderator] })
  t.alike(calls, [
    ['follow-publisher', publisher, 'network-policy'],
    ['follow-index', index],
    ['follow-moderation', moderator],
  ])
  await runtime.apply(initialPolicy)
  t.alike(calls, [
    ['follow-publisher', publisher, 'network-policy'],
    ['follow-index', index],
    ['follow-moderation', moderator],
    ['unfollow-publisher', publisher, 'network-policy'],
    ['unfollow-index', index],
    ['unfollow-moderation', moderator],
  ])
})

test('failed feed reconciliation restores the prior transport subscriptions transactionally', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const first = '3'.repeat(64)
  const failing = '4'.repeat(64)
  const calls = []
  const followed = new Set()
  const scopedNetwork = {
    async applyNetworkPolicy() {},
    async followIndexFeed({ curatorId }) {
      calls.push(['follow', curatorId])
      if (curatorId === failing) throw new Error('follow failed')
      followed.add(curatorId)
    },
    async unfollowIndexFeed({ curatorId }) {
      calls.push(['unfollow', curatorId])
      followed.delete(curatorId)
    },
    async followModerationFeed() {},
    async unfollowModerationFeed() {},
  }
  const runtime = createNetworkPolicyRuntime({ initialPolicy, scopedNetwork })
  await runtime.start()
  await runtime.apply({ ...initialPolicy, followedIndexes: [first] })

  await t.exception(
    runtime.apply({ ...initialPolicy, followedIndexes: [failing] }),
    /follow failed/,
  )
  t.alike([...followed], [first])
  t.alike(runtime.getPolicy().followedIndexes, [first])
  t.alike(calls.slice(-3), [
    ['unfollow', first],
    ['follow', failing],
    ['follow', first],
  ], 'rollback reconciles from observed partial state')
})

test('legacy persisted policy is migration-required watch-only despite permissive legacy fields', async (t) => {
  const policy = await loadNetworkPolicy({
    store: asyncPolicyStore({
      uploadPermission: 'enabled',
      uploadCeilingBytes: 4096,
      retentionMode: 'archive-pledges',
      diskCeilingBytes: 8192,
    }),
  })
  t.is(policy.migrationRequired, true)
  t.is(policy.effectiveRole, 'watch-only')
  t.is(policy.permissions.contribute, false)
  t.is(policy.permissions.archive, false)
  t.is(policy.contributionBudgetBytes, 0)
  t.is(policy.archiveBudgetBytes, 0)
})

test('incomplete or invalid current policy loads as migration-required watch-only', async (t) => {
  for (const stored of [
    {
      policyVersion: 2,
      consentVersion: 0,
      migrationRequired: false,
      contributeWatchedMedia: true,
      archiveEnabled: true,
      contributionBudgetBytes: 4096,
      archiveBudgetBytes: 4096
    },
    {
      policyVersion: 2,
      consentVersion: 1,
      migrationRequired: false,
      contributeWatchedMedia: true,
      uploadPermission: 'always'
    },
    {
      policyVersion: 2,
      consentVersion: 1,
      contributeWatchedMedia: true,
      archiveEnabled: false,
      contributionBudgetBytes: 4096,
      archiveBudgetBytes: 0,
      uploadPermission: 'enabled',
      uploadCeilingBytes: 4096
    },
    {
      consentVersion: 1,
      migrationRequired: false,
      contributeWatchedMedia: true,
      archiveEnabled: false,
      contributionBudgetBytes: 4096,
      archiveBudgetBytes: 0,
      uploadPermission: 'enabled',
      uploadCeilingBytes: 4096
    }
  ]) {
    const policy = await loadNetworkPolicy({ store: asyncPolicyStore(stored) })
    t.is(policy.migrationRequired, true)
    t.is(policy.effectiveRole, 'watch-only')
    t.is(policy.permissions.contribute, false)
    t.is(policy.permissions.archive, false)
  }
})

test('direct runtime input cannot synthesize explicit consent identity from defaults', async (t) => {
  const harness = runtimeHarness({
    policyVersion: 2,
    consentVersion: 1,
    contributeWatchedMedia: true,
    archiveEnabled: true,
    contributionBudgetBytes: 4096,
    archiveBudgetBytes: 4096,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 8192
  })
  const effective = await harness.runtime.start()
  t.is(effective.migrationRequired, true)
  t.is(effective.effectiveRole, 'watch-only')
  t.is(effective.permissions.contribute, false)
  t.is(effective.permissions.archive, false)
  t.is(effective.uploadAllowed, false)
})

test('foreground policy refresh resumes transport even when no policy suspension ran', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  let resumeCalls = 0
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    resumeTransport: async () => {
      resumeCalls++
    },
  })
  await runtime.start()

  await runtime.setEnvironment({ background: false })

  t.is(resumeCalls, 1, 'foregrounding refreshes a transport paused by the mobile runtime')
})

test('mobile lifecycle events re-evaluate background policy instead of bypassing it', async (t) => {
  const transitions = []
  let suspends = 0
  const api = createNetworkLifecycleApi({
    networkPolicyRuntime: {
      async setEnvironment(environment) {
        transitions.push(environment)
      },
    },
    suspendTransport: async () => {
      suspends++
    },
  })

  t.is((await api.suspendNetwork()).success, true)
  t.is(suspends, 1, 'a device that has reported no OS signals may not run background work')
  t.is((await api.resumeNetwork()).success, true)
  t.alike(transitions, [{ background: true }, { background: false }])
})

test('a fresh install runs Balanced with the Balanced ceilings', async (t) => {
  const store = asyncPolicyStore()
  const installed = await loadNetworkPolicy({ store })
  t.is(installed.participationMode, 'balanced')
  t.is(installed.diskCeilingBytes, 20 * GIB)
  t.is(installed.uploadCeilingBytes, 1 * GIB)

  const policyApi = createPolicyApi({ store })
  const wire = await policyApi.getNetworkPolicy()
  t.is(wire.participationMode, 'balanced', 'the mode reaches the app over the existing wire fields')
  t.is(wire.diskCeilingBytes, 20 * GIB)
  t.is(wire.uploadCeilingBytes, 1 * GIB)

  const harness = participationHarness({ policyApi })
  await harness.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  harness.api.setPlaybackActive({ active: true })
  const status = await harness.api.getParticipationStatus()
  t.is(status.mode, 'balanced')
  t.is(status.cacheCeilingBytes, 20 * GIB)
  t.is(status.uploadCeilingBytesPer24h, 1 * GIB)
  t.is(status.outboundBytesPerSecond, 625000, '5 Mbit/s outbound')
  t.is(status.postPlaybackGraceMs, 10 * 60 * 1000)
  t.is(status.backgroundRemainingSessionMs, 15 * 60 * 1000)
  t.is(status.backgroundRemainingDailyMs, 60 * 60 * 1000)
})

test('a ceiling the viewer set outranks the preset when the mode changes', async (t) => {
  const store = asyncPolicyStore()
  const policyApi = createPolicyApi({ store })
  t.is((await policyApi.setNetworkPolicy({
    uploadCeilingBytes: 100 * MIB,
    uploadCeilingBytesPresent: true,
  })).success, true)

  t.is((await policyApi.setNetworkPolicy({ participationMode: 'help-more' })).success, true)
  const widened = await policyApi.getNetworkPolicy()
  t.is(widened.participationMode, 'help-more')
  t.is(widened.uploadCeilingBytes, 100 * MIB, 'Help More does not widen a ceiling the viewer set')
  t.is(widened.diskCeilingBytes, 100 * GIB, 'an untouched ceiling still follows the preset')

  t.is((await policyApi.setNetworkPolicy({ participationMode: 'data-saver' })).success, true)
  const narrowed = await policyApi.getNetworkPolicy()
  t.is(narrowed.uploadCeilingBytes, 100 * MIB, 'Data Saver does not overwrite it either')
  t.is(narrowed.diskCeilingBytes, 4 * GIB)

  const restarted = await loadNetworkPolicy({ store })
  t.is(restarted.uploadCeilingBytes, 100 * MIB, 'the explicit choice survives a restart')
  t.is(restarted.participationMode, 'data-saver')

  const harness = participationHarness({ policyApi })
  await harness.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  harness.api.setPlaybackActive({ active: true })
  const status = await harness.api.getParticipationStatus()
  t.is(status.uploadCeilingBytesPer24h, 100 * MIB, 'the quota gate measures against the effective ceiling')
  t.is(status.cacheCeilingBytes, 4 * GIB)
})

test('resubmitting the whole policy unchanged does not freeze the ceilings', async (t) => {
  const policyApi = createPolicyApi({ store: asyncPolicyStore() })
  const { policy } = await policyApi.getNetworkPolicy()

  // Exactly what the app sends on every Developer Settings save: the full
  // policy, with both ceiling-present flags set, none of it edited.
  t.is((await policyApi.setNetworkPolicy({
    uploadPermission: policy.uploadPermission,
    meteredNetwork: policy.meteredNetwork,
    backgroundMode: policy.backgroundMode,
    diskCeilingBytes: policy.diskCeilingBytes,
    diskCeilingBytesPresent: true,
    uploadCeilingBytes: policy.uploadCeilingBytes,
    uploadCeilingBytesPresent: true,
    retentionMode: policy.retentionMode,
    aiAnalysis: policy.aiAnalysis,
    participationMode: policy.participationMode,
  })).success, true)

  t.is((await policyApi.setNetworkPolicy({ participationMode: 'help-more' })).success, true)
  const switched = await policyApi.getNetworkPolicy()
  t.is(switched.diskCeilingBytes, 100 * GIB, 'a ceiling nobody edited still follows the preset')
  t.is(switched.uploadCeilingBytes, 5 * GIB)
})

test('a stored policy from before participation modes keeps a ceiling someone chose', async (t) => {
  const chosen = await loadNetworkPolicy({
    store: asyncPolicyStore({
      uploadPermission: 'enabled',
      meteredNetwork: 'pause-network',
      backgroundMode: 'local-only',
      diskCeilingBytes: 3 * GIB,
      uploadCeilingBytes: Number.MAX_SAFE_INTEGER,
      retentionMode: 'none',
      followedPublishers: [],
      followedIndexes: [],
      trustedModerationFeeds: [],
      aiAnalysis: 'disabled',
    }),
  })
  t.is(chosen.participationMode, 'balanced')
  t.is(chosen.diskCeilingBytes, 3 * GIB, 'a cache ceiling that never matched the retired default was chosen')
  t.is(chosen.uploadCeilingBytes, 1 * GIB, 'the retired unbounded upload default adopts Balanced')

  const untouched = await loadNetworkPolicy({
    store: asyncPolicyStore({
      uploadPermission: 'enabled',
      meteredNetwork: 'pause-network',
      backgroundMode: 'local-only',
      diskCeilingBytes: 5 * GIB,
      uploadCeilingBytes: Number.MAX_SAFE_INTEGER,
      retentionMode: 'none',
      followedPublishers: [],
      followedIndexes: [],
      trustedModerationFeeds: [],
      aiAnalysis: 'disabled',
    }),
  })
  t.is(untouched.diskCeilingBytes, 20 * GIB, 'the retired defaults were never a choice, so Balanced applies')
})

test('backgrounding the app without OS permission suspends instead of pretending to seed', async (t) => {
  const policyApi = createPolicyApi({ store: asyncPolicyStore() })
  const harness = participationHarness({ policyApi })
  await harness.api.setDeviceConditions({ ...CLEAR_DEVICE_CONDITIONS, backgroundPermitted: false })
  harness.api.setPlaybackActive({ active: true })

  const backgrounded = await harness.api.suspendNetwork()
  t.is(backgrounded.success, true)
  t.is(backgrounded.backgroundEligible, false)
  t.is(backgrounded.state, 'suspended', 'a device that may not run background work is not seeding')
  t.ok(backgrounded.reasonCodes.includes('BACKGROUND_NOT_PERMITTED'))
  t.is(harness.suspends, 1, 'the transport is suspended, not left connected')
  t.alike(harness.transitions, [{ metered: false }, { background: true }],
    'the policy runtime sees the reported network cost and the transition')

  await harness.api.resumeNetwork()
  await harness.api.setDeviceConditions({ backgroundPermitted: true })
  const permitted = await harness.api.suspendNetwork()
  t.is(permitted.backgroundEligible, true)
  t.is(harness.suspends, 1, 'background work the OS permits is not suspended')

  // The session budget is 15 minutes; spending it ends background work even
  // though the OS permission is still granted.
  harness.advance(16 * 60 * 1000)
  const spent = await harness.api.getParticipationStatus()
  t.is(spent.backgroundEligible, false)
  t.is(spent.backgroundRemainingSessionMs, 0)
  t.ok(spent.reasonCodes.includes('BACKGROUND_SESSION_BUDGET_EXHAUSTED'))
})

test('participation status distinguishes eligible, actively uploading, and suspended', async (t) => {
  const policyApi = createPolicyApi({ store: asyncPolicyStore() })
  const harness = participationHarness({ policyApi })

  const unreported = await harness.api.getParticipationStatus()
  t.is(unreported.state, 'suspended', 'an unknown OS signal is constrained, never permissive')
  t.ok(unreported.reasonCodes.includes('NETWORK_SIGNAL_UNKNOWN'))
  t.is(harness.decisions.length, 1,
    'the suspended decision is published, so nothing can serve bytes behind the status')

  await harness.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  const idle = await harness.api.getParticipationStatus()
  t.is(idle.state, 'suspended')
  t.alike(idle.reasonCodes, ['OUTSIDE_PLAYBACK_WINDOW'])

  harness.api.setPlaybackActive({ active: true })
  const opened = await harness.api.getParticipationStatus()
  t.is(opened.state, 'eligible', 'playback opens the window; it does not move bytes by itself')
  t.is(opened.uploading, false)
  t.is(opened.uploadEligible, true)
  t.alike(opened.reasonCodes, [])

  harness.upload(4 * MIB)
  const playing = await harness.api.getParticipationStatus()
  t.is(playing.state, 'uploading')
  t.is(playing.uploading, true, 'actively uploading means bytes really left this device')
  t.is(playing.uploadEligible, true)
  t.alike(playing.reasonCodes, [])

  harness.api.setPlaybackActive({ active: false })
  harness.advance(60 * 1000)
  const grace = await harness.api.getParticipationStatus()
  t.is(grace.state, 'eligible', 'the ten-minute grace window still contributes')
  t.is(grace.uploading, false)
  t.is(grace.uploadEligible, true)

  harness.advance(10 * 60 * 1000)
  const expired = await harness.api.getParticipationStatus()
  t.is(expired.state, 'suspended')
  t.ok(expired.reasonCodes.includes('OUTSIDE_PLAYBACK_WINDOW'))

  harness.api.setPlaybackActive({ active: true })
  harness.upload(2 * GIB)
  const exhausted = await harness.api.getParticipationStatus()
  t.is(exhausted.uploadedBytesLast24h, 2 * GIB + 4 * MIB,
    'every outbound byte accrues against the rolling window')
  t.is(exhausted.state, 'suspended')
  t.ok(exhausted.reasonCodes.includes('UPLOAD_QUOTA_EXHAUSTED'))
})

test('an unreadable policy answers with a complete suspended status and no field the wire lacks', async (t) => {
  const harness = participationHarness({
    policyApi: {
      async getNetworkPolicy() { throw new Error('metadata store is unavailable') },
    },
  })

  const response = await harness.api.getParticipationStatus()
  t.is(response.success, false)
  t.is(response.errorCode, 'PARTICIPATION_UNAVAILABLE')
  t.is(response.state, 'suspended', 'a device whose policy could not be read has permission for nothing')
  // get-participation-status carries errorCode and no free-text error. A key the
  // schema has no field for is a key that silently vanishes on the wire.
  t.absent('error' in response, 'the response carries no field the schema cannot encode')
  t.alike(Object.keys(response).filter(key => response[key] === undefined), [],
    'and every field it does carry has a value')
  for (const field of [
    'mode', 'state', 'uploadEligible', 'uploading', 'backgroundEligible', 'cacheCeilingBytes',
    'uploadCeilingBytesPer24h', 'uploadedBytesLast24h', 'outboundBytesPerSecond', 'postPlaybackGraceMs',
    'backgroundRemainingSessionMs', 'backgroundRemainingDailyMs', 'reasonCodes',
  ]) {
    t.ok(field in response, `${field} is answered even when the policy could not be read`)
  }
})

test('no participation mode creates an archive pledge', async (t) => {
  for (const mode of ['data-saver', 'balanced', 'help-more']) {
    const policyApi = createPolicyApi({ store: asyncPolicyStore() })
    t.is((await policyApi.setNetworkPolicy({ participationMode: mode })).success, true)
    const { policy } = await policyApi.getNetworkPolicy()
    t.is(policy.retentionMode, 'none', `${mode} pledges no archive storage`)

    const harness = participationHarness({ policyApi })
    await harness.api.setDeviceConditions({ ...CLEAR_DEVICE_CONDITIONS, backgroundPermitted: false })
    harness.api.setPlaybackActive({ active: true })
    await harness.api.getParticipationStatus()
    const decision = harness.decisions.at(-1)
    t.is(decision.uploadEligible, true, `${mode} contributes upload while playing`)
    t.is(decision.archiving, false, `${mode} does not archive`)

    t.is((await policyApi.setNetworkPolicy({ retentionMode: 'archive-pledges' })).success, true)
    await harness.api.getParticipationStatus()
    t.is(harness.decisions.at(-1).archiving, true, `${mode} archives only once the viewer opts in`)
  }
})

test('the archive ledger refuses a new pledge the participation decision forbids', async (t) => {
  let decision = { archiveEligible: false }
  const ledger = createArchivePolicy({
    capacityBytes: 1024,
    now: () => 1,
    participation: () => decision,
  })

  const refused = await ledger.reserve({ pledgeId: 'a', bytes: 512, expiresAt: 1000 })
  t.is(refused.accepted, false)
  t.is(refused.reason, 'archiving-not-permitted')

  decision = { archiveEligible: true }
  const accepted = await ledger.reserve({ pledgeId: 'a', bytes: 512, expiresAt: 1000 })
  t.is(accepted.accepted, true)

  // A pledge already taken is durable custody: a later suspension does not
  // release it, it only stops new ones.
  decision = { archiveEligible: false }
  t.is((await ledger.snapshot()).reservedBytes, 512)
  t.is((await ledger.reserve({ pledgeId: 'b', bytes: 256, expiresAt: 1000 })).reason, 'archiving-not-permitted')
})

test('a ledger wired to the decision authority fails closed until one is published', async (t) => {
  let decision = null
  const ledger = createArchivePolicy({
    capacityBytes: 1024,
    now: () => 1,
    participation: () => decision,
  })

  const unpublished = await ledger.reserve({ pledgeId: 'a', bytes: 512, expiresAt: 1000 })
  t.is(unpublished.accepted, false, 'no decision is not a clearance')
  t.is(unpublished.reason, 'archiving-not-permitted')

  // An archivist never plays anything, and the pledge gate must not ask it to:
  // archiveEligible carries no playback window and no upload quota.
  decision = { archiveEligible: true, uploadEligible: false, uploading: false, archiving: false }
  t.is((await ledger.reserve({ pledgeId: 'a', bytes: 512, expiresAt: 1000 })).accepted, true,
    'a dedicated archivist that never plays can still accept a pledge')
})

test('the transport refuses uploads exactly when the status says suspended', async (t) => {
  const store = asyncPolicyStore()
  const policyApi = createPolicyApi({ store })
  const initialPolicy = {
    ...await loadNetworkPolicy({ store }),
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
  }
  const transport = runtimeHarness(initialPolicy)
  await transport.runtime.start()
  t.is(lastEvent(transport, 'scoped').uploadAllowed, true,
    'before any decision the runtime has only the operator policy to run on')

  const harness = participationHarness({ policyApi, networkPolicyRuntime: transport.runtime })
  const suspended = await harness.api.getParticipationStatus()
  t.is(suspended.state, 'suspended', 'a device that reported no OS signals may not contribute')
  t.is(lastEvent(transport, 'scoped').uploadAllowed, false, 'and the transport serves no blocks')
  t.is(lastEvent(transport, 'seeding').uploadAllowed, false)

  await harness.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  harness.api.setPlaybackActive({ active: true })
  const eligible = await harness.api.getParticipationStatus()
  t.is(eligible.uploadEligible, true)
  t.is(lastEvent(transport, 'scoped').uploadAllowed, true, 'an eligible device is cleared to serve')
  t.is(lastEvent(transport, 'seeding').outboundBytesPerSecond, 625000,
    'at the rate the decision set, not one a manager invented')

  harness.api.setPlaybackActive({ active: false })
  harness.advance(11 * 60 * 1000)
  const expired = await harness.api.getParticipationStatus()
  t.is(expired.state, 'suspended', 'the grace window closed')
  t.is(lastEvent(transport, 'scoped').uploadAllowed, false, 'the byte path closes with the status')

  // An operator override may narrow an eligible decision; it may never widen a
  // suspended one.
  harness.api.setPlaybackActive({ active: true })
  t.is((await harness.api.getParticipationStatus()).uploadEligible, true)
  await transport.runtime.setEnvironment({ metered: true })
  t.is(lastEvent(transport, 'scoped').uploadAllowed, false, 'a metered link narrows the decision')
})

test('device conditions arrive over the API and only reported signals count', async (t) => {
  t.ok(SHARED_HANDLER_NAMES.includes('SetDeviceConditions'), 'the platform can reach the API over HRPC')
  const policyApi = createPolicyApi({ store: asyncPolicyStore() })
  const harness = participationHarness({ policyApi })
  const registered = {}
  const rpc = {}
  for (const name of SHARED_HANDLER_NAMES) rpc[`on${name}`] = handler => { registered[name] = handler }
  registerSharedHandlers(rpc, { api: harness.api })
  t.is(typeof registered.SetDeviceConditions, 'function', 'and the handler resolves to the API method')

  harness.api.setPlaybackActive({ active: true })
  // Exactly what the wire delivers: every field present, only the flagged ones
  // actually measured. An unflagged false or 0 must stay unknown.
  const partial = await harness.api.setDeviceConditions({
    metered: false,
    meteredProvided: true,
    thermalState: 'nominal',
    batteryPercent: 0,
    batteryPercentProvided: false,
    charging: false,
    chargingProvided: false,
    backgroundPermitted: false,
    backgroundPermittedProvided: false,
    freeDiskBytes: 0,
    freeDiskBytesProvided: false,
    totalDiskBytes: 0,
    totalDiskBytesProvided: false,
  })
  // Unreported power and disk do not stop this device serving the viewer who
  // is watching right now, but they do keep unsupervised background work off.
  t.is(partial.state, 'eligible', 'a watching viewer is still served')
  t.is(partial.backgroundEligible, false, 'an unreported power or disk signal still constrains background work')
  t.ok(partial.reasonCodes.includes('POWER_SIGNAL_UNKNOWN'))
  t.ok(partial.reasonCodes.includes('DISK_SIGNAL_UNKNOWN'))
  t.absent(partial.reasonCodes.includes('NETWORK_SIGNAL_UNKNOWN'), 'the metered signal was reported')

  const reported = await harness.api.setDeviceConditions({
    batteryPercent: 80,
    batteryPercentProvided: true,
    freeDiskBytes: 300 * GIB,
    freeDiskBytesProvided: true,
    totalDiskBytes: 500 * GIB,
    totalDiskBytesProvided: true,
  })
  t.is(reported.state, 'eligible', 'OS signals are what open the gate')
  t.alike(reported.reasonCodes, [])
  t.alike(harness.transitions, [{ metered: false }],
    'a changed metered signal reaches the operator policy runtime')

  const metered = await harness.api.setDeviceConditions({ metered: true, meteredProvided: true })
  t.is(metered.state, 'suspended')
  t.ok(metered.reasonCodes.includes('NETWORK_METERED'))
  t.alike(harness.transitions, [{ metered: false }, { metered: true }])
  t.is(harness.published.at(-1).upload, false, 'and the decision reaches the transport')
})

test('the rolling ledgers survive a restart and age out by wall clock', async (t) => {
  const policyApi = createPolicyApi({ store: asyncPolicyStore() })
  const ledger = ledgerRepository()
  const first = participationHarness({ policyApi, repository: ledger })
  await first.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  first.api.setPlaybackActive({ active: true })
  first.upload(1200 * MIB)
  const spent = await first.api.getParticipationStatus()
  t.is(spent.uploadedBytesLast24h, 1200 * MIB)
  t.is(spent.state, 'suspended')
  t.ok(spent.reasonCodes.includes('UPLOAD_QUOTA_EXHAUSTED'))

  // The same device in a new process: the swarm byte counter starts over, and
  // the rolling day is still owed.
  const restarted = participationHarness({
    policyApi,
    repository: ledger,
    startAt: first.clock,
  })
  await restarted.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  restarted.api.setPlaybackActive({ active: true })
  const rehydrated = await restarted.api.getParticipationStatus()
  t.is(rehydrated.uploadedBytesLast24h, 1200 * MIB, 'a restart does not hand the device a fresh gigabyte')
  t.is(rehydrated.state, 'suspended')
  t.ok(rehydrated.reasonCodes.includes('UPLOAD_QUOTA_EXHAUSTED'))

  // A day off ages the ledger out: downtime is measured by wall clock, not by
  // how long this process has been running.
  const later = participationHarness({
    policyApi,
    repository: ledger,
    startAt: first.clock + 25 * 60 * 60 * 1000,
  })
  await later.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  later.api.setPlaybackActive({ active: true })
  const aged = await later.api.getParticipationStatus()
  t.is(aged.uploadedBytesLast24h, 0, 'the rolling window rolled while the device was off')
  t.is(aged.state, 'eligible')
})

test('a pocketed phone that may not run background work keeps its daily budget', async (t) => {
  const policyApi = createPolicyApi({ store: asyncPolicyStore() })
  const harness = participationHarness({ policyApi })
  await harness.api.setDeviceConditions({ ...CLEAR_DEVICE_CONDITIONS, backgroundPermitted: false })
  harness.api.setPlaybackActive({ active: true })

  const backgrounded = await harness.api.suspendNetwork()
  t.is(backgrounded.backgroundEligible, false)
  t.ok(backgrounded.reasonCodes.includes('BACKGROUND_NOT_PERMITTED'))

  // Two hours in a pocket with the OS forbidding work. Residency is not work:
  // the budgets pay for background contribution, so they are untouched.
  harness.advance(2 * 60 * 60 * 1000)
  const pocketed = await harness.api.getParticipationStatus()
  t.is(pocketed.backgroundRemainingDailyMs, 60 * 60 * 1000, 'a forbidden device burns no daily budget')
  t.is(pocketed.backgroundRemainingSessionMs, 15 * 60 * 1000)

  // The OS relents. From here the budget pays for work the device may do.
  await harness.api.setDeviceConditions({ backgroundPermitted: true })
  const permitted = await harness.api.getParticipationStatus()
  t.is(permitted.backgroundEligible, true)
  harness.advance(10 * 60 * 1000)
  const worked = await harness.api.getParticipationStatus()
  t.is(worked.backgroundRemainingSessionMs, 5 * 60 * 1000, 'eligible background work is what spends it')
  t.is(worked.backgroundRemainingDailyMs, 50 * 60 * 1000)
  t.is(worked.backgroundEligible, true)
})

test('an explicit ceiling survives a mode round trip whose preset coincides with it', async (t) => {
  const store = asyncPolicyStore()
  const policyApi = createPolicyApi({ store })
  // Balanced ships a 20 GiB cache. The viewer deliberately types 4 GiB, which
  // is also, by coincidence, the Data Saver preset.
  t.is((await policyApi.setNetworkPolicy({
    diskCeilingBytes: 4 * GIB,
    diskCeilingBytesPresent: true,
  })).success, true)
  t.is((await policyApi.getNetworkPolicy()).diskCeilingBytes, 4 * GIB)

  t.is((await policyApi.setNetworkPolicy({ participationMode: 'data-saver' })).success, true)
  t.is((await policyApi.getNetworkPolicy()).diskCeilingBytes, 4 * GIB)

  t.is((await policyApi.setNetworkPolicy({ participationMode: 'balanced' })).success, true)
  t.is((await policyApi.getNetworkPolicy()).diskCeilingBytes, 4 * GIB,
    'a mode round trip cannot launder a ceiling the viewer set')

  const restarted = await loadNetworkPolicy({ store })
  t.is(restarted.diskCeilingExplicit, true, 'explicitness is stored, never re-derived from the value')
  t.is(restarted.diskCeilingBytes, 4 * GIB)

  // Typing the mode's own preset back into the field gives the ceiling back to
  // the mode, and it follows presets again.
  t.is((await policyApi.setNetworkPolicy({
    diskCeilingBytes: 20 * GIB,
    diskCeilingBytesPresent: true,
  })).success, true)
  t.is((await policyApi.setNetworkPolicy({ participationMode: 'help-more' })).success, true)
  t.is((await policyApi.getNetworkPolicy()).diskCeilingBytes, 100 * GIB,
    'a ceiling handed back to the mode follows it again')
})

test('shrinking a mode keeps archive custody instead of failing the save', async (t) => {
  const store = asyncPolicyStore()
  const decision = { archiveEligible: true }
  const archiveLedger = createArchivePolicy({
    capacityBytes: 20 * GIB,
    now: () => 1,
    participation: () => decision,
  })
  t.is((await archiveLedger.reserve({ pledgeId: 'kept', bytes: 6 * GIB, expiresAt: 1000 })).accepted, true)

  const events = []
  const archiveNetwork = {
    async setParticipation({ enabled, capacityBytes }) {
      events.push(['archive', { enabled, capacityBytes }])
      const updated = await archiveLedger.setCapacity(capacityBytes)
      if (updated.accepted === false) return { enabled, errorCode: 'ARCHIVE_CAPACITY_EXHAUSTED' }
      return { enabled, capacityBytes }
    },
    getStatus() {
      return { reservedBytes: 6 * GIB }
    },
  }
  const initialPolicy = {
    ...(await loadNetworkPolicy({ store })),
    retentionMode: 'archive-pledges',
  }
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork: { async applyNetworkPolicy() {} },
    seedingManager: {
      async applyNetworkPolicy(policy) { events.push(['seeding', { ...policy }]) },
    },
    archiveNetwork,
  })
  await runtime.start()
  const api = createPolicyApi({
    store,
    initialPolicy,
    onPolicyChange: policy => runtime.apply(policy),
    validatePolicy: policy => runtime.assertSupported(policy),
  })

  // Data Saver's 4 GiB cache is smaller than the 6 GiB already pledged.
  const saved = await api.setNetworkPolicy({ participationMode: 'data-saver' })
  t.is(saved.success, true, 'a mode change never invalidates custody someone already promised')
  t.is((await api.getNetworkPolicy()).participationMode, 'data-saver')
  t.is((await archiveLedger.snapshot()).reservedBytes, 6 * GIB, 'the pledge is still held')
  t.is(await archiveLedger.availableBytes(), 0, 'the shrink took the free headroom, not the pledge')
  t.is(events.filter(([name]) => name === 'archive').at(-1)[1].capacityBytes, 6 * GIB,
    'the archive capacity is floored at what is already reserved')
  t.is(events.filter(([name]) => name === 'seeding').at(-1)[1].diskCeilingBytes, 4 * GIB,
    'while the seed cache ceiling does follow the mode down')
})

test('a fresh install can actually run the background work the OS permits', async (t) => {
  const store = asyncPolicyStore()
  const policyApi = createPolicyApi({ store })
  const installed = {
    ...await loadNetworkPolicy({ store }),
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
  }
  t.is(installed.backgroundMode, 'allow',
    'the shipped default leaves background work to the participation gates')
  t.is(installed.backgroundModeExplicit, false)

  const transport = runtimeHarness(installed)
  await transport.runtime.start()
  const harness = participationHarness({ policyApi, networkPolicyRuntime: transport.runtime })
  await harness.api.setDeviceConditions(CLEAR_DEVICE_CONDITIONS)
  harness.api.setPlaybackActive({ active: true })

  const backgrounded = await harness.api.suspendNetwork()
  t.is(backgrounded.backgroundEligible, true, 'the OS permits it and the budgets are untouched')
  t.alike(backgrounded.reasonCodes, [])
  t.is(harness.suspends, 0, 'so the transport is not suspended')
  const serving = lastEvent(transport, 'scoped')
  t.is(serving.networkEnabled, true, 'and the swarm is still up to serve the work')
  t.is(serving.uploadAllowed, true)

  // Spending the session budget ends it, and then the transport does stop.
  harness.advance(16 * 60 * 1000)
  const spent = await harness.api.getParticipationStatus()
  t.is(spent.backgroundEligible, false)
  t.ok(spent.reasonCodes.includes('BACKGROUND_SESSION_BUDGET_EXHAUSTED'))
  t.is(lastEvent(transport, 'scoped').uploadAllowed, false, 'an exhausted budget closes the byte path')
})

test('an operator who narrows background work keeps that choice', async (t) => {
  const store = asyncPolicyStore()
  const policyApi = createPolicyApi({ store })
  t.is((await policyApi.setNetworkPolicy({ backgroundMode: 'local-only' })).success, true)

  const chosen = await loadNetworkPolicy({ store })
  t.is(chosen.backgroundMode, 'local-only', 'a narrowing an operator asked for is not a stale default')
  t.is(chosen.backgroundModeExplicit, true)

  const transport = runtimeHarness(chosen)
  await transport.runtime.start()
  await transport.runtime.setEnvironment({ background: true })
  t.is(lastEvent(transport, 'scoped').networkEnabled, false, 'and it narrows the transport as asked')

  // Setting the field back to the shipped default gives the choice up again.
  t.is((await policyApi.setNetworkPolicy({ backgroundMode: 'allow' })).success, true)
  const released = await loadNetworkPolicy({ store })
  t.is(released.backgroundModeExplicit, false)
})

test('a stored policy carrying the retired background default adopts the new one', async (t) => {
  const inherited = await loadNetworkPolicy({
    store: asyncPolicyStore({
      uploadPermission: 'enabled',
      meteredNetwork: 'pause-network',
      backgroundMode: 'local-only',
      participationMode: 'balanced',
      diskCeilingBytes: 20 * GIB,
      uploadCeilingBytes: 1 * GIB,
      retentionMode: 'none',
      followedPublishers: [],
      followedIndexes: [],
      trustedModerationFeeds: [],
      aiAnalysis: 'disabled',
    }),
  })
  t.is(inherited.backgroundMode, 'allow', 'a value nobody chose is not a choice')
  t.is(inherited.backgroundModeExplicit, false)

  const narrowed = await loadNetworkPolicy({
    store: asyncPolicyStore({
      uploadPermission: 'enabled',
      meteredNetwork: 'pause-network',
      backgroundMode: 'pause-network',
      participationMode: 'balanced',
      diskCeilingBytes: 20 * GIB,
      uploadCeilingBytes: 1 * GIB,
      retentionMode: 'none',
      followedPublishers: [],
      followedIndexes: [],
      trustedModerationFeeds: [],
      aiAnalysis: 'disabled',
    }),
  })
  t.is(narrowed.backgroundMode, 'pause-network', 'a value only an operator could have set survives')
  t.is(narrowed.backgroundModeExplicit, true)

  const recorded = await loadNetworkPolicy({
    store: asyncPolicyStore({
      uploadPermission: 'enabled',
      meteredNetwork: 'pause-network',
      backgroundMode: 'local-only',
      backgroundModeExplicit: true,
      participationMode: 'balanced',
      diskCeilingBytes: 20 * GIB,
      uploadCeilingBytes: 1 * GIB,
      retentionMode: 'none',
      followedPublishers: [],
      followedIndexes: [],
      trustedModerationFeeds: [],
      aiAnalysis: 'disabled',
    }),
  })
  t.is(recorded.backgroundMode, 'local-only', 'a recorded choice is never revisited by a later default')
})

const INDEX_POLICY_NOW = 1_700_000_000_000

function signedIndexAnnouncement ({ fill = 9, sequence = 7, issuedAt = INDEX_POLICY_NOW, expiresAt = INDEX_POLICY_NOW + 3_600_000, transportFill = 2 } = {}) {
  const signer = crypto.keyPair(b4a.alloc(32, fill))
  return createIndexServiceAnnouncement({
    indexerId: deriveIndexerId(signer.publicKey),
    transportPublicKey: b4a.alloc(32, transportFill),
    dimensions: ['external-ref'],
    shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
    queryCapabilities: ['exact-external-ref'],
    policyDigest: b4a.alloc(32, 3),
    sequence,
    issuedAt,
    expiresAt,
  }, signer)
}

function encodeAnnouncement (announcement) {
  return b4a.toString(encodeIndexServiceAnnouncement(announcement), 'hex')
}

test('policy retains and releases index services; normal re-add uses public retain', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const service = signedIndexAnnouncement()
  const encoded = encodeAnnouncement(service)
  const indexerId = b4a.toString(service.indexerId, 'hex')
  const calls = []
  const scopedNetwork = {
    async applyNetworkPolicy () {},
    async retainIndexService ({ announcement }) {
      calls.push(['retain', b4a.toString(announcement.indexerId, 'hex')])
      return { status: 'retained' }
    },
    async releaseIndexService ({ indexerId: id }) {
      calls.push(['release', id])
      return { status: 'released', released: true }
    },
  }
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork,
    now: () => INDEX_POLICY_NOW,
  })
  await runtime.start()
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [encoded] })
  t.alike(calls, [['retain', indexerId]])
  calls.length = 0
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [] })
  t.alike(calls, [['release', indexerId]])
  calls.length = 0
  // Ordinary re-add is public retain, not private restore.
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [encoded] })
  t.alike(calls, [['retain', indexerId]])
})

test('failed index service retain leaves the previous set applied without release', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const first = signedIndexAnnouncement({ fill: 11, sequence: 1, transportFill: 11 })
  const second = signedIndexAnnouncement({ fill: 12, sequence: 1, transportFill: 12 })
  const firstEncoded = encodeAnnouncement(first)
  const secondEncoded = encodeAnnouncement(second)
  const firstId = b4a.toString(first.indexerId, 'hex')
  const calls = []
  let rejectSecond = false
  const scopedNetwork = {
    async applyNetworkPolicy () {},
    async retainIndexService ({ announcement }) {
      const id = b4a.toString(announcement.indexerId, 'hex')
      if (rejectSecond && id === b4a.toString(second.indexerId, 'hex')) {
        calls.push(['retain-fail', id])
        throw Object.assign(new Error('admission failed'), { code: 'SCOPED_NETWORK_REJECTED' })
      }
      calls.push(['retain', id])
      return { status: 'retained', indexerId: id }
    },
    async releaseIndexService ({ indexerId: id }) {
      calls.push(['release', id])
      return { status: 'released', indexerId: id, released: true }
    },
  }
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork,
    now: () => INDEX_POLICY_NOW,
  })
  await runtime.start()
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [firstEncoded] })
  calls.length = 0
  rejectSecond = true
  await t.exception(
    runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [firstEncoded, secondEncoded] }),
    { message: /admission failed/ },
  )
  t.alike(calls.filter(([name]) => name === 'release'), [])
  t.ok(calls.some(entry => entry[0] === 'retain-fail'))
  calls.length = 0
  // First is still applied bookkeeping: re-apply is a no-op skip.
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [firstEncoded] })
  t.alike(calls, [])
  t.is(firstId.length, 64)
})

test('policy skips announcements at the half-open expiry boundary', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const expired = signedIndexAnnouncement({
    fill: 13,
    sequence: 1,
    issuedAt: INDEX_POLICY_NOW - 60_000,
    expiresAt: INDEX_POLICY_NOW,
  })
  const encoded = encodeAnnouncement(expired)
  const calls = []
  const scopedNetwork = {
    async applyNetworkPolicy () {},
    async retainIndexService () { calls.push('retain') },
    async releaseIndexService () { calls.push('release') },
  }
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork,
    now: () => INDEX_POLICY_NOW,
  })
  await runtime.start()
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [encoded] })
  t.alike(calls, [])
})

test('future-issued policy is rejected by assertSupported, apply and start without mutation', async (t) => {
  const store = asyncPolicyStore()
  const initialPolicy = await loadNetworkPolicy({ store })
  const current = encodeAnnouncement(signedIndexAnnouncement())
  const future = encodeAnnouncement(signedIndexAnnouncement({
    sequence: 8,
    issuedAt: INDEX_POLICY_NOW + 1,
  }))
  const goodPolicy = { ...initialPolicy, indexServiceAnnouncements: [current] }
  const futurePolicy = { ...initialPolicy, indexServiceAnnouncements: [future] }
  const effects = []
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    now: () => INDEX_POLICY_NOW,
    scopedNetwork: {
      async applyNetworkPolicy () { effects.push('apply') },
      async retainIndexService () { effects.push('retain') },
      async releaseIndexService () { effects.push('release') },
    },
  })
  t.exception(() => runtime.assertSupported(futurePolicy), /not yet valid/)
  await t.exception(runtime.apply(futurePolicy), /not yet valid/)
  await t.exception(runtime.start(futurePolicy), /not yet valid/)
  t.alike(effects, [], 'validation does not configure managers or replay rollback')
  t.alike(runtime.getPolicy(), initialPolicy)
  await runtime.start(goodPolicy)
  t.alike(runtime.getPolicy().indexServiceAnnouncements, [current], 'a rejected start does not prevent a valid startup')

  const api = createPolicyApi({
    store,
    initialPolicy,
    validatePolicy: policy => runtime.assertSupported(policy),
    onPolicyChange: policy => runtime.apply(policy),
  })
  t.is((await api.setNetworkPolicy({ indexServiceAnnouncements: [current] })).success, true)
  const persisted = structuredClone(store.values.get('network-policy:v1'))
  let writes = 0
  const put = store.put.bind(store)
  store.put = async (...args) => { writes++; await put(...args) }
  effects.length = 0
  const rejected = await api.setNetworkPolicy({ indexServiceAnnouncements: [future] })
  t.is(rejected.success, false)
  t.is(rejected.errorCode, 'INVALID_POLICY')
  t.is(writes, 0, 'the future record is rejected before persistence')
  t.alike(effects, [])
  t.alike(store.values.get('network-policy:v1'), persisted)
  t.alike((await api.getNetworkPolicy()).policy.indexServiceAnnouncements, [current])
  t.alike(runtime.getPolicy().indexServiceAnnouncements, [current])
})

test('fresh persisted signed policy survives a new store and controller while expired history stays inactive', async (t) => {
  const announcement = signedIndexAnnouncement()
  const encoded = encodeAnnouncement(announcement)
  const peerId = b4a.toString(announcement.transportPublicKey, 'hex')
  const firstStore = asyncPolicyStore()
  const launch = async (store, time) => {
    const peers = new Set()
    const swarm = new EventEmitter()
    swarm.connections = new Set()
    swarm.join = () => { throw new Error('index policy must not discover a global topic') }
    swarm.joinPeer = key => peers.add(b4a.toString(key, 'hex'))
    swarm.leavePeer = key => peers.delete(b4a.toString(key, 'hex'))
    const network = createScopedNetworkRuntime({
      swarm,
      store: {},
      bootstrapEnabled: false,
      now: () => time,
    })
    t.teardown(() => network.close())
    await network.start()
    const initialPolicy = await loadNetworkPolicy({ store })
    const runtime = createNetworkPolicyRuntime({ initialPolicy, scopedNetwork: network, now: () => time })
    await runtime.start()
    const api = createPolicyApi({
      store,
      initialPolicy,
      validatePolicy: policy => runtime.assertSupported(policy),
      onPolicyChange: policy => runtime.apply(policy),
    })
    return { network, runtime, api, peers }
  }
  const first = await launch(firstStore, INDEX_POLICY_NOW)
  t.is((await first.api.setNetworkPolicy({ indexServiceAnnouncements: [encoded] })).success, true)
  t.ok(first.peers.has(peerId), 'a current signed policy admits its peer')
  await first.network.close()
  t.is(first.peers.has(peerId), false)

  const reloadedStore = asyncPolicyStore(firstStore.values.get('network-policy:v1'))
  const restarted = await launch(reloadedStore, INDEX_POLICY_NOW + 1)
  t.alike(restarted.runtime.getPolicy().indexServiceAnnouncements, [encoded])
  t.ok(restarted.peers.has(peerId), 'fresh controllers re-admit the persisted signed announcement')
  await restarted.network.close()

  const historicalStore = asyncPolicyStore(reloadedStore.values.get('network-policy:v1'))
  const expired = await launch(historicalStore, announcement.expiresAt)
  t.alike((await expired.api.getNetworkPolicy()).policy.indexServiceAnnouncements, [encoded])
  t.is(expired.peers.has(peerId), false, 'expired history loads without activating a peer')
})

test('failed multi-swap at capacity releases successful newcomers then restores previous', async (t) => {
  const { registerIndexServicePolicyControl } = await import('../src/network/index-service-policy-control-internal.js')
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const services = Array.from({ length: 32 }, (_, index) => signedIndexAnnouncement({
    fill: index + 20,
    sequence: 1,
    transportFill: index + 20,
  }))
  const encoded = services.map(encodeAnnouncement)
  const [firstNew, secondNew] = [
    signedIndexAnnouncement({ fill: 98, sequence: 1, transportFill: 98 }),
    signedIndexAnnouncement({ fill: 99, sequence: 1, transportFill: 99 }),
  ].sort((left, right) => b4a.compare(left.indexerId, right.indexerId))
  const firstNewEncoded = encodeAnnouncement(firstNew)
  const secondNewEncoded = encodeAnnouncement(secondNew)
  const firstNewId = b4a.toString(firstNew.indexerId, 'hex')
  const secondNewId = b4a.toString(secondNew.indexerId, 'hex')
  const removedA = b4a.toString(services[0].indexerId, 'hex')
  const removedB = b4a.toString(services[1].indexerId, 'hex')
  const live = new Map()
  const lastAdmitted = new Map()
  const floors = new Map()
  const announcements = new Map()
  let failSecond = false
  const scopedNetwork = {
    async applyNetworkPolicy () {},
    async retainIndexService ({ announcement }) {
      const id = b4a.toString(announcement.indexerId, 'hex')
      const body = encodeAnnouncement(announcement)
      if (failSecond && id === secondNewId) {
        throw Object.assign(new Error('injected replacement failure'), { code: 'TEST_INDEX_RETAIN_FAILED' })
      }
      if (live.size >= 32 && !live.has(id)) {
        throw Object.assign(new Error('retained index services exceed their bounded limit'), { code: 'SCOPED_NETWORK_REJECTED' })
      }
      live.set(id, body)
      lastAdmitted.set(id, { indexerId: id, encoded: body, announcement, transportPublicKey: id, limits: {} })
      floors.set(id, announcement.sequence)
      announcements.set(id, announcement)
      return { status: 'retained', indexerId: id }
    },
    async releaseIndexService ({ indexerId: id }) {
      live.delete(id)
      return { status: 'released', indexerId: id, released: true }
    },
  }
  registerIndexServicePolicyControl(scopedNetwork, {
    captureIndexServiceSession () {
      return {
        floors: new Map(floors),
        lastAdmitted: new Map([...lastAdmitted.entries()].map(([id, snap]) => [id, { ...snap }])),
        live: [...live.entries()].map(([id, encodedBody]) => ({
          indexerId: id,
          encoded: encodedBody,
          announcement: announcements.get(id),
          transportPublicKey: lastAdmitted.get(id)?.transportPublicKey,
          limits: {},
        })),
      }
    },
    async restoreIndexServiceSession (snapshot) {
      const desired = new Map(snapshot.live.map(entry => [entry.indexerId, entry]))
      for (const id of [...live.keys()]) {
        const want = desired.get(id)
        if (want && want.encoded === live.get(id)) continue
        live.delete(id)
      }
      for (const entry of snapshot.live) {
        if (live.get(entry.indexerId) === entry.encoded) continue
        if (live.size >= 32 && !live.has(entry.indexerId)) {
          throw Object.assign(new Error('retained index services exceed their bounded limit'), { code: 'SCOPED_NETWORK_REJECTED' })
        }
        live.set(entry.indexerId, entry.encoded)
        announcements.set(entry.indexerId, entry.announcement)
      }
      floors.clear()
      for (const [id, sequence] of snapshot.floors || []) floors.set(id, sequence)
      lastAdmitted.clear()
      for (const [id, snap] of snapshot.lastAdmitted || []) lastAdmitted.set(id, { ...snap })
    },
    async restoreLastIndexService ({ indexerId: id }) {
      const body = lastAdmitted.get(id)?.encoded
      if (!body) throw new Error('no previously admitted index service to restore')
      live.set(id, body)
      return { status: 'retained', restored: true, indexerId: id, encoded: body }
    },
  })
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork,
    now: () => INDEX_POLICY_NOW,
  })
  await runtime.start()
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: encoded })
  t.is(live.size, 32)
  failSecond = true
  const nextList = [firstNewEncoded, secondNewEncoded, ...encoded.slice(2)]
  await t.exception(
    runtime.apply({ ...initialPolicy, indexServiceAnnouncements: nextList }),
    { code: 'TEST_INDEX_RETAIN_FAILED' },
  )
  t.ok(live.has(removedA) && live.has(removedB))
  t.is(live.has(firstNewId), false)
  t.is(live.has(secondNewId), false)
  t.is(live.size, 32)
  t.alike([...live.entries()].sort(), services.map((service, index) => [b4a.toString(service.indexerId, 'hex'), encoded[index]]).sort())
})

test('failed rollback surfaces NETWORK_POLICY_ROLLBACK_FAILED', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  let calls = 0
  const scopedNetwork = {
    async applyNetworkPolicy () {
      calls++
      if (calls >= 2) throw Object.assign(new Error('transport refused'), { code: 'TRANSPORT_REFUSED' })
    },
  }
  const runtime = createNetworkPolicyRuntime({ initialPolicy, scopedNetwork })
  await runtime.start()
  t.is(calls, 1)
  await t.exception(
    runtime.apply({
      ...initialPolicy,
      uploadPermission: 'enabled',
      consentVersion: 1,
      migrationRequired: false,
      contributeWatchedMedia: true,
      contributionBudgetBytes: 1024,
    }),
    { code: 'NETWORK_POLICY_ROLLBACK_FAILED' },
  )
  t.is(calls, 3)
})



test('failed apply after same-indexer supersession restores prior sequence via session snapshot', async (t) => {
  const { registerIndexServicePolicyControl } = await import('../src/network/index-service-policy-control-internal.js')
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const signer = crypto.keyPair(b4a.alloc(32, 40))
  const a1 = createIndexServiceAnnouncement({
    indexerId: deriveIndexerId(signer.publicKey),
    transportPublicKey: b4a.alloc(32, 41),
    dimensions: ['external-ref'],
    shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
    queryCapabilities: ['exact-external-ref'],
    policyDigest: b4a.alloc(32, 3),
    sequence: 1,
    issuedAt: INDEX_POLICY_NOW,
    expiresAt: INDEX_POLICY_NOW + 3_600_000,
  }, signer)
  const a2 = createIndexServiceAnnouncement({
    indexerId: deriveIndexerId(signer.publicKey),
    transportPublicKey: b4a.alloc(32, 41),
    dimensions: ['external-ref'],
    shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
    queryCapabilities: ['exact-external-ref'],
    policyDigest: b4a.alloc(32, 3),
    sequence: 2,
    issuedAt: INDEX_POLICY_NOW + 1,
    expiresAt: INDEX_POLICY_NOW + 3_600_000,
  }, signer)
  const b = signedIndexAnnouncement({ fill: 42, sequence: 1, transportFill: 42 })
  const a1Encoded = encodeAnnouncement(a1)
  const a2Encoded = encodeAnnouncement(a2)
  const bEncoded = encodeAnnouncement(b)
  const aId = b4a.toString(a1.indexerId, 'hex')
  const bId = b4a.toString(b.indexerId, 'hex')
  const live = new Map()
  const lastAdmitted = new Map()
  const floors = new Map()
  const announcements = new Map()
  let failB = false
  const scopedNetwork = {
    async applyNetworkPolicy () {},
    async retainIndexService ({ announcement }) {
      const id = b4a.toString(announcement.indexerId, 'hex')
      const body = encodeAnnouncement(announcement)
      if (failB && id === bId) {
        throw Object.assign(new Error('B admission failed'), { code: 'SCOPED_NETWORK_REJECTED' })
      }
      const floor = floors.get(id)
      if (floor != null && announcement.sequence <= floor && live.get(id) !== body) {
        throw Object.assign(new Error('index service announcement is invalid, unsupported, expired, or replayed'), {
          code: 'SCOPED_NETWORK_REJECTED',
        })
      }
      live.set(id, body)
      lastAdmitted.set(id, {
        indexerId: id,
        encoded: body,
        announcement,
        transportPublicKey: b4a.toString(announcement.transportPublicKey, 'hex'),
        limits: {},
      })
      floors.set(id, announcement.sequence)
      announcements.set(id, announcement)
      return { status: live.has(id) ? 'superseded' : 'retained', indexerId: id }
    },
    async releaseIndexService ({ indexerId: id }) {
      live.delete(id)
      return { status: 'released', indexerId: id, released: true }
    },
  }
  registerIndexServicePolicyControl(scopedNetwork, {
    captureIndexServiceSession () {
      return {
        floors: new Map(floors),
        lastAdmitted: new Map([...lastAdmitted.entries()].map(([id, snap]) => [id, { ...snap }])),
        live: [...live.entries()].map(([id, encoded]) => ({
          indexerId: id,
          encoded,
          announcement: announcements.get(id),
          transportPublicKey: lastAdmitted.get(id)?.transportPublicKey,
          limits: {},
        })),
      }
    },
    async restoreIndexServiceSession (snapshot) {
      const desired = new Map(snapshot.live.map(entry => [entry.indexerId, entry]))
      for (const id of [...live.keys()]) {
        const want = desired.get(id)
        if (want && want.encoded === live.get(id)) continue
        live.delete(id)
      }
      for (const entry of snapshot.live) {
        if (live.get(entry.indexerId) === entry.encoded) continue
        live.set(entry.indexerId, entry.encoded)
        announcements.set(entry.indexerId, entry.announcement)
      }
      floors.clear()
      for (const [id, sequence] of snapshot.floors || []) floors.set(id, sequence)
      lastAdmitted.clear()
      for (const [id, snap] of snapshot.lastAdmitted || []) lastAdmitted.set(id, { ...snap })
    },
    async restoreLastIndexService ({ indexerId: id }) {
      const snap = lastAdmitted.get(id)
      if (!snap) throw new Error('no previously admitted index service to restore')
      live.set(id, snap.encoded)
      return { restored: true, encoded: snap.encoded, indexerId: id }
    },
  })
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork,
    now: () => INDEX_POLICY_NOW + 2,
  })
  await runtime.start()
  await runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [a1Encoded] })
  t.is(live.get(aId), a1Encoded)
  t.is(floors.get(aId), 1)
  failB = true
  await t.exception(
    runtime.apply({ ...initialPolicy, indexServiceAnnouncements: [a2Encoded, bEncoded] }),
    { message: /B admission failed/ },
  )
  t.is(live.get(aId), a1Encoded, 'session restore rolled A back to seq1')
  t.is(floors.get(aId), 1, 'floor restored to seq1')
  t.is(live.has(bId), false)
  t.is(lastAdmitted.get(aId)?.encoded, a1Encoded)
})
