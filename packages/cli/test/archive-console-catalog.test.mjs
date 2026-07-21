import test from 'brittle'
import { buildCatalogChannels } from '../src/archive-console.js'

test('catalog projection includes public feed playable entries when relay cache catalog is empty', async function (t) {
  const channels = []
  const store = {
    async getCompletedVideoPreviewsByChannel () {
      return new Map()
    }
  }
  const publicFeed = {
    getFeed () {
      return [
        {
          driveKey: 'a'.repeat(64),
          publicBeeKey: 'b'.repeat(64),
          source: 'local',
          relayRole: 'publisher',
          relayServing: true,
          channelName: 'Archived Channel',
          videoCount: 1,
          manifestUpdatedAt: 1234,
          previewVideos: [
            {
              id: 'video-1',
              title: 'Archived Video',
              blobId: '0:1:0:99',
              blobsCoreKey: 'c'.repeat(64),
              availability: 'playable',
              byteAvailability: 'playable',
              mimeType: 'video/mp4'
            }
          ]
        }
      ]
    }
  }

  const projected = await buildCatalogChannels({ channels, store, publicFeed })

  t.is(projected.length, 1)
  t.is(projected[0].channelKey, 'a'.repeat(64))
  t.is(projected[0].publicBeeKey, 'b'.repeat(64))
  t.is(projected[0].videoCount, 1)
  t.is(projected[0].previewVideos[0].title, 'Archived Video')
  t.is(projected[0].previewVideos[0].availability, 'playable')
})

test('catalog projection prefers persisted published playable channels over peer snapshots', async function (t) {
  const driveKey = 'd'.repeat(64)
  const publicBeeKey = 'e'.repeat(64)
  const metaDb = {
    async get (key) {
      if (key !== 'published-channels-v2') return null
      return {
        value: [
          {
            driveKey,
            publicBeeKey,
            source: 'local',
            relayRole: 'publisher',
            videoCount: 1,
            manifestUpdatedAt: 5678,
            previewVideos: [
              {
                id: 'video-2',
                title: 'Persisted Playable Video',
                blobId: '0:1:0:88',
                blobsCoreKey: 'f'.repeat(64),
                availability: 'playable',
                byteAvailability: 'playable',
                mimeType: 'video/mp4'
              }
            ]
          }
        ]
      }
    }
  }
  const publicFeed = {
    getFeed () {
      return [
        {
          driveKey,
          publicBeeKey,
          source: 'peer',
          relayRole: 'publisher',
          videoCount: 1,
          previewVideos: [
            {
              id: 'video-2',
              title: 'Peer Downgraded Video',
              blobId: '0:1:0:88',
              blobsCoreKey: 'f'.repeat(64),
              availability: 'unavailable',
              byteAvailability: 'unavailable',
              mimeType: 'video/mp4'
            }
          ]
        }
      ]
    }
  }

  const projected = await buildCatalogChannels({
    channels: [],
    store: { async getCompletedVideoPreviewsByChannel () { return new Map() } },
    publicFeed,
    metaDb
  })

  t.is(projected.length, 1)
  t.is(projected[0].source, 'local')
  t.is(projected[0].previewVideos[0].title, 'Persisted Playable Video')
  t.is(projected[0].previewVideos[0].availability, 'playable')
})

test('catalog projection treats local published blob refs as playable evidence', async function (t) {
  const metaDb = {
    async get (key) {
      if (key !== 'published-channels-v2') return null
      return {
        value: [
          {
            driveKey: '1'.repeat(64),
            publicBeeKey: '2'.repeat(64),
            source: 'local',
            relayRole: 'publisher',
            previewVideos: [
              {
                id: 'video-3',
                title: 'Imported But Downgraded',
                blobId: '0:1:0:77',
                blobsCoreKey: '3'.repeat(64),
                availability: 'unavailable',
                byteAvailability: 'unavailable',
                mimeType: 'video/mp4'
              }
            ]
          }
        ]
      }
    }
  }

  const projected = await buildCatalogChannels({
    channels: [],
    store: { async getCompletedVideoPreviewsByChannel () { return new Map() } },
    publicFeed: { getFeed () { return [] } },
    metaDb
  })

  t.is(projected[0].previewVideos[0].availability, 'playable')
  t.is(projected[0].previewVideos[0].byteAvailability, 'playable')
})

test('catalog projection surfaces newly archived videos not yet in the stored channel snapshot', async function (t) {
  const channelKey = 'c'.repeat(64)
  const publicBeeKey = 'f'.repeat(64)
  const blob = { blobId: '1:2:3:4', blobsCoreKey: 'a'.repeat(64), availability: 'playable' }
  // The persisted channel snapshot is stale: it only knows the first episode.
  const channels = [{
    channelKey,
    publicBeeKey,
    source: 'archive-job',
    previewVideos: [{ id: 'ep1', title: 'Show S01E01', ...blob }]
  }]
  // The completed-archive store has both episodes (the newer one landed after
  // the snapshot was taken).
  const store = {
    async getCompletedVideoPreviewsByChannel () {
      return new Map([[channelKey, [
        { id: 'ep1', title: 'Show S01E01', ...blob },
        { id: 'ep2', title: 'Show S01E02', ...blob }
      ]]])
    }
  }

  const projected = await buildCatalogChannels({ channels, store, publicFeed: { getFeed: () => [] } })
  t.is(projected.length, 1)
  const ids = projected[0].previewVideos.map((v) => v.id).sort()
  t.alike(ids, ['ep1', 'ep2'], 'both the snapshot episode and the newly archived episode are served')
  t.is(projected[0].videoCount, 2)
})
