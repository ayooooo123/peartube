import test from 'brittle'

import { createPolicyApi, DEFAULT_NETWORK_POLICY } from '../src/api/policy.js'

test('policy API validates bounded network, retention, feed trust, moderation, and AI settings', async (t) => {
  const writes = []
  const store = new Map()
  const api = createPolicyApi({ store, onPolicyChange: policy => writes.push(policy) })
  const initial = await api.getNetworkPolicy()
  t.alike(initial.policy, DEFAULT_NETWORK_POLICY)
  t.is(initial.followedPublishersJson, '[]')
  t.is(initial.diskCeilingBytes, DEFAULT_NETWORK_POLICY.diskCeilingBytes)
  const updated = await api.setNetworkPolicy({ uploadPermission: 'manual', meteredNetwork: 'pause-network', backgroundMode: 'local-only', diskCeilingBytes: 1000, uploadCeilingBytes: 2000, retentionMode: 'archive-pledges', followedPublishers: ['p'], followedIndexes: ['i'], trustedModerationFeeds: ['m'], aiAnalysis: 'local-only' })
  t.is(updated.success, true)
  t.is(updated.policy.uploadPermission, 'manual')
  t.is(writes.length, 1)
  t.is((await api.getNetworkPolicy()).policy.trustedModerationFeeds[0], 'm')
  const wireUpdated = await api.setNetworkPolicy({
    followedPublishersJson: '["publisher-wire"]',
    followedIndexesJson: '["index-wire"]',
    trustedModerationFeedsJson: '["moderator-wire"]',
    uploadCeilingBytesPresent: true,
  })
  t.is(wireUpdated.success, true)
  t.is(wireUpdated.policy.uploadCeilingBytes, 0)
  t.alike(wireUpdated.policy.followedPublishers, ['publisher-wire'])
  const wireRead = await api.getNetworkPolicy()
  t.is(wireRead.followedPublishersJson, '["publisher-wire"]')
  const unrelatedWireUpdate = await api.setNetworkPolicy({
    uploadPermission: 'enabled',
    followedPublishersJson: null,
    followedIndexesJson: null,
    trustedModerationFeedsJson: null,
  })
  t.is(unrelatedWireUpdate.success, true)
  t.alike(unrelatedWireUpdate.policy.followedPublishers, ['publisher-wire'])
  const invalidBytes = await api.setNetworkPolicy({ diskCeilingBytes: -1 })
  t.is(invalidBytes.success, false)
  t.is(invalidBytes.errorCode, 'INVALID_POLICY')
  const invalidEnum = await api.setNetworkPolicy({ uploadPermission: 'always' })
  t.is(invalidEnum.success, false)
  t.is(invalidEnum.errorCode, 'INVALID_POLICY')
})
