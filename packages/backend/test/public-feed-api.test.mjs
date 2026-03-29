import test from 'brittle'

import { createApi } from '../src/api.js'

test('getPublicFeed returns peer entries even when publicBeeKey is absent', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [
          {
            driveKey: '11'.repeat(32),
            publicBeeKey: null,
            addedAt: 1,
            source: 'peer',
          },
          {
            driveKey: '22'.repeat(32),
            publicBeeKey: '33'.repeat(32),
            addedAt: 2,
            source: 'peer',
          },
        ]
      },
      getStats() {
        return {
          totalEntries: 2,
          hiddenCount: 0,
          peerCount: 1,
        }
      },
      requestFeedsFromPeers() {
        return 1
      },
    },
  })

  const result = api.getPublicFeed()

  t.is(result.entries.length, 2)
  t.is(result.stats.peerCount, 1)
  t.is(result.stats.keyedEntries, 1)
  t.is(result.stats.unkeyedEntries, 1)
  t.alike(result.entries[0], {
    channelKey: '11'.repeat(32),
    publicBeeKey: null,
    channelName: null,
    videoCount: 0,
    peerCount: 0,
    lastSeen: 1,
  })
})
