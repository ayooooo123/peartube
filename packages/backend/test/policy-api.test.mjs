import test from 'brittle'

import { createPolicyApi, DEFAULT_NETWORK_POLICY } from '../src/api/policy.js'

test('policy API validates bounded network, retention, feed trust, moderation, and AI settings', async (t) => {
  const writes = []
  const store = new Map()
  const api = createPolicyApi({ store, onPolicyChange: policy => writes.push(policy) })
  t.alike(await api.getNetworkPolicy(), { success: true, policy: DEFAULT_NETWORK_POLICY })
  const updated = await api.setNetworkPolicy({ uploadPermission: 'manual', meteredNetwork: 'pause-network', backgroundMode: 'local-only', diskCeilingBytes: 1000, uploadCeilingBytes: 2000, retentionMode: 'archive-pledges', followedPublishers: ['p'], followedIndexes: ['i'], trustedModerationFeeds: ['m'], aiAnalysis: 'local-only' })
  t.is(updated.success, true)
  t.is(updated.policy.uploadPermission, 'manual')
  t.is(writes.length, 1)
  t.is((await api.getNetworkPolicy()).policy.trustedModerationFeeds[0], 'm')
  const invalidBytes = await api.setNetworkPolicy({ diskCeilingBytes: -1 })
  t.is(invalidBytes.success, false)
  t.is(invalidBytes.errorCode, 'INVALID_POLICY')
  const invalidEnum = await api.setNetworkPolicy({ uploadPermission: 'always' })
  t.is(invalidEnum.success, false)
  t.is(invalidEnum.errorCode, 'INVALID_POLICY')
})
