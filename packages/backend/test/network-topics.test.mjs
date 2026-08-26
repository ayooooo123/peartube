import test from 'brittle'
import b4a from 'b4a'

import {
  PROTOCOL_MAJOR,
  deriveArchiveDiscoveryTopic,
  deriveArchiveTopic,
  deriveAssetTopic,
  deriveBootstrapTopic,
  deriveLiveTopic,
  derivePublisherTopic,
  describeScopedTopic,
  topicHex,
} from '../src/network/index.js'

const publisherId = 'a'.repeat(64)
const otherPublisherId = 'b'.repeat(64)
const renditionId = 'rendition:' + 'c'.repeat(64)

function assertTopic(t, topic) {
  t.is(b4a.isBuffer(topic), true)
  t.is(topic.byteLength, 32)
}

test('network topic derivation vectors are stable and domain separated by purpose', (t) => {
  const bootstrap = deriveBootstrapTopic({ networkId: 'peartube-main', protocolMajor: 1 })
  const publisher = derivePublisherTopic({ publisherId, catalogEpoch: 7, protocolMajor: 1 })
  const asset = deriveAssetTopic({ renditionId, protocolMajor: 1 })
  const live = deriveLiveTopic({ eventId: 'concert', epoch: 3, protocolMajor: 1 })
  const archive = deriveArchiveTopic({ archiveId: 'archive-1', protocolMajor: 1 })

  for (const topic of [bootstrap, publisher, asset, live, archive]) assertTopic(t, topic)
  t.alike(topicHex(bootstrap), '752ab65093926e49435ab7f0f729b62443bb10f5ce24e9b966825710cbe697d8')
  t.not(topicHex(bootstrap), topicHex(publisher))
  t.not(topicHex(publisher), topicHex(asset))
  t.not(topicHex(asset), topicHex(live))
  t.not(topicHex(live), topicHex(archive))
})

test('omitted topic majors use the exported current major while explicit v1 vectors remain distinct', (t) => {
  const vectors = [
    [deriveBootstrapTopic, { networkId: 'current-default' }],
    [derivePublisherTopic, { publisherId, catalogEpoch: 3 }],
    [deriveArchiveDiscoveryTopic, { networkId: 'current-default' }],
    [deriveArchiveTopic, { archiveId: 'current-default' }],
  ]
  for (const [derive, input] of vectors) {
    t.alike(derive(input), derive({ ...input, protocolMajor: PROTOCOL_MAJOR }))
    t.not(topicHex(derive(input)), topicHex(derive({ ...input, protocolMajor: 1 })))
    t.exception(() => derive({ ...input, protocolMajor: 0 }), /protocolMajor/)
  }
})

test('publisher topics change by publisher id, catalog epoch, and protocol major', (t) => {
  const base = topicHex(derivePublisherTopic({ publisherId, catalogEpoch: 1, protocolMajor: 1 }))
  t.not(base, topicHex(derivePublisherTopic({ publisherId: otherPublisherId, catalogEpoch: 1, protocolMajor: 1 })))
  t.not(base, topicHex(derivePublisherTopic({ publisherId, catalogEpoch: 2, protocolMajor: 1 })))
  t.not(base, topicHex(derivePublisherTopic({ publisherId, catalogEpoch: 1, protocolMajor: 2 })))
})

test('asset topics depend on exact rendition id and major, never publisher identity', (t) => {
  const a = topicHex(deriveAssetTopic({ renditionId, protocolMajor: 1, publisherId }))
  const b = topicHex(deriveAssetTopic({ renditionId, protocolMajor: 1, publisherId: otherPublisherId }))
  t.is(a, b, 'publisher identity is intentionally ignored for exact asset swarms')
  t.not(a, topicHex(deriveAssetTopic({ renditionId: renditionId + ':variant', protocolMajor: 1 })))
  t.not(a, topicHex(deriveAssetTopic({ renditionId, protocolMajor: 2 })))
})

test('bootstrap locators do not reveal asset topics without an explicit verified rendition id', (t) => {
  const bootstrap = describeScopedTopic('bootstrap', { networkId: 'peartube-main', protocolMajor: 1 })
  t.is(bootstrap.role, 'bootstrap')
  t.absent(bootstrap.renditionId)
  t.exception(() => deriveAssetTopic({ protocolMajor: 1 }), /renditionId is required/)
})

test('live topics rotate by event epoch and descriptor digest without leaking secret material', (t) => {
  const base = topicHex(deriveLiveTopic({ eventId: 'concert', epoch: 1, descriptorDigest: 'd'.repeat(64), protocolMajor: 1 }))
  t.not(base, topicHex(deriveLiveTopic({ eventId: 'concert', epoch: 2, descriptorDigest: 'd'.repeat(64), protocolMajor: 1 })))
  t.not(base, topicHex(deriveLiveTopic({ eventId: 'concert', epoch: 1, descriptorDigest: 'e'.repeat(64), protocolMajor: 1 })))
  const described = describeScopedTopic('live', { eventId: 'concert', epoch: 1, descriptorDigest: 'd'.repeat(64), protocolMajor: 1 })
  t.is(described.role, 'live')
  t.ok(described.topicHex)
  t.absent(described.descriptorDigest)
})
