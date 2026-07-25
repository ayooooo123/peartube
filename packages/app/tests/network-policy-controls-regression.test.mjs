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
  const model = read('lib/network-policy.ts')
  for (const token of ['getNetworkPolicy', 'setNetworkPolicy', 'uploadPermission', 'meteredNetwork', 'backgroundMode', 'diskCeilingBytes', 'uploadCeilingBytes', 'retentionMode', 'public IP', 'cannot retract']) {
    assert.ok(`${network}\n${model}`.includes(token), `network policy missing ${token}`)
  }
  const subscriptionControls = `${subscriptions}\n${read('components/library/FeedTrustEditor.tsx')}\n${model}`
  const moderationControls = `${moderation}\n${read('components/library/ModerationFeedEditor.tsx')}\n${model}`
  assert.match(subscriptionControls, /followedPublishers/)
  assert.match(subscriptionControls, /followedIndexes/)
  assert.match(moderationControls, /trustedModerationFeeds/)
  assert.match(moderationControls, /aiAnalysis/)
})

test('policy editor components do not imply global moderation or guaranteed retention', () => {
  const retention = read('components/library/RetentionPolicyEditor.tsx')
  const moderation = read('components/library/ModerationFeedEditor.tsx')
  assert.match(retention, /not guaranteed|not a guarantee/i)
  assert.doesNotMatch(retention, /guaranteed permanence/i)
  assert.match(moderation, /local policy|your device/i)
  assert.doesNotMatch(moderation, /global moderation/i)
})
