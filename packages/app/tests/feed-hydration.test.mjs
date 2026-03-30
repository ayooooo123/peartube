import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getFeedVideoHydrationMode,
  getFeedVideoLoadEntries,
  getMissingChannelMetaRequests,
} from '../lib/feed-hydration.js'

test('getMissingChannelMetaRequests dedupes channels and respects the visible-first limit', () => {
  const requests = getMissingChannelMetaRequests([
    { driveKey: 'a', publicBeeKey: 'bee-a' },
    { driveKey: 'a', publicBeeKey: 'bee-a-2' },
    { driveKey: 'b', publicBeeKey: 'bee-b' },
    { driveKey: 'c', publicBeeKey: 'bee-c' },
  ], { b: { name: 'Known' } }, 2)

  assert.deepEqual(requests, [
    { channelKey: 'a', publicBeeKey: 'bee-a' },
    { channelKey: 'c', publicBeeKey: 'bee-c' },
  ])
})

test('getFeedVideoLoadEntries returns unique channels in feed order', () => {
  const entries = getFeedVideoLoadEntries([
    { driveKey: 'a' },
    { driveKey: 'b' },
    { driveKey: 'a' },
    { driveKey: 'c' },
  ], 3)

  assert.deepEqual(entries, [
    { driveKey: 'a' },
    { driveKey: 'b' },
    { driveKey: 'c' },
  ])
})

test('getFeedVideoHydrationMode uses local-only hydration for cached entries before peers arrive', () => {
  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'a' }],
    swarmStatus: { peers: 0, feedConnections: 0 },
  }), 'local-only')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'a' }],
    swarmStatus: { peers: 1, feedConnections: 0 },
  }), 'network')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'a' }],
    swarmStatus: { peers: 0, feedConnections: 1 },
  }), 'network')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [],
    swarmStatus: { peers: 0, feedConnections: 0 },
  }), 'off')
})
