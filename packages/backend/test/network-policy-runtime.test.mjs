import test from 'brittle'
import { createNetworkLifecycleApi } from '../src/api/network-lifecycle.js'

import {
  createNetworkPolicyRuntime,
  createPolicyApi,
  loadNetworkPolicy,
} from '../src/api/policy.js'

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
  const initialPolicy = await loadNetworkPolicy({ store })
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
  t.is(applied.at(-1).uploadAllowed, false)
  t.is(applied.at(-1).uploadCeilingBytes, 0)
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
    { followedPublishers: ['publisher-a'] },
    { followedIndexes: ['index-a'] },
    { trustedModerationFeeds: ['moderator-a'] },
    { aiAnalysis: 'local-only' },
    { retentionMode: 'local-pin' },
  ]) {
    const result = await api.setNetworkPolicy(patch)
    t.is(result.success, false)
    t.is(result.errorCode, 'UNSUPPORTED_POLICY_FIELD')
  }
  t.alike((await api.getNetworkPolicy()).policy, initialPolicy)
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
  const api = createNetworkLifecycleApi({
    networkPolicyRuntime: {
      async setEnvironment(environment) {
        transitions.push(environment)
      },
    },
  })

  t.is((await api.suspendNetwork()).success, true)
  t.is((await api.resumeNetwork()).success, true)
  t.alike(transitions, [{ background: true }, { background: false }])
})
