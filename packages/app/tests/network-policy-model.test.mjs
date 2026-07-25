import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modelPath = path.resolve(import.meta.dirname, '../lib/network-policy.ts')

async function loadModel() {
  assert.ok(fs.existsSync(modelPath), 'network policy model must exist')
  return import(pathToFileURL(modelPath).href)
}

test('network policy model decodes bounded wire fields and encodes explicit zero ceilings', async () => {
  const { normalizeNetworkPolicyResponse, networkPolicyRequest } = await loadModel()
  const policy = normalizeNetworkPolicyResponse({
    uploadPermission: 'enabled',
    meteredNetwork: 'local-only',
    backgroundMode: 'allow',
    diskCeilingBytes: 1024,
    uploadCeilingBytes: 0,
    retentionMode: 'local-pin',
    followedPublishersJson: '["publisher-a"]',
    followedIndexesJson: '["index-a"]',
    trustedModerationFeedsJson: '["moderator-a"]',
    aiAnalysis: 'local-only',
  })

  assert.deepEqual(policy.followedPublishers, ['publisher-a'])
  assert.deepEqual(policy.followedIndexes, ['index-a'])
  assert.deepEqual(policy.trustedModerationFeeds, ['moderator-a'])
  assert.deepEqual(networkPolicyRequest(policy), {
    uploadPermission: 'enabled',
    meteredNetwork: 'local-only',
    backgroundMode: 'allow',
    diskCeilingBytes: 1024,
    diskCeilingBytesPresent: true,
    uploadCeilingBytes: 0,
    uploadCeilingBytesPresent: true,
    retentionMode: 'local-pin',
    followedPublishersJson: '["publisher-a"]',
    followedIndexesJson: '["index-a"]',
    trustedModerationFeedsJson: '["moderator-a"]',
    aiAnalysis: 'local-only',
  })
})

test('network policy actions load and persist the complete local policy through RPC', async () => {
  const { createNetworkPolicyActions } = await loadModel()
  const requests = []
  const rpc = {
    async getNetworkPolicy() {
      return {
        uploadPermission: 'manual', meteredNetwork: 'pause-network', backgroundMode: 'local-only',
        diskCeilingBytes: 2048, uploadCeilingBytes: 512, retentionMode: 'none',
        followedPublishersJson: '[]', followedIndexesJson: '[]', trustedModerationFeedsJson: '[]', aiAnalysis: 'disabled',
      }
    },
    async setNetworkPolicy(request) {
      requests.push(request)
      return { success: true }
    },
  }
  const actions = createNetworkPolicyActions(rpc)
  const current = await actions.load()
  const updated = await actions.save(current, { followedPublishers: ['publisher-a'], uploadCeilingBytes: 0 })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].followedPublishersJson, '["publisher-a"]')
  assert.equal(requests[0].uploadCeilingBytesPresent, true)
  assert.equal(updated.uploadCeilingBytes, 0)
  assert.deepEqual(updated.followedPublishers, ['publisher-a'])
})

test('native policy routes use the initialized RPC and React Native primitives', () => {
  const routeNames = ['network-policy.tsx', 'subscriptions.tsx', 'moderation.tsx']
  const primitives = fs.readFileSync(path.resolve(import.meta.dirname, '../components/library/PolicyControls.tsx'), 'utf8')
  for (const routeName of routeNames) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, `../app/${routeName}`), 'utf8')
    assert.match(source, /useApp/)
    assert.match(source, /useNetworkPolicy/)
    assert.match(`${source}\n${primitives}`, /react-native/)
    assert.doesNotMatch(source, /<(main|section|h1|h2|p|dl|dt|dd|ul|li)\b/)
  }
})

test('profile exposes the three local policy screens', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../app/profile.tsx'), 'utf8')
  assert.match(source, /\/network-policy/)
  assert.match(source, /\/subscriptions/)
  assert.match(source, /\/moderation/)
})
