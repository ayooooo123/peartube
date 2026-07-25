import test from 'brittle'
import b4a from 'b4a'

import {
  ENTITY_KINDS,
  createEntityReference,
  deriveEntityId,
  deriveNativeEntityId,
  encodeEntityReference,
  decodeEntityReference,
  normalizeEntityReference,
} from '../src/media-graph/index.js'

const issuerRootKey = b4a.alloc(32, 7)

test('entity references are domain separated by kind and namespace versions', (t) => {
  const base = {
    namespace: 'youtube-video',
    namespaceVersion: 1,
    normalizationVersion: 1,
    normalizedIdentifier: 'dQw4w9WgXcQ',
  }
  const work = createEntityReference({ entityKind: 'work', ...base })
  const publication = createEntityReference({ entityKind: 'publication', ...base })
  const v2 = createEntityReference({ entityKind: 'work', ...base, normalizationVersion: 2 })

  t.alike(work.entityKind, 'work')
  t.unlike(work.entityId, publication.entityId, 'same external id under different entity kinds must not collide')
  t.unlike(work.entityId, v2.entityId, 'normalization changes must change identity explicitly')
  t.alike(deriveEntityId(work), work.entityId)
})

test('supported entity kinds cover media, collection, agent, and publisher domains', (t) => {
  t.alike(ENTITY_KINDS, ['work', 'recording', 'edition', 'publication', 'rendition', 'collection', 'agent', 'publisher'])
})

test('known external namespaces normalize deterministically without title-derived identity', (t) => {
  const refs = [
    ['work', 'youtube-video', ' AbC_123-xyZ '],
    ['agent', 'youtube-channel', ' UC_x5XG1OV2P6uZZ5FSM9Ttw '],
    ['recording', 'musicbrainz-recording', '550E8400-E29B-41D4-A716-446655440000'],
    ['edition', 'musicbrainz-release', '550e8400-e29b-41d4-a716-446655440000'],
    ['collection', 'tmdb-tv', ' 1399 '],
    ['work', 'tmdb-episode', '1399:1:2'],
    ['work', 'imdb-title', ' tt0903747 '],
    ['work', 'podcast-guid', ' Episode-GUID-1 '],
    ['work', 'canonical-url', 'HTTPS://Example.COM:443/a/../b/?q=1#frag'],
    ['recording', 'av-fingerprint', 'sha256:ABCDEF0123456789'],
    ['rendition', 'exact-hash', 'sha256:ABCDEF0123456789'],
  ]

  const ids = refs.map(([entityKind, namespace, normalizedIdentifier]) => {
    const ref = createEntityReference({ entityKind, namespace, normalizedIdentifier })
    t.ok(ref.normalizedIdentifier.length > 0, `${namespace} normalized`)
    return ref.entityId
  })
  t.alike(new Set(ids).size, ids.length, 'all examples retain distinct typed identity')
  t.alike(createEntityReference({ entityKind: 'work', namespace: 'canonical-url', normalizedIdentifier: 'HTTPS://Example.COM:443/a/../b/?q=1#frag' }).normalizedIdentifier, 'https://example.com/b/?q=1')
})

test('issuer-native references are issuer scoped and do not collide with external refs', (t) => {
  const native = createEntityReference({
    entityKind: 'work',
    namespace: 'issuer-native',
    issuerRootKey,
    issuerLocalId: 'local-show:s1:e1',
  })
  const sameLocalOtherIssuer = createEntityReference({
    entityKind: 'work',
    namespace: 'issuer-native',
    issuerRootKey: b4a.alloc(32, 8),
    issuerLocalId: 'local-show:s1:e1',
  })
  const external = createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: 'dQw4w9WgXcQ' })

  t.alike(native.entityId, deriveNativeEntityId({ entityKind: 'work', issuerRootKey, issuerLocalId: 'local-show:s1:e1' }))
  t.unlike(native.entityId, sameLocalOtherIssuer.entityId)
  t.unlike(native.entityId, external.entityId)
})

test('entity reference codec round trips canonical bytes', (t) => {
  const ref = createEntityReference({ entityKind: 'work', namespace: 'tmdb-episode', normalizedIdentifier: '1399:1:2' })
  const encoded = encodeEntityReference(ref)
  const decoded = decodeEntityReference(encoded)

  t.alike(decoded, ref)
  t.alike(encodeEntityReference(decoded), encoded)
})

test('invalid and ambiguous references fail closed', (t) => {
  t.exception(() => createEntityReference({ entityKind: 'video', namespace: 'youtube-video', normalizedIdentifier: 'abc' }), /entityKind/)
  t.exception(() => createEntityReference({ entityKind: 'work', namespace: '', normalizedIdentifier: 'abc' }), /namespace/)
  t.exception(() => createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: '' }), /identifier/)
  t.exception(() => createEntityReference({ entityKind: 'work', namespace: 'canonical-url', normalizedIdentifier: 'http://example.com' }), /https/)
  t.exception(() => createEntityReference({ entityKind: 'recording', namespace: 'av-fingerprint', normalizedIdentifier: 'md5:abc' }), /algorithm/)
  t.exception(() => createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: 'a'.repeat(513) }), /identifier/)
  t.exception(() => normalizeEntityReference({ entityKind: 'work', namespace: 'you tube', normalizedIdentifier: 'abc' }), /namespace/)
})
