import test from 'brittle'
import c from 'compact-encoding'
import { getEncoding } from '@peartube/spec/schema'

import { createPolicyApi, DEFAULT_NETWORK_POLICY } from '../src/api/policy.js'

test('policy API validates bounded network, retention, feed trust, moderation, and AI settings', async (t) => {
  const writes = []
  const store = new Map()
  const api = createPolicyApi({ store, onPolicyChange: policy => writes.push(policy) })
  const initial = await api.getNetworkPolicy()
  t.alike(initial.policy, DEFAULT_NETWORK_POLICY)
  t.is(initial.followedPublishersJson, '[]')
  t.is(initial.diskCeilingBytes, DEFAULT_NETWORK_POLICY.diskCeilingBytes)
  const updated = await api.setNetworkPolicy({ uploadPermission: 'enabled', meteredNetwork: 'pause-network', backgroundMode: 'local-only', diskCeilingBytes: 1000, uploadCeilingBytes: 2000, retentionMode: 'archive-pledges' })
  t.is(updated.success, true)
  t.is(updated.policy.uploadPermission, 'enabled')
  t.is(writes.length, 1)
  t.is((await api.getNetworkPolicy()).policy.uploadCeilingBytes, 2000)
  const wireUpdated = await api.setNetworkPolicy({
    uploadCeilingBytesPresent: true,
  })
  t.is(wireUpdated.success, true)
  t.is(wireUpdated.policy.uploadCeilingBytes, 0)
  const unrelatedWireUpdate = await api.setNetworkPolicy({
    uploadPermission: 'disabled',
    diskCeilingBytes: 0,
    uploadCeilingBytes: 0,
    diskCeilingBytesPresent: false,
    uploadCeilingBytesPresent: false,
    followedPublishersJson: null,
    followedIndexesJson: null,
    trustedModerationFeedsJson: null,
  })
  t.is(unrelatedWireUpdate.success, true)
  t.is(unrelatedWireUpdate.policy.diskCeilingBytes, 1000)
  t.is(unrelatedWireUpdate.policy.uploadCeilingBytes, 0)
  const invalidBytes = await api.setNetworkPolicy({ diskCeilingBytes: -1 })
  t.is(invalidBytes.success, false)
  t.is(invalidBytes.errorCode, 'INVALID_POLICY')
  const invalidEnum = await api.setNetworkPolicy({ uploadPermission: 'always' })
  t.is(invalidEnum.success, false)
  t.is(invalidEnum.errorCode, 'INVALID_POLICY')
})

test('wire-decoded unrelated network policy patches preserve both ceilings including explicit zero', async (t) => {
  const encoding = getEncoding('@peartube/set-network-policy-request')
  const api = createPolicyApi({ store: new Map() })
  await api.setNetworkPolicy({ diskCeilingBytes: 1234, uploadCeilingBytes: 5678 })

  const unrelated = c.decode(encoding, c.encode(encoding, { backgroundMode: 'allow' }))
  const unrelatedResult = await api.setNetworkPolicy(unrelated)
  t.is(unrelatedResult.success, true)
  t.is(unrelatedResult.policy.diskCeilingBytes, 1234)
  t.is(unrelatedResult.policy.uploadCeilingBytes, 5678)

  const zero = c.decode(encoding, c.encode(encoding, {
    diskCeilingBytes: 0,
    diskCeilingBytesPresent: true,
  }))
  const zeroResult = await api.setNetworkPolicy(zero)
  t.is(zeroResult.success, true)
  t.is(zeroResult.policy.diskCeilingBytes, 0)
  t.is(zeroResult.policy.uploadCeilingBytes, 5678)
})
