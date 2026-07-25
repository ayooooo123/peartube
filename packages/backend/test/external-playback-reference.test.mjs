import test from 'brittle'

import {
  createExternalPlaybackReference,
  normalizeExternalIdentifier,
} from '../src/media-graph/index.js'

test('official embeds remain provider-hosted while archival requires authorized publisher bytes', (t) => {
  const youtube = createExternalPlaybackReference('youtube-video', 'https://youtu.be/dQw4w9WgXcQ?t=43')
  t.alike(youtube, {
    version: 1,
    namespace: 'youtube-video',
    identifier: 'dQw4w9WgXcQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    playback: {
      mode: 'official-embed',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      requiresParent: false,
    },
    archival: {
      automaticAcquisition: false,
      requiredAuthority: 'rights-holder-or-license',
      p2pIngest: 'publisher-supplied-bytes',
    },
    contentPolicy: 'provider-controlled',
  })
  t.is('downloadUrl' in youtube, false, 'provider streams are never exposed as downloader inputs')

  const vimeo = createExternalPlaybackReference('vimeo-video', '871050379')
  t.is(vimeo.playback.embedUrl, 'https://player.vimeo.com/video/871050379')
  const dailymotion = createExternalPlaybackReference('dailymotion-video', 'x7tgad0')
  t.is(dailymotion.playback.embedUrl, 'https://www.dailymotion.com/embed/video/x7tgad0')
})

test('Twitch embeds require an explicit embedding parent and never become archival URLs', (t) => {
  const unresolved = createExternalPlaybackReference('twitch-vod', 'v123456789')
  t.is(unresolved.canonicalUrl, 'https://www.twitch.tv/videos/123456789')
  t.alike(unresolved.playback, { mode: 'official-embed', embedUrl: null, requiresParent: true })

  const vod = createExternalPlaybackReference('twitch-vod', '123456789', { embedParent: 'watch.example.com' })
  t.is(vod.playback.embedUrl, 'https://player.twitch.tv/?video=v123456789&parent=watch.example.com&autoplay=false')
  const clip = createExternalPlaybackReference('twitch-clip', 'FunPoisedGiraffe-GingerPower_1', { embedParent: 'watch.example.com' })
  t.is(clip.playback.embedUrl, 'https://clips.twitch.tv/embed?clip=FunPoisedGiraffe-GingerPower_1&parent=watch.example.com&autoplay=false')
  const channel = createExternalPlaybackReference('twitch-channel', 'Example_Streamer', { embedParent: 'watch.example.com' })
  t.is(channel.playback.embedUrl, 'https://player.twitch.tv/?channel=example_streamer&parent=watch.example.com&autoplay=false')

  for (const parent of ['https://watch.example.com', 'watch.example.com:443', 'watch.example.com/path', 'watch.example.com&autoplay=true']) {
    t.exception(() => createExternalPlaybackReference('twitch-vod', '123456789', { embedParent: parent }))
  }
})

test('profile-only and adult providers resolve to links without inventing download or embed authority', (t) => {
  t.is(normalizeExternalIdentifier('youtube-channel', 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw'), 'UC_x5XG1OV2P6uZZ5FSM9Ttw')
  const youtube = createExternalPlaybackReference('youtube-channel', 'UC_x5XG1OV2P6uZZ5FSM9Ttw')
  t.is(youtube.canonicalUrl, 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw')
  t.alike(youtube.playback, { mode: 'external-link', embedUrl: null, requiresParent: false })

  const adult = createExternalPlaybackReference('chaturbate-room', 'Example_Model')
  t.is(adult.canonicalUrl, 'https://chaturbate.com/example_model/')
  t.is(adult.contentPolicy, 'adult-age-gated')
  t.alike(adult.playback, { mode: 'external-link', embedUrl: null, requiresParent: false })

  const kick = createExternalPlaybackReference('kick-channel', 'Example-Streamer')
  t.is(kick.canonicalUrl, 'https://kick.com/example-streamer')
  t.is(kick.archival.automaticAcquisition, false)
})

test('external playback references reject unknown namespaces and unsafe parents', (t) => {
  t.exception(() => createExternalPlaybackReference('publisher-defined', 'opaque'))
  t.exception(() => createExternalPlaybackReference('youtube-channel', '@mutable-handle'))
})
