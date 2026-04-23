import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { getFeedThumbnailResolveKey } from '../lib/feed-thumbnail-resolve-key.mjs'

test('getFeedThumbnailResolveKey changes when blob refs appear for the same video', () => {
  const withoutBlobRefs = getFeedThumbnailResolveKey([{
    id: 'video-1',
    channelKey: 'channel-a',
    thumbnailUrl: null,
    thumbnailBlobId: null,
    thumbnailBlobsCoreKey: null,
  }])

  const withBlobRefs = getFeedThumbnailResolveKey([{
    id: 'video-1',
    channelKey: 'channel-a',
    thumbnailUrl: null,
    thumbnailBlobId: 'blob-1',
    thumbnailBlobsCoreKey: 'core-1',
  }])

  assert.notEqual(withoutBlobRefs, withBlobRefs)
})

test('getFeedThumbnailResolveKey scopes repeated video ids by channel', () => {
  const channelAKey = getFeedThumbnailResolveKey([{
    id: 'shared-video',
    channelKey: 'channel-a',
    thumbnailUrl: null,
    thumbnailBlobId: 'blob-1',
    thumbnailBlobsCoreKey: 'core-1',
  }])

  const channelBKey = getFeedThumbnailResolveKey([{
    id: 'shared-video',
    channelKey: 'channel-b',
    thumbnailUrl: null,
    thumbnailBlobId: 'blob-1',
    thumbnailBlobsCoreKey: 'core-1',
  }])

  assert.notEqual(channelAKey, channelBKey)
})

test('HomeScreen derives thumbResolveKey from the shared helper', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const sourcePath = path.resolve(testDir, '../app/(tabs)/index.web.tsx')
  const source = readFileSync(sourcePath, 'utf8')

  assert.match(source, /import\s+\{\s*getFeedThumbnailResolveKey\s*\}\s+from\s+['"]@\/lib\/feed-thumbnail-resolve-key\.mjs['"]/)
  assert.match(source, /const thumbResolveKey = useMemo\(\s*\(\) => getFeedThumbnailResolveKey\(feedVideos\),\s*\[feedVideos\]\s*\)/)
})
