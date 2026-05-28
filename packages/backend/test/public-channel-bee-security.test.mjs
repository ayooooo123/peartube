import test from 'node:test'
import assert from 'node:assert/strict'

import { PublicChannelBee } from '../src/channel/public-channel-bee.js'
import { PublicFeedManager } from '../src/public-feed.js'

test('PublicChannelBee strips private comments metadata from public metadata writes', async () => {
  let stored = {
    name: 'Existing channel',
    commentsAdminKey: 'aa'.repeat(32),
    commentsAutobaseKey: 'bb'.repeat(32),
    commentsDbKey: 'cc'.repeat(32),
  }

  const bee = Object.create(PublicChannelBee.prototype)
  bee.core = { writable: true }
  bee.bee = {
    async get(key) {
      assert.equal(key, 'meta')
      return { value: stored }
    },
    async put(key, value) {
      assert.equal(key, 'meta')
      stored = value
    },
  }

  await bee.setMetadata({
    description: 'Public description',
    commentsAdminKey: 'dd'.repeat(32),
    commentsAutobaseKey: 'ee'.repeat(32),
  })

  assert.equal(stored.name, 'Existing channel')
  assert.equal(stored.description, 'Public description')
  assert.equal(stored.commentsDbKey, 'cc'.repeat(32))
  assert.equal(stored.commentsAdminKey, undefined)
  assert.equal(stored.commentsAutobaseKey, undefined)
})

test('public feed gossip serialization does not forward sensitive metadata fields', () => {
  const manager = new PublicFeedManager({ connections: new Set(), peers: new Set() }, null)
  const serialized = manager._serializeEntry({
    driveKey: '11'.repeat(32),
    publicBeeKey: '22'.repeat(32),
    channelName: 'Public channel',
    commentsAdminKey: 'dd'.repeat(32),
    previewVideos: [{
      id: 'video-1',
      title: 'Video',
      blobId: '0:4:0:512',
      blobsCoreKey: '33'.repeat(32),
      commentsAdminKey: 'ee'.repeat(32),
    }],
  })

  assert.equal(serialized.commentsAdminKey, undefined)
  assert.equal(serialized.previewVideos[0].commentsAdminKey, undefined)
  assert.deepEqual(Object.keys(serialized).filter((key) => key.includes('Admin')), [])
})
