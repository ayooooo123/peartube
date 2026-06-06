import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = () => readFileSync(join(__dirname, '../../core/src/hooks/useP2PVideo.ts'), 'utf8')

test('shared P2P video hook uses canonical playback request with direct blob refs', () => {
  const src = source()
  assert.match(src, /export interface PlaybackRequest/)
  for (const field of ['channelKey', 'videoId', 'publicBeeKey', 'blobId', 'blobsCoreKey', 'mimeType']) {
    assert.match(src, new RegExp(`${field}[?]?:`), `PlaybackRequest should include ${field}`)
  }
  assert.match(src, /const playbackRequest: PlaybackRequest = \{[\s\S]*blobId: options\.blobId \|\| undefined,[\s\S]*blobsCoreKey: options\.blobsCoreKey \|\| undefined,[\s\S]*mimeType: options\.mimeType \|\| undefined,[\s\S]*\}/)
  assert.match(src, /callPlaybackService<\{ url: string; stats\?: VideoStats \| null \}>\(service\.preparePlayback, playbackRequest\)/)
  assert.match(src, /callPlaybackService<\{ url: string \}>\(service\.getVideoUrl, playbackRequest\)/)
  assert.match(src, /callPlaybackService<\{ success: boolean \}>\(service\.prefetchVideo, playbackRequest\)/)
  assert.match(src, /callPlaybackService<VideoStats>\(service\.getVideoStats, playbackRequest\)/)
  assert.match(src, /hasCanonicalPlaybackFields/, 'canonical fields should force object-form service calls')
  assert.doesNotMatch(src, /if \(fn\.length >= 2\) return fn\(request\.channelKey, request\.videoId\)/, 'legacy arity fallback must not drop canonical playback fields')
})
