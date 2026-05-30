import test from 'brittle'

import { classifySourceUrl } from '../src/archive/source-id.js'
import { resolveRelayConfig } from '../src/config.js'

test('classifySourceUrl accepts Rumble channel, playlist, and video URLs for yt-dlp archive sources', (t) => {
  t.alike(classifySourceUrl('https://rumble.com/c/nickjfuentes'), {
    type: 'youtube',
    normalizedUrl: 'https://rumble.com/c/nickjfuentes',
    identifier: 'rumble:channel:nickjfuentes',
    kind: 'rumble-channel'
  })

  t.alike(classifySourceUrl('https://rumble.com/playlists/DzT-YRhtho4'), {
    type: 'youtube',
    normalizedUrl: 'https://rumble.com/playlists/DzT-YRhtho4',
    identifier: 'rumble:playlist:DzT-YRhtho4',
    kind: 'rumble-playlist'
  })

  t.alike(classifySourceUrl('https://rumble.com/v7ah96i-america-first-ep.-1690.html'), {
    type: 'youtube',
    normalizedUrl: 'https://rumble.com/v7ah96i-america-first-ep.-1690.html',
    identifier: 'rumble:video:v7ah96i-america-first-ep.-1690',
    kind: 'rumble-video'
  })
})

test('resolveRelayConfig accepts Rumble video archive sources', (t) => {
  const config = resolveRelayConfig({
    archive: {
      enabled: true,
      sources: [
        { url: 'https://rumble.com/v7ah96i-america-first-ep.-1690.html', maxItems: 1 }
      ]
    }
  }, { env: {} })

  t.is(config.archive.sources.length, 1)
  t.is(config.archive.sources[0].sourceId, 'youtube:rumble:video:v7ah96i-america-first-ep.-1690')
  t.is(config.archive.sources[0].kind, 'rumble-video')
})
