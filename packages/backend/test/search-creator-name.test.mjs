import test from 'brittle'

import { buildMetadataEnvelope, buildSearchText } from '../src/search/metadata-envelope.js'
import { SemanticFinder } from '../src/search/semantic-finder.js'

test('search metadata envelope indexes creatorName separately from channelName', (t) => {
  const envelope = buildMetadataEnvelope({
    id: 'archived-video',
    title: 'Archived debate clip',
    description: 'Source mirror',
    channelName: 'Channel',
    creatorName: 'Original Creator',
  }, {
    channelKey: 'relay-archive',
  })

  t.is(envelope.creatorName, 'Original Creator')
  t.is(envelope.sourceFields.creatorName, true)
  t.ok(envelope.searchText.includes('Original Creator'))
  t.ok(buildSearchText(envelope).includes('Original Creator'))
})

test('semantic finder keeps creatorName in stored vector metadata', async (t) => {
  const finder = new SemanticFinder()
  finder.initialized = true

  await finder.indexFromMetadata({
    id: 'archived-video',
    title: 'Archived debate clip',
    channelName: 'Channel',
    creatorName: 'Original Creator',
  }, 'relay-archive')

  const stored = finder.globalIndex.vectors.get('archived-video')?.metadata
  t.is(stored.creatorName, 'Original Creator')
  t.ok(stored.searchText.includes('Original Creator'))
})

test('semantic finder refreshes older vectors when creatorName becomes available', async (t) => {
  const finder = new SemanticFinder()
  finder.initialized = true

  await finder.indexFromMetadata({
    id: 'archived-video',
    title: 'Archived debate clip',
  }, 'relay-archive')

  t.is(finder.needsMetadataRefresh({
    id: 'archived-video',
    creatorName: 'Original Creator',
  }), true)

  await finder.indexFromMetadata({
    id: 'archived-video',
    title: 'Archived debate clip',
    creatorName: 'Original Creator',
  }, 'relay-archive')

  t.is(finder.needsMetadataRefresh({
    id: 'archived-video',
    creatorName: 'Original Creator',
  }), false)
})

