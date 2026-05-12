import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  chunkHomeFeedRows,
  getHomeFeedVideosForCategory,
  getVirtualizedHomeFeedRows,
} from '../lib/home-feed-virtualization.js'

test('getVirtualizedHomeFeedRows chunks large feeds for virtualized row rendering', () => {
  const videos = Array.from({ length: 1000 }, (_, index) => ({
    id: `video-${index}`,
    channelKey: 'channel',
    category: index % 2 === 0 ? 'Tech' : 'Music',
  }))

  const rows = getVirtualizedHomeFeedRows({
    videos,
    activeCategory: 'Tech',
    columns: 4,
  })

  assert.equal(rows.length, 125)
  assert.equal(rows[0].length, 4)
  assert.deepEqual(rows[0].map((video) => video.id), ['video-0', 'video-2', 'video-4', 'video-6'])
  assert.equal(rows.at(-1).at(-1).id, 'video-998')
})

test('chunkHomeFeedRows falls back to one column for invalid column counts', () => {
  const videos = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  assert.deepEqual(chunkHomeFeedRows(videos, 0), [[videos[0]], [videos[1]], [videos[2]]])
  assert.deepEqual(chunkHomeFeedRows(videos, Number.NaN), [[videos[0]], [videos[1]], [videos[2]]])
})

test('getHomeFeedVideosForCategory keeps All unfiltered and filters named categories', () => {
  const videos = [
    { id: 'a', category: 'Tech' },
    { id: 'b', category: 'Music' },
    { id: 'c' },
  ]

  assert.deepEqual(getHomeFeedVideosForCategory(videos, 'All').map((video) => video.id), ['a', 'b', 'c'])
  assert.deepEqual(getHomeFeedVideosForCategory(videos, 'Tech').map((video) => video.id), ['a'])
})

test('Home feed uses FlatList virtualization instead of mapping every card in a ScrollView', async () => {
  const source = await readFile(new URL('../app/(tabs)/index.tsx', import.meta.url), 'utf8')

  assert.match(source, /<FlatList[\s\S]*data=\{homeFeedItems\}/)
  assert.match(source, /renderItem=\{renderHomeFeedItem\}/)
  assert.doesNotMatch(source, /feedVideosWithThumbs[\s\S]{0,160}\.map\(\(video/)
  assert.doesNotMatch(source, /myVideosWithMeta[\s\S]{0,160}\.map\(\(video/)
})
