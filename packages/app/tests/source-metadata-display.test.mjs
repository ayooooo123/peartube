import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getSourceMetadataDisplay,
  hasSourceMetadata,
} from '../lib/source-metadata.js'

test('hasSourceMetadata detects relay archive source fields', () => {
  assert.equal(hasSourceMetadata({}), false)
  assert.equal(hasSourceMetadata({ sourcePlatform: 'youtube' }), true)
  assert.equal(hasSourceMetadata({ sourceUrl: 'https://example.com/video' }), true)
})

test('getSourceMetadataDisplay formats compact Grayjay-style metadata', () => {
  const now = 1700100000000
  const display = getSourceMetadataDisplay({
    sourcePlatform: 'youtube',
    sourcePlatformLabel: 'YouTube',
    sourceUrl: 'https://www.youtube.com/watch?v=demo',
    sourceCreatorName: 'Emergency Awesome',
    sourceCreatorHandle: '@emergencyawesome',
    sourcePublishedAt: now - 24 * 60 * 60 * 1000,
    sourceViewCount: 75080,
    sourceLikeCount: 2200,
    sourceCommentCount: 341,
    sourceArchivedAt: 1700000300000,
    sourceRelayId: 'relay-a',
  }, { now })

  assert.equal(display.hasSource, true)
  assert.equal(display.platformLabel, 'YouTube')
  assert.equal(display.creatorLabel, '@emergencyawesome')
  assert.equal(display.compactLine, '@emergencyawesome · 75.1K views · 1d ago')
  assert.equal(display.detailCounts, '75.1K views · 2.2K likes · 341 comments')
  assert.equal(display.archiveLine, 'Archived by relay-a')
  assert.equal(display.sourceUrl, 'https://www.youtube.com/watch?v=demo')
})

test('getSourceMetadataDisplay falls back to platform ids when labels are missing', () => {
  const display = getSourceMetadataDisplay({
    sourcePlatform: 'odysee',
    sourceViewCount: 1,
  })

  assert.equal(display.platformLabel, 'Odysee')
  assert.equal(display.compactLine, '1 view')
})

test('getSourceMetadataDisplay does not render unknown counts as zero', () => {
  const display = getSourceMetadataDisplay({
    sourcePlatform: 'youtube',
    sourceCreatorHandle: '@source',
  })

  assert.equal(display.compactLine, '@source')
  assert.equal(display.detailCounts, '')
})
