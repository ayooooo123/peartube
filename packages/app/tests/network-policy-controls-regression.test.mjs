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
  for (const token of ['getNetworkPolicy', 'setNetworkPolicy', 'uploadPermission', 'meteredNetwork', 'backgroundMode', 'diskCeilingBytes', 'uploadCeilingBytes', 'retentionMode', 'participationMode', 'public IP', 'cannot retract']) {
    assert.ok(`${network}\n${model}`.includes(token), `network policy missing ${token}`)
  }
  const subscriptionControls = `${subscriptions}\n${read('components/library/FeedTrustEditor.tsx')}\n${model}`
  const moderationControls = `${moderation}\n${read('components/library/ModerationFeedEditor.tsx')}\n${model}`
  assert.match(subscriptionControls, /followedPublishers/)
  assert.match(subscriptionControls, /followedIndexes/)
  assert.match(moderationControls, /trustedModerationFeeds/)
  assert.match(moderationControls, /aiAnalysis/)
})

/**
 * The everyday choice is Data Saver / Balanced / Help More on the profile
 * screen. This screen is the operator half of that split: exact bytes, the
 * transfer enums, and archive participation, all behind Developer Mode. It must
 * not grow a second copy of the everyday choice.
 */
test('the gated policy screen holds the exact overrides and names the mode it is overriding', () => {
  const network = read('app/network-policy.tsx')
  const profile = read('app/profile.tsx')
  const retention = read('components/library/RetentionPolicyEditor.tsx')

  assert.match(network, /<DeveloperModeGate>/, 'the exact overrides stay behind Developer Mode')
  assert.match(network, /PARTICIPATION_MODE_LABELS\[state\.policy\.participationMode\]/, 'the screen reports the active mode')
  assert.match(network, /Chosen in Profile/, 'and says where the everyday choice lives')
  assert.doesNotMatch(network, /PARTICIPATION_MODE_OPTIONS/, 'the mode picker is not duplicated here')

  // Exact byte ceilings and archive participation belong to this screen only.
  assert.match(retention, /ByteLimitEditor[\s\S]*diskCeilingBytes/)
  assert.match(retention, /ByteLimitEditor[\s\S]*uploadCeilingBytes/)
  assert.match(retention, /Archive participation/)
  assert.doesNotMatch(profile, /diskCeilingBytes|uploadCeilingBytes/, 'the consumer screen never edits raw ceilings')

  // The transfer enums stay operator-only too.
  for (const control of ['Upload permission', 'Metered network', 'Background mode']) {
    assert.ok(network.includes(control), `developer settings missing ${control}`)
    assert.ok(!profile.includes(control), `${control} must not appear in normal preferences`)
  }
})

test('policy editor components do not imply global moderation or guaranteed retention', () => {
  const retention = read('components/library/RetentionPolicyEditor.tsx')
  const moderation = read('components/library/ModerationFeedEditor.tsx')
  assert.match(retention, /not guaranteed|not a guarantee/i)
  assert.doesNotMatch(retention, /guaranteed permanence/i)
  assert.match(moderation, /local policy|your device/i)
  assert.doesNotMatch(moderation, /global moderation/i)
})
