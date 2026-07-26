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
  })
  t.is(saved.success, true)

  const persisted = await loadNetworkPolicy({ store })
  const restarted = runtimeHarness(persisted)
  await restarted.runtime.start()

  t.alike(restarted.events.map(([name]) => name), ['scoped', 'seeding', 'archive'])
  t.is(restarted.events[0][1].uploadCeilingBytes, 512)
  t.is(restarted.events[0][1].networkEnabled, true)
  t.is(restarted.events[1][1].diskCeilingBytes, 2048)
  t.is(restarted.events[2][1].enabled, true)
  t.is(restarted.events[2][1].capacityBytes, 2048)
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
  })
  t.is(harness.reservations, 0, 'disabling archive retention releases reservations')
  t.is(harness.events.filter(([name]) => name === 'seeding').at(-1)[1].diskCeilingBytes, 0)

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
  })

  t.alike(harness.events.map(([name]) => name), ['scoped', 'seeding', 'archive'])
  t.is(harness.events[0][1].uploadCeilingBytes, 77)
})

test('failed manager reconfiguration rolls runtime and persisted policy back', async (t) => {
  const store = asyncPolicyStore()
  const initialPolicy = await loadNetworkPolicy({ store })
  const applied = []
  let rejectArchive = true
  const runtime = createNetworkPolicyRuntime({
    initialPolicy,
    scopedNetwork: {
      async applyNetworkPolicy(policy) {
        applied.push(structuredClone(policy))
      },
    },
    seedingManager: { async applyNetworkPolicy() {} },
    archiveNetwork: {
      async setParticipation({ enabled }) {
        if (enabled && rejectArchive) {
          rejectArchive = false
          return { errorCode: 'ARCHIVE_CAPACITY_EXHAUSTED' }
        }
        return { enabled }
      },
    },
  })
  await runtime.start()
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
  })

  t.is(result.success, false)
  t.alike((await api.getNetworkPolicy()).policy, initialPolicy)
  t.is(applied.at(-1).uploadAllowed, false)
  t.is(applied.at(-1).uploadCeilingBytes, 0)
})

test('unsupported persisted policy fails before deferred manager startup', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  t.exception(() => createNetworkPolicyRuntime({
    initialPolicy: { ...initialPolicy, retentionMode: 'archive-pledges' },
  }), /retentionMode is unsupported/)
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
    { followedPublishers: ['a'.repeat(64)] },
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

test('policy reconciles bounded index and moderation subscriptions through the scoped runtime', async (t) => {
  const initialPolicy = await loadNetworkPolicy({ store: asyncPolicyStore() })
  const calls = []
  const scopedNetwork = {
    async applyNetworkPolicy() {},
    async followIndexFeed({ curatorId }) { calls.push(['follow-index', curatorId]) },
    async unfollowIndexFeed({ curatorId }) { calls.push(['unfollow-index', curatorId]) },
    async followModerationFeed({ moderatorId }) { calls.push(['follow-moderation', moderatorId]) },
    async unfollowModerationFeed({ moderatorId }) { calls.push(['unfollow-moderation', moderatorId]) },
  }
  const runtime = createNetworkPolicyRuntime({ initialPolicy, scopedNetwork })
  const index = '1'.repeat(64)
  const moderator = '2'.repeat(64)
  await runtime.start()
  await runtime.apply({ ...initialPolicy, followedIndexes: [index], trustedModerationFeeds: [moderator] })
  t.alike(calls, [['follow-index', index], ['follow-moderation', moderator]])
  await runtime.apply(initialPolicy)
  t.alike(calls, [
    ['follow-index', index], ['follow-moderation', moderator],
    ['unfollow-index', index], ['unfollow-moderation', moderator],
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
