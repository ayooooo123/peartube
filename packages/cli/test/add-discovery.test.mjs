import test from 'brittle'
import {
  assertNoRuntimeFields,
  buildCreatorChannelDraft,
  buildCreatorItemDraft,
  buildEpisodeItemDraft,
  buildShowChannelDraft,
  deriveContentIdentityKey,
  normalizeIdentityUrl
} from '../src/add/content-model.js'
import {
  createDiscoverySession,
  discoveryIdentity,
  mergeDiscovery,
  resolveCreatorAttachment
} from '../src/add/discovery.js'
import { createCreatorMemory } from '../src/add/creator-memory.js'

function fakeBee () {
  const map = new Map()
  return {
    map,
    async put (key, value) { map.set(key, value) },
    async del (key) { map.delete(key) },
    async * createReadStream ({ gte, lt } = {}) {
      for (const key of [...map.keys()].sort()) {
        if (gte !== undefined && key < gte) continue
        if (lt !== undefined && key >= lt) continue
        yield { key, value: map.get(key) }
      }
    }
  }
}

test('identityUrl normalizer canonicalizes scheme, host, ports, and tracking params', (t) => {
  t.is(
    normalizeIdentityUrl('HTTPS://WWW.YouTube.com:443/watch?v=abc&utm_source=x&si=track#frag'),
    'https://youtube.com/watch?v=abc'
  )
  t.is(normalizeIdentityUrl('http://example.com:80/path/'), 'http://example.com/path/')
  t.is(normalizeIdentityUrl('not a url'), null)
  t.is(normalizeIdentityUrl('ftp://example.com'), null)
})

test('identity key prefers stable source id then hashed normalized url', (t) => {
  t.is(deriveContentIdentityKey({ provider: 'youtube', sourceId: 'UC123' }), 'id:UC123')
  const a = deriveContentIdentityKey({ provider: 'youtube', identityUrl: 'https://youtube.com/@x?utm_source=1' })
  const b = deriveContentIdentityKey({ provider: 'youtube', identityUrl: 'https://www.youtube.com/@x' })
  t.is(a, b, 'tracking params do not change the identity key')
  t.ok(a.startsWith('url:sha256:'))
})

test('draft builders produce validated shapes and never leak fetchUrl', (t) => {
  const show = buildShowChannelDraft({ name: 'Breaking Bad', mediaId: 1396, provider: 'tmdb', artwork: [{ role: 'poster', url: 'x', path: '/p' }] })
  t.is(show.kind, 'channel')
  t.is(show.profileKind, 'tvShow')
  t.alike(show.channelTarget, { mode: 'new' })
  t.is(show.artwork[0].role, 'poster')

  const episode = buildEpisodeItemDraft(
    { title: 'Pilot', seasonNumber: 1, episodeNumber: 1, airDate: '2008-01-20' },
    { provider: 'youtube', sourceVideoId: 'v1', identityUrl: 'https://youtube.com/watch?v=v1&si=x', displayUrl: 'https://youtube.com/watch?v=v1', fetchUrl: 'https://secret/v1' }
  )
  t.is(episode.kind, 'item')
  t.is(episode.contentKind, 'episode')
  t.is(episode.seasonNumber, 1)
  t.is(episode.identityUrl, 'https://youtube.com/watch?v=v1')
  t.is(episode.displayUrl, 'https://youtube.com/watch?v=v1')
  t.absent('fetchUrl' in episode)
  t.ok(assertNoRuntimeFields(episode))

  const creator = buildCreatorChannelDraft(
    { name: 'Maker', platform: 'youtube', sourceId: 'UC123', canonicalUrl: 'https://youtube.com/@maker' },
    { mode: 'existing', channelKey: 'chan-1' }
  )
  t.alike(creator.channelTarget, { mode: 'existing', channelKey: 'chan-1' })
  t.is(creator.sources[0].identityKey, 'id:UC123')

  const item = buildCreatorItemDraft({ title: 'Clip', sourceProvider: 'youtube', sourceVideoId: 'v9', canonicalUrl: 'https://youtube.com/watch?v=v9' })
  t.is(item.identityUrl, 'https://youtube.com/watch?v=v9')
  t.absent('fetchUrl' in item)
})

test('discovery merge dedupes by identity, ranks remembered first, and keeps fallbacks on provider failure', (t) => {
  const remembered = [{ provider: 'youtube', sourceId: 'UC123', name: 'Maker', kind: 'creator' }]
  const providerResults = [
    { provider: 'tmdb', ok: true, items: [{ provider: 'tmdb', mediaId: '1', title: 'Show', kind: 'tv' }] },
    { provider: 'youtube', ok: true, items: [{ provider: 'youtube', sourceId: 'UC123', name: 'Maker Duplicate', kind: 'creator' }] },
    { provider: 'vimeo', ok: false, error: Object.assign(new Error('offline'), { code: 'OFFLINE' }) }
  ]
  const fallbackActions = [{ action: 'paste-url', label: 'Paste URL…' }, { action: 'choose-file', label: 'Choose local file…' }]
  const { candidates, errors } = mergeDiscovery({ remembered, providerResults, fallbackActions })

  t.is(candidates[0].origin, 'remembered', 'remembered creator ranks first')
  t.absent(candidates.some((candidate) => candidate.name === 'Maker Duplicate'), 'duplicate identity is dropped')
  t.ok(candidates.some((candidate) => candidate.title === 'Show'))
  t.is(candidates.filter((candidate) => candidate.origin === 'fallback').length, 2, 'fallback actions always present')
  t.alike(errors, [{ provider: 'vimeo', error: { message: 'offline', code: 'OFFLINE' } }])
})

test('discovery session drops stale responses', (t) => {
  const session = createDiscoverySession()
  const first = session.begin()
  const second = session.begin()
  t.is(session.accept(second, ['fresh'])?.[0], 'fresh')
  t.is(session.accept(first, ['stale']), null)
  t.is(discoveryIdentity({ provider: 'youtube', sourceId: 'UC1' }), 'youtube:id:UC1')
})

test('creator attachment auto-reuses only on identity match and never merges by name', (t) => {
  const existingChannels = [
    { channelKey: 'chan-1', name: 'Maker', profileKind: 'creator', sources: [{ identityKey: 'id:UC123' }] },
    { channelKey: 'chan-2', name: 'Maker', profileKind: 'creator', sources: [{ identityKey: 'id:UC999' }] }
  ]
  const auto = resolveCreatorAttachment({ creator: { identityKey: 'id:UC123' }, existingChannels })
  t.is(auto.auto, true)
  t.alike(auto.channelTarget, { mode: 'existing', channelKey: 'chan-1' })

  const manual = resolveCreatorAttachment({ creator: { identityKey: 'id:UCnew', name: 'Maker' }, existingChannels })
  t.is(manual.auto, false, 'same name never auto-attaches')
  t.is(manual.options[0].mode, 'new')
  t.is(manual.options.length, 3, 'new plus two explicit attach options')
})

test('creator memory persists only safe fields and matches by query', async (t) => {
  const bee = fakeBee()
  const memory = createCreatorMemory({ bee, now: () => 1000 })
  await memory.remember({
    name: 'Maker',
    platform: 'youtube',
    sourceId: 'UC123',
    handle: '@maker',
    canonicalUrl: 'https://youtube.com/@maker?utm_source=x',
    fetchUrl: 'https://secret/feed',
    tmdbApiKey: 'nope'
  })

  const [key] = [...bee.map.keys()]
  t.is(key, 'content-add/v1/creator/youtube/id%3AUC123')
  const stored = JSON.stringify(bee.map.get(key))
  t.absent(stored.includes('secret'))
  t.absent(stored.includes('nope'))
  t.ok(stored.includes('@maker'))

  const listed = await memory.list()
  t.is(listed.length, 1)
  t.is(listed[0].identityUrl, 'https://youtube.com/@maker')
  t.is((await memory.match('maker')).length, 1)
  t.is((await memory.match('zzz')).length, 0)
})
