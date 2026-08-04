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
    participationMode: 'help-more',
  })

  assert.deepEqual(policy.followedPublishers, ['publisher-a'])
  assert.deepEqual(policy.followedIndexes, ['index-a'])
  assert.deepEqual(policy.trustedModerationFeeds, ['moderator-a'])
  assert.equal(policy.participationMode, 'help-more')
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
    participationMode: 'help-more',
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

test('an absent participation mode decodes as balanced and a bad one is refused', async () => {
  const { normalizeNetworkPolicyResponse, DEFAULT_NETWORK_POLICY } = await loadModel()

  assert.equal(DEFAULT_NETWORK_POLICY.participationMode, 'balanced')
  assert.equal(DEFAULT_NETWORK_POLICY.diskCeilingBytes, 20 * 1024 * 1024 * 1024)
  assert.equal(DEFAULT_NETWORK_POLICY.uploadCeilingBytes, 1024 * 1024 * 1024)
  assert.equal(normalizeNetworkPolicyResponse({}).participationMode, 'balanced')
  assert.throws(() => normalizeNetworkPolicyResponse({ participationMode: 'unlimited' }), /participation mode/)
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

test('Developer Settings exposes the three gated local policy screens', () => {
  const profile = fs.readFileSync(path.resolve(import.meta.dirname, '../app/profile.tsx'), 'utf8')
  const developerSettings = fs.readFileSync(path.resolve(import.meta.dirname, '../app/developer-settings.tsx'), 'utf8')
  for (const route of ['/network-policy', '/subscriptions', '/moderation']) {
    assert.doesNotMatch(profile, new RegExp(`router\\.push\\('${route.replace('/', '\\/')}'\\)`))
    assert.match(developerSettings, new RegExp(`path: '${route.replace('/', '\\/')}'`))
  }
})
