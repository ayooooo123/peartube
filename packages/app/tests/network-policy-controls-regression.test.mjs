import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(appRoot, rel), 'utf8')

test('network policy controls expose bandwidth, disk, retention, trust, moderation, and AI settings with warnings', () => {
  const network = read('app/network-policy.tsx')
  const subscriptions = read('app/subscriptions.tsx')
  const moderation = read('app/moderation.tsx')
  for (const token of ['getNetworkPolicy', 'setNetworkPolicy', 'uploadPermission', 'meteredNetwork', 'backgroundMode', 'diskCeilingBytes', 'uploadCeilingBytes', 'retentionMode', 'public IP', 'cannot retract']) {
    assert.ok(network.includes(token), `network policy missing ${token}`)
  }
  assert.match(subscriptions, /followedPublishers/)
  assert.match(subscriptions, /followedIndexes/)
  assert.match(moderation, /trustedModerationFeeds/)
  assert.match(moderation, /aiAnalysis/)
})

test('policy editor components do not imply global moderation or guaranteed retention', () => {
  const retention = read('components/library/RetentionPolicyEditor.tsx')
  const moderation = read('components/library/ModerationFeedEditor.tsx')
  assert.match(retention, /not guaranteed|not a guarantee/i)
  assert.doesNotMatch(retention, /guaranteed permanence/i)
  assert.match(moderation, /local policy|your device/i)
  assert.doesNotMatch(moderation, /global moderation/i)
})
