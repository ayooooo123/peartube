import test from 'brittle'

import {
  createEntityReference,
  normalizeExternalIdentifier,
} from '../src/media-graph/index.js'

const CASES = [
  ['youtube-video', 'dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=test'],
  ['youtube-video', 'dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=43'],
  ['youtube-video', 'dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ'],
  ['youtube-channel', 'UC_x5XG1OV2P6uZZ5FSM9Ttw', 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw'],
  ['twitch-vod', '123456789', 'https://www.twitch.tv/videos/123456789?t=1h2m'],
  ['twitch-vod', '123456789', 'v123456789'],
  ['twitch-clip', 'FunPoisedGiraffe-GingerPower_1', 'https://clips.twitch.tv/FunPoisedGiraffe-GingerPower_1'],
  ['twitch-clip', 'FunPoisedGiraffe-GingerPower_1', 'https://www.twitch.tv/example/clip/FunPoisedGiraffe-GingerPower_1'],
  ['twitch-channel', 'example_streamer', 'https://www.twitch.tv/Example_Streamer'],
  ['chaturbate-room', 'example_model', 'https://chaturbate.com/Example_Model/'],
  ['vimeo-video', '871050379', 'https://player.vimeo.com/video/871050379?h=private-hash'],
  ['dailymotion-video', 'x7tgad0', 'https://www.dailymotion.com/video/x7tgad0_title-slug'],
  ['kick-channel', 'example-streamer', 'https://kick.com/Example-Streamer'],
]

test('proprietary platform URLs and raw IDs normalize to stable provider-scoped identifiers', (t) => {
  for (const [namespace, expected, input] of CASES) {
    t.is(normalizeExternalIdentifier(namespace, input), expected, `${namespace} normalizes ${input}`)
    const fromUrl = createEntityReference({ entityKind: 'work', namespace, normalizedIdentifier: input })
    const fromId = createEntityReference({ entityKind: 'work', namespace, normalizedIdentifier: expected })
    t.is(fromUrl.entityId, fromId.entityId, `${namespace} URL and raw ID derive one entity`)
  }
})

test('provider and media-kind namespaces remain domain separated', (t) => {
  const twitchVod = createEntityReference({ entityKind: 'work', namespace: 'twitch-vod', normalizedIdentifier: '123456789' })
  const vimeoVideo = createEntityReference({ entityKind: 'work', namespace: 'vimeo-video', normalizedIdentifier: '123456789' })
  const twitchChannel = createEntityReference({ entityKind: 'agent', namespace: 'twitch-channel', normalizedIdentifier: '123456789' })
  t.unlike(twitchVod.entityId, vimeoVideo.entityId)
  t.unlike(twitchVod.entityId, twitchChannel.entityId)
})

test('external identifier parsing rejects host spoofing, ambiguous URLs, and malformed IDs', (t) => {
  const rejected = [
    ['youtube-video', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
    ['youtube-video', 'https://youtube.com/watch?v=short'],
    ['youtube-video', 'https://youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa'],
    ['youtube-channel', 'https://www.youtube.com/@mutable-handle'],
    ['twitch-vod', 'https://twitch.tv/example'],
    ['twitch-clip', 'https://clips.twitch.tv/'],
    ['chaturbate-room', 'https://chaturbate.com/example_model/extra'],
    ['vimeo-video', 'https://vimeo.com/not-numeric'],
    ['dailymotion-video', 'https://example.com/video/x7tgad0'],
    ['kick-channel', 'https://kick.com/example/extra'],
  ]
  for (const [namespace, value] of rejected) {
    t.exception(() => normalizeExternalIdentifier(namespace, value), `${namespace} rejects ${value}`)
  }
})

test('unknown namespaces preserve the existing bounded opaque identifier contract', (t) => {
  t.is(normalizeExternalIdentifier('publisher-defined', '  Local:Episode:1  '), null)
  const ref = createEntityReference({ entityKind: 'work', namespace: 'publisher-defined', normalizedIdentifier: '  Local:Episode:1  ' })
  t.is(ref.normalizedIdentifier, 'Local:Episode:1')
})
