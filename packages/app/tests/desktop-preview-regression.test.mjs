import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const desktopHomeSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/(tabs)/index.web.tsx'), 'utf8')
const searchSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/search.tsx'), 'utf8')

test('desktop Home merges preview cards instead of replacing them during hydration', () => {
  assert.match(desktopHomeSource, /mergePreviewFeedVideos\(\{\s*previousVideos:\s*prev,\s*previewVideos:\s*playablePreviews,/s)
  assert.match(desktopHomeSource, /mergeHydratedFeedVideos\(\{\s*previousVideos:\s*mergePreviewFeedVideos/s)
  assert.match(desktopHomeSource, /feedEntries,\s*identityDriveKey:/s)
  assert.match(desktopHomeSource, /__peartubePendingWatchVideo/)
  assert.doesNotMatch(desktopHomeSource, /setFeedVideos\(playablePreviews\)/)
  assert.doesNotMatch(desktopHomeSource, /const merged = backfilledVideos\.length > 0[\s\S]*: previewVideos/)
})

test('desktop Search preserves direct blob refs from search metadata', () => {
  assert.match(searchSource, /blobId:\s*metadata\.blobId \|\| undefined/)
  assert.match(searchSource, /blobsCoreKey:\s*metadata\.blobsCoreKey \|\| undefined/)
  assert.match(searchSource, /thumbnailBlobId:\s*metadata\.thumbnailBlobId \|\| undefined/)
  assert.match(searchSource, /__peartubePendingWatchVideo = pendingWatch/)
  assert.match(searchSource, /peartube:watch-video/)
})
