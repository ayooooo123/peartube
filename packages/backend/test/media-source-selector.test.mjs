import test from 'brittle'

import {
  scorePublicationSource,
  scorePublicationSourceComponents,
  selectPublicationSources,
} from '../src/media-graph/source-selector.js'

test('source selector scores trust, confidence, availability, format support, and moderation penalties', (t) => {
  const sources = selectPublicationSources([
    { publicationId: 'b', metadataConfidence: 900, publisherTrust: 20, availabilityScore: 50, formatSupport: 100, moderationPenalty: 0 },
    { publicationId: 'a', metadataConfidence: 900, publisherTrust: 20, availabilityScore: 50, formatSupport: 100, moderationPenalty: 0 },
    { publicationId: 'blocked', metadataConfidence: 1000, publisherTrust: 100, availabilityScore: 100, formatSupport: 100, moderationPenalty: 1000 },
  ])

  t.alike(sources.map(source => source.publicationId), ['a', 'b', 'blocked'])
  t.ok(sources[0].score > sources[2].score)
})

test('source selector never treats publisher ownership as abstract entity identity', (t) => {
  const sources = selectPublicationSources([
    { publicationId: 'same-work-other-publisher', entityId: 'work:1', ownerPublisherId: 'publisher-b', publisherTrust: 10 },
    { publicationId: 'same-work-owner', entityId: 'work:1', ownerPublisherId: 'publisher-a', publisherTrust: 10, ownsEntity: true },
  ])

  t.alike(sources.map(source => source.publicationId), ['same-work-other-publisher', 'same-work-owner'])
})

test('source selector keeps weighted score components finite and equivalent to the total', (t) => {
  const source = {
    metadataConfidence: Number.MAX_VALUE,
    publisherTrust: Number.MAX_VALUE,
    availabilityScore: Number.MAX_VALUE,
    formatSupport: Number.MAX_VALUE,
    moderationPenalty: Number.MAX_VALUE,
  }
  const components = scorePublicationSourceComponents(source)
  const contributions = Object.values(components)

  t.ok(contributions.every(Number.isFinite))
  t.is(scorePublicationSource(source), contributions.reduce((total, value) => total + value, 0))
})
