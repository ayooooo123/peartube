import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const searchSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/search.tsx'), 'utf8')

test('Search consumes moderated media entities rather than raw vector metadata', () => {
  assert.match(searchSource, /getMediaCatalog/)
  assert.match(searchSource, /searchMediaCatalog/)
  assert.doesNotMatch(searchSource, /\bmetadata\b|globalSearchVideos/)
})

test('Search delegates source selection and playback preparation to media detail', () => {
  assert.match(searchSource, /getMediaEntityRouteId\(item as any\)/)
  assert.match(searchSource, /encodeMediaEntityRouteParam\(item as any\)/)
  assert.doesNotMatch(searchSource, /preparePlayback|loadAndPlayVideo/)
})

test('Search never serializes direct blob refs into a platform handoff', () => {
  assert.doesNotMatch(searchSource, /blobId|blobsCoreKey|videoData|PendingWatch/)
})
