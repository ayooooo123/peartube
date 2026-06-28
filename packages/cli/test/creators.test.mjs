import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RelayCreators,
  normalizeCreatorId,
  creatorIdFromClassifiedSource,
  deriveCreatorFromVideo,
  summarizeCreatorsFromCatalog,
  rankUnseededTargets,
  videoIsUnseeded
} from '../src/creators.js'
import { classifySourceUrl } from '../src/archive/source-id.js'

function tmpStorage() {
  return mkdtempSync(join(tmpdir(), 'peartube-creators-'))
}

test('normalizeCreatorId upgrades loose archive source ids to canonical form', function (t) {
  t.is(normalizeCreatorId('youtube:UCabcdefghijklmnopqrstuv'), 'youtube:channel:UCabcdefghijklmnopqrstuv')
  t.is(normalizeCreatorId('youtube:@handle'), 'youtube:handle:@handle')
  t.is(normalizeCreatorId('youtube:channel:UCx'), 'youtube:channel:UCx')
  t.is(normalizeCreatorId('youtube:Some Name'), 'youtube:creator:some-name')
  t.is(normalizeCreatorId('owner:abc'), 'owner:abc')
  t.is(normalizeCreatorId(''), null)
})

test('creatorIdFromClassifiedSource maps channel and handle URLs', function (t) {
  t.is(creatorIdFromClassifiedSource(classifySourceUrl('https://www.youtube.com/@LinusTechTips')), 'youtube:handle:@LinusTechTips')
  t.is(creatorIdFromClassifiedSource(classifySourceUrl('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv')), 'youtube:channel:UCabcdefghijklmnopqrstuv')
})

test('deriveCreatorFromVideo always returns a stable id', function (t) {
  t.is(deriveCreatorFromVideo({ creatorSourceId: 'youtube:channel:UC1' }).creatorId, 'youtube:channel:UC1')
  t.is(deriveCreatorFromVideo({ creatorHandle: '@abc' }).creatorId, 'youtube:handle:@abc')
  t.is(deriveCreatorFromVideo({ creatorName: 'Cool Maker' }).creatorId, 'youtube:creator:cool-maker')
  t.is(deriveCreatorFromVideo({}, { channelKey: 'ck' }).creatorId, 'channel:ck')
})

test('videoIsUnseeded treats non-playable availability as unseeded', function (t) {
  t.is(videoIsUnseeded({ availability: 'playable' }), false)
  t.is(videoIsUnseeded({ byteAvailability: 'playable' }), false)
  t.is(videoIsUnseeded({ availability: 'unavailable' }), true)
  t.is(videoIsUnseeded({}), true)
})

test('summarizeCreatorsFromCatalog buckets videos and counts unseeded', function (t) {
  const channels = [
    {
      channelKey: 'c1',
      previewVideos: [
        { id: 'v1', creatorSourceId: 'youtube:channel:UC1', creatorName: 'One', availability: 'playable' },
        { id: 'v2', creatorSourceId: 'youtube:channel:UC1', creatorName: 'One', availability: 'unavailable' }
      ],
      unavailableVideos: [
        { id: 'v3', creatorSourceId: 'youtube:channel:UC1', creatorName: 'One', availability: 'unavailable', classification: { type: 'movie' } }
      ]
    },
    {
      channelKey: 'c2',
      previewVideos: [
        { id: 'v4', creatorName: 'Solo', availability: 'unavailable', classification: { type: 'tv' } }
      ]
    }
  ]

  const creators = summarizeCreatorsFromCatalog(channels)
  const one = creators.find((c) => c.creatorId === 'youtube:channel:UC1')
  const solo = creators.find((c) => c.creatorId === 'youtube:creator:solo')

  t.is(one.videosArchived, 3)
  t.is(one.videosUnseeded, 2)
  t.is(one.classification.movie, 1)
  t.alike(one.channelKeys, ['c1'])
  t.is(solo.videosArchived, 1)
  t.is(solo.videosUnseeded, 1)
  t.is(solo.classification.tv, 1)
})

test('summarizeCreatorsFromCatalog dedupes a creator across channels', function (t) {
  const channels = [
    { channelKey: 'c1', previewVideos: [{ id: 'v1', creatorSourceId: 'youtube:channel:UC1', availability: 'playable' }] },
    { channelKey: 'c2', previewVideos: [{ id: 'v1', creatorSourceId: 'youtube:channel:UC1', availability: 'playable' }] }
  ]
  const creators = summarizeCreatorsFromCatalog(channels)
  t.is(creators.length, 1)
  t.is(creators[0].videosArchived, 1)
  t.alike(creators[0].channelKeys.sort(), ['c1', 'c2'])
})

test('rankUnseededTargets orders by unseeded count then ratio', function (t) {
  const targets = rankUnseededTargets([
    { creatorId: 'a', name: 'A', videosArchived: 10, videosUnseeded: 2 },
    { creatorId: 'b', name: 'B', videosArchived: 4, videosUnseeded: 4 },
    { creatorId: 'c', name: 'C', videosArchived: 5, videosUnseeded: 0 }
  ])
  t.is(targets.length, 2, 'fully seeded creators are excluded')
  t.is(targets[0].creatorId, 'b')
  t.is(targets[1].creatorId, 'a')
})

test('RelayCreators persists, syncs from catalog, and preserves manual fields', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))

  const creators = await RelayCreators.open({ storagePath })
  await creators.upsertCreator({
    creatorId: 'youtube:channel:UC1',
    manual: true,
    name: 'One',
    sourceUrls: ['https://youtube.com/channel/UC1']
  })

  await creators.syncFromCatalog([
    {
      channelKey: 'c1',
      previewVideos: [
        { id: 'v1', creatorSourceId: 'youtube:channel:UC1', creatorName: 'One', availability: 'unavailable' }
      ]
    }
  ])

  // Re-open to confirm persistence round-trips.
  const reopened = await RelayCreators.open({ storagePath })
  const record = reopened.getCreator('youtube:channel:UC1')
  t.is(record.videosArchived, 1)
  t.is(record.videosUnseeded, 1)
  t.alike(record.sourceUrls, ['https://youtube.com/channel/UC1'], 'manual source url preserved across sync')

  const targets = reopened.getTargets()
  t.is(targets[0].creatorId, 'youtube:channel:UC1')

  const summary = reopened.getSummary()
  t.is(summary.totalCreators, 1)
  t.is(summary.videosUnseeded, 1)
})

test('RelayCreators keeps manually-registered creators with no archived videos', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))

  const creators = await RelayCreators.open({ storagePath })
  await creators.upsertCreator({
    creatorId: 'youtube:handle:@new',
    manual: true,
    name: 'New Creator',
    sourceUrls: ['https://youtube.com/@new']
  })
  await creators.syncFromCatalog([])

  const record = creators.getCreator('youtube:handle:@new')
  t.ok(record, 'manual creator survives a sync with no catalog videos')
  t.is(record.videosArchived, 0)
})
