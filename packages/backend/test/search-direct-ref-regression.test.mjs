import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const apiSource = fs.readFileSync(path.join(repoRoot, 'packages/backend/src/api/search.js'), 'utf8')
const semanticFinderSource = fs.readFileSync(path.join(repoRoot, 'packages/backend/src/search/semantic-finder.js'), 'utf8')

test('global search keeps preview/direct-ref results without blocking on hydration', () => {
  assert.match(apiSource, /const hasDirectRefs = Boolean\(meta\.blobId && meta\.blobsCoreKey\)/)
  assert.match(apiSource, /const previewVideo = getPreviewVideoFromFeed\(channelKey, r\.id, meta\.publicBeeKey\)/)
  assert.match(apiSource, /if \(hasDirectRefs \|\| previewVideo\?\.blobId\)/)
  assert.match(apiSource, /blobId: meta\.blobId \|\| previewVideo\?\.blobId \|\| null/)
  assert.match(apiSource, /blobsCoreKey: meta\.blobsCoreKey \|\| previewVideo\?\.blobsCoreKey \|\| null/)
})

test('search index metadata includes direct playback and thumbnail refs', () => {
  assert.match(semanticFinderSource, /blobId: video\.blobId \|\| null/)
  assert.match(semanticFinderSource, /blobsCoreKey: video\.blobsCoreKey \|\| null/)
  assert.match(semanticFinderSource, /thumbnailBlobId: video\.thumbnailBlobId \|\| null/)
  assert.match(semanticFinderSource, /thumbnailBlobsCoreKey: video\.thumbnailBlobsCoreKey \|\| null/)
  assert.match(semanticFinderSource, /availability: video\.availability \|\| null/)
})
