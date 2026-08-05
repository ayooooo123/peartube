import test from 'node:test'
import assert from 'node:assert/strict'
import { projectMediaEntityGraph } from '../lib/media-entity-graph.js'

test('collapses duplicate publications into one work with alternate sources and provenance', () => {
  const graph = projectMediaEntityGraph({
    resolvedEntities: [
      {
        localEntityId: 'work:tmdb-episode:entourage-s1e1',
        entityKind: 'work',
        contentKind: 'episode',
        preferredMetadata: { title: 'Entourage', seriesTitle: 'Entourage' },
        seasonNumber: 1,
        episodeNumber: 1,
        artwork: [{ role: 'still', remoteUrl: 'https://example.test/still.jpg' }],
        contributions: [{ role: 'director', agentName: 'Pilot Director' }],
        publications: [
          { publicationId: 'pub-a', renditionId: 'rend-a', publisherId: 'publisher-a', publisherName: 'Publisher A', availabilityStatus: 'available', verified: true },
          { publicationId: 'pub-b', renditionId: 'rend-b', publisherId: 'publisher-b', publisherName: 'Publisher B', availabilityStatus: 'available' },
        ],
      },
      {
        localEntityId: 'work:tmdb-episode:entourage-s1e1',
        entityKind: 'work',
        contentKind: 'episode',
        preferredMetadata: { title: 'Entourage' },
        publications: [
          { publicationId: 'pub-c', renditionId: 'rend-c', publisherId: 'publisher-c', publisherName: 'Publisher C', availabilityStatus: 'cached', cached: true },
        ],
      },
    ],
  })

  assert.equal(graph.mediaItems.length, 1)
  const episode = graph.mediaItems[0]
  assert.equal(episode.localEntityId, 'work:tmdb-episode:entourage-s1e1')
  assert.equal(episode.sourceCount, 3)
  assert.equal(episode.selectedSource.publicationId, 'pub-c')
  assert.equal(episode.publisherName, 'Publisher C')
  assert.equal(episode.sourceProviderName, 'Publisher C')
  assert.equal(episode.alternateSources.length, 2)
  assert.equal(episode.provenance.length, 3)
  assert.equal(episode.stillUrl, 'https://example.test/still.jpg')
  assert.equal(episode.creatorRoles[0].role, 'director')
})

test('keeps creator roles distinct from publisher/source-provider attribution', () => {
  const graph = projectMediaEntityGraph({
    resolvedEntities: [
      {
        localEntityId: 'work:film:1',
        entityKind: 'work',
        contentKind: 'movie',
        preferredMetadata: { title: 'A Film' },
        contributions: [
          { role: 'director', agentName: 'Director Person' },
          { role: 'performer', agentName: 'Lead Actor' },
        ],
        publications: [
          { publicationId: 'pub-archive', publisherId: 'publisher-archive', publisherName: 'Public Archive Mirror', availabilityStatus: 'available' },
        ],
      },
    ],
  })

  const item = graph.mediaItems[0]
  assert.equal(item.creatorName, 'Director Person')
  assert.equal(item.publisherName, 'Public Archive Mirror')
  assert.deepEqual(item.creatorRoles.map((role) => role.role), ['director', 'performer'])
})

test('projects partial collections without inventing missing-member truth', () => {
  const graph = projectMediaEntityGraph({
    collections: [
      {
        localEntityId: 'collection:season:show-x:s1',
        entityKind: 'collection',
        contentKind: 'season',
        preferredMetadata: { title: 'Show X Season 1' },
        items: [{ localEntityId: 'work:e1' }, { localEntityId: 'work:e3' }],
        missingMembers: [{ position: { season: 1, episode: 2 }, reason: 'trusted-structure-gap' }],
        trustedStructure: true,
      },
      {
        localEntityId: 'collection:season:show-x:s1',
        entityKind: 'collection',
        contentKind: 'season',
        preferredMetadata: { title: 'Show X Season 1' },
        items: [{ localEntityId: 'work:e2' }, { localEntityId: 'work:e3' }],
        missingMembers: [{ position: { season: 1, episode: 4 }, reason: 'trusted-structure-gap' }],
      },
    ],
  })

  assert.equal(graph.collections.length, 1)
  assert.equal(graph.collections[0].itemCount, 3)
  assert.deepEqual(graph.collections[0].items.map((member) => member.localEntityId), ['work:e1', 'work:e3', 'work:e2'])
  assert.equal(graph.collections[0].missingMembers.length, 2)
  assert.equal(graph.collections[0].completeness.missingCount, 2)
  assert.equal(graph.collections[0].completeness.hasTrustedStructure, true)
})

test('preserves conflict arrays and explicit metadata instead of title parsing', () => {
  const graph = projectMediaEntityGraph({
    resolvedEntities: [
      {
        localEntityId: 'work:conflict:1',
        entityKind: 'work',
        title: 'File.Name.S01E02.1080p.mkv',
        preferredMetadata: { title: 'Actual Episode Title', contentKind: 'episode' },
        conflicts: [{ claimId: 'claim-conflict-1', field: 'seasonNumber' }],
        publications: [{ publicationId: 'pub-1', renditionId: 'rend-1', publisherName: 'Uploader', availabilityStatus: 'available' }],
      },
    ],
  })

  const item = graph.mediaItems[0]
  assert.equal(item.title, 'Actual Episode Title')
  assert.equal(item.contentKind, 'episode')
  assert.equal(item.seasonNumber, null)
  assert.equal(item.episodeNumber, null)
  assert.equal(item.conflicts.length, 1)
})

test('legacy adapter creates attributed publications without claiming global entity truth', () => {
  const graph = projectMediaEntityGraph({
    feedVideos: [
      {
        id: 'video-1',
        title: 'Loose Upload',
        channelKey: 'channel-a',
        channelName: 'Uploader Channel',
        thumbnailUrl: 'https://example.test/thumb.jpg',
      },
    ],
  }, { includeLegacy: true })

  assert.equal(graph.mediaItems.length, 1)
  assert.equal(graph.mediaItems[0].localEntityId, 'legacy:channel-a:video-1')
  assert.equal(graph.mediaItems[0].publisherName, 'Uploader Channel')
  assert.equal(graph.mediaItems[0].provenance[0].role, 'legacy-publication')
  assert.equal(graph.mediaItems[0].thumbnailUrl, 'https://example.test/thumb.jpg')
})


test('does not mark untrusted missing members as trusted collection structure', () => {
  const graph = projectMediaEntityGraph({
    collections: [
      {
        localEntityId: 'collection:season:untrusted',
        entityKind: 'collection',
        contentKind: 'season',
        preferredMetadata: { title: 'Untrusted Season' },
        items: [{ localEntityId: 'work:e1' }],
        missingMembers: [{ position: { season: 1, episode: 2 }, reason: 'peer-claim' }],
      },
      {
        localEntityId: 'collection:season:untrusted',
        entityKind: 'collection',
        contentKind: 'season',
        preferredMetadata: { title: 'Untrusted Season' },
        missingMembers: [{ position: { season: 1, episode: 3 }, reason: 'peer-claim' }],
      },
    ],
  })

  assert.equal(graph.collections[0].missingMembers.length, 2)
  assert.equal(graph.collections[0].completeness.hasTrustedStructure, false)
})

test('preserves distinct provenance evidence claims with the same publisher and rendition', () => {
  const graph = projectMediaEntityGraph({
    resolvedEntities: [
      {
        localEntityId: 'work:provenance:1',
        entityKind: 'work',
        preferredMetadata: { title: 'Provenance Work' },
        provenance: [
          { claimId: 'claim-a', publisherId: 'publisher-1', publicationId: 'pub-1', renditionId: 'rend-1', role: 'metadata', evidenceHash: 'hash-a' },
          { claimId: 'claim-b', publisherId: 'publisher-1', publicationId: 'pub-1', renditionId: 'rend-1', role: 'metadata', evidenceHash: 'hash-b' },
        ],
        publications: [{ publicationId: 'pub-1', renditionId: 'rend-1', publisherId: 'publisher-1', publisherName: 'Publisher 1', availabilityStatus: 'available' }],
      },
    ],
  })

  const claimIds = graph.mediaItems[0].provenance.map((entry) => entry.claimId).filter(Boolean).sort()
  assert.deepEqual(claimIds, ['claim-a', 'claim-b'])
})

test('projects one bounded work with alternate publications, creator roles, provenance, and conflicts', () => {
  const projected = projectMediaEntityGraph({
    entity: { entityId: 'work:alpha', title: 'Alpha', creator: 'Alice' },
    publications: [
      { publicationId: 'pub-a', publisherId: 'publisher-a', sourceProvider: 'Publisher A', renditionId: 'rend-a', availabilityState: 'available', rejectionReasonCodes: [] },
      { publicationId: 'pub-b', publisherId: 'publisher-b', sourceProvider: 'Publisher B', renditionId: 'rend-b', availabilityState: 'available', rejectionReasonCodes: [] },
    ],
    contributions: [
      { agentId: 'agent:alice', name: 'Alice', role: 'performer' },
      { agentId: 'agent:bob', name: 'Bob', role: 'director' },
    ],
    provenance: ['claim-a', 'claim-b'],
    conflicts: [{ field: 'title', values: ['Alpha', 'Alfa'] }],
  })
  assert.equal(projected.id, 'work:alpha')
  assert.equal(projected.sources.length, 2)
  assert.equal(projected.primarySource.publicationId, 'pub-a')
  assert.deepEqual(projected.creatorRoles.map(role => role.role).sort(), ['director', 'performer'])
  assert.deepEqual(projected.provenance, ['claim-a', 'claim-b'])
  assert.equal(projected.conflicts.length, 1)
})

test('bounded entity projection never falls back to an unauthorized first source', () => {
  const projected = projectMediaEntityGraph({
    entity: { entityId: 'work:blocked', title: 'Blocked' },
    publications: [{
      publicationId: 'pub-blocked',
      renditionId: 'rend-blocked',
      playable: true,
      availabilityState: 'available',
      rejectionReasonCodes: ['UNAUTHORIZED_PUBLICATION'],
    }],
  })
  assert.equal(projected.primarySource, null)
  assert.equal(projected.playbackRef, null)
})

test('bounded partial collections preserve placeholders and do not collapse remasters', () => {
  const projected = projectMediaEntityGraph({
    entity: { entityId: 'collection:season-1', title: 'Season 1' },
    collectionItems: [
      { entityId: 'work:e1', title: 'Episode 1', position: 1, available: true },
      { entityId: 'work:e2', title: 'Episode 2', position: 2, available: false },
      { entityId: 'work:e1-remaster', title: 'Episode 1 Remaster', position: 1, edition: 'remaster', available: true },
    ],
  })
  assert.equal(projected.collection.items.length, 3)
  assert.equal(projected.collection.items.find(item => item.entityId === 'work:e2').available, false)
  assert.equal(projected.collection.items.filter(item => item.position === 1).length, 2)
})

test('categories the publisher claimed reach the app, and ones nobody claimed stay absent', () => {
  const graph = projectMediaEntityGraph({
    resolvedEntities: [
      {
        localEntityId: 'work:movie:described',
        entityKind: 'work',
        contentKind: 'movie',
        preferredMetadata: { title: 'Described' },
        releaseYear: 1999,
        runtimeMinutes: 136,
        overview: 'A synopsis a consumer cannot look up anywhere else.',
        genres: ['Action', 'Sci-Fi'],
        publications: [{ publicationId: 'pub-described', renditionId: 'rend-1', publisherId: 'publisher-a', availabilityStatus: 'available' }],
      },
      {
        localEntityId: 'work:movie:undescribed',
        entityKind: 'work',
        contentKind: 'movie',
        preferredMetadata: { title: 'Undescribed' },
        publications: [{ publicationId: 'pub-undescribed', renditionId: 'rend-2', publisherId: 'publisher-b', availabilityStatus: 'available' }],
      },
    ],
  })

  const described = graph.mediaItems.find(item => item.localEntityId === 'work:movie:described')
  assert.equal(described.releaseYear, 1999)
  assert.equal(described.runtimeMinutes, 136)
  assert.equal(described.overview, 'A synopsis a consumer cannot look up anywhere else.')
  assert.deepEqual(described.genres, ['Action', 'Sci-Fi'])

  const undescribed = graph.mediaItems.find(item => item.localEntityId === 'work:movie:undescribed')
  for (const field of ['releaseYear', 'runtimeMinutes', 'overview', 'genres']) {
    assert.equal(field in undescribed, false, `${field} is absent, not an empty string or a zero`)
  }
  assert.equal(undescribed.durationSec, null, 'a runtime in minutes is never mistaken for a playback duration in seconds')
})

test('one publisher describing a title fills in for another that did not', () => {
  const graph = projectMediaEntityGraph({
    resolvedEntities: [
      {
        localEntityId: 'work:movie:shared',
        entityKind: 'work',
        contentKind: 'movie',
        preferredMetadata: { title: 'Shared' },
        publications: [{ publicationId: 'pub-quiet', renditionId: 'rend-1', publisherId: 'publisher-a', availabilityStatus: 'available' }],
      },
      {
        localEntityId: 'work:movie:shared',
        entityKind: 'work',
        contentKind: 'movie',
        preferredMetadata: { title: 'Shared' },
        releaseYear: 2005,
        genres: ['Comedy'],
        publications: [{ publicationId: 'pub-described', renditionId: 'rend-2', publisherId: 'publisher-b', availabilityStatus: 'available' }],
      },
    ],
  })

  assert.equal(graph.mediaItems.length, 1)
  const [shared] = graph.mediaItems
  assert.equal(shared.releaseYear, 2005)
  assert.deepEqual(shared.genres, ['Comedy'])
  assert.equal('runtimeMinutes' in shared, false, 'neither publisher claimed a runtime, so none is invented')
})
