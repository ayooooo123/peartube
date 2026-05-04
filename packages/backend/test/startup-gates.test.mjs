import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STARTUP_MILESTONE,
  createStartupGate,
  createStartupMilestones,
  noteStartupMilestone,
  shouldStartDeferredWarmup,
} from '../src/startup-gates.js'

test('warm-up stays blocked before the first useful peer state', () => {
  assert.equal(shouldStartDeferredWarmup(createStartupMilestones()), false)
})

test('warm-up opens after first swarm peer or feed channel open', () => {
  const swarmPeer = createStartupMilestones()
  noteStartupMilestone(swarmPeer, STARTUP_MILESTONE.SWARM_PEER, 1)
  assert.equal(shouldStartDeferredWarmup(swarmPeer), true)

  const feedChannel = createStartupMilestones()
  noteStartupMilestone(feedChannel, STARTUP_MILESTONE.FEED_CHANNEL_OPEN, 2)
  assert.equal(shouldStartDeferredWarmup(feedChannel), true)
})

test('startup gate resolves once the first useful milestone is recorded', async () => {
  const gate = createStartupGate()
  const waited = gate.waitUntilOpen()

  gate.noteFeedSync(3)

  assert.deepEqual(await waited, {
    firstSwarmPeerAt: null,
    firstFeedChannelOpenAt: null,
    firstFeedSyncAt: 3,
  })
})

test('startup gate timeout returns null when no useful peer state arrives', async () => {
  const gate = createStartupGate()

  assert.equal(await gate.waitUntilOpen({ timeoutMs: 5 }), null)
})

test('startup gate timeout still resolves immediately after a useful peer state arrives', async () => {
  const gate = createStartupGate()
  gate.noteSwarmPeer(4)

  assert.deepEqual(await gate.waitUntilOpen({ timeoutMs: 5000 }), {
    firstSwarmPeerAt: 4,
    firstFeedChannelOpenAt: null,
    firstFeedSyncAt: null,
  })
})
