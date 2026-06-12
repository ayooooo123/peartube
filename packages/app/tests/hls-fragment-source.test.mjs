import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveAgainstPlaylist,
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  findSegmentIndexForTime,
  buildCompatMimeCandidates,
} from '../lib/hls-fragment-source.mjs'

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,CODECS="avc1.640029,mp4a.40.2"',
  'playlist.m3u8',
  '',
].join('\n')

const MEDIA_EVENT = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:7',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:EVENT',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:6.006,',
  'seg-0.m4s',
  '#EXTINF:4.171,',
  'seg-1.m4s',
  '#EXTINF:6.500,',
  'seg-2.m4s',
  '',
].join('\n')

const MEDIA_VOD = MEDIA_EVENT.trimEnd() + '\n#EXT-X-ENDLIST\n'

test('isMasterPlaylist distinguishes master from media playlists', () => {
  assert.equal(isMasterPlaylist(MASTER), true)
  assert.equal(isMasterPlaylist(MEDIA_EVENT), false)
  assert.equal(isMasterPlaylist(''), false)
  assert.equal(isMasterPlaylist(null), false)
})

test('parseMasterPlaylist returns the first variant URI', () => {
  assert.equal(parseMasterPlaylist(MASTER), 'playlist.m3u8')
  assert.equal(parseMasterPlaylist(MEDIA_EVENT), null)
})

test('resolveAgainstPlaylist resolves relative segment URIs', () => {
  const base = 'http://127.0.0.1:43521/cast/abc123/master.m3u8'
  assert.equal(
    resolveAgainstPlaylist(base, 'playlist.m3u8'),
    'http://127.0.0.1:43521/cast/abc123/playlist.m3u8'
  )
  assert.equal(
    resolveAgainstPlaylist('http://127.0.0.1:43521/cast/abc123/playlist.m3u8', 'seg-4.m4s'),
    'http://127.0.0.1:43521/cast/abc123/seg-4.m4s'
  )
  assert.equal(resolveAgainstPlaylist(base, null), null)
})

test('parseMediaPlaylist extracts init, segments with absolute starts, live state', () => {
  const parsed = parseMediaPlaylist(MEDIA_EVENT)
  assert.equal(parsed.initUri, 'init.mp4')
  assert.equal(parsed.ended, false)
  assert.equal(parsed.targetDuration, 7)
  assert.equal(parsed.mediaSequence, 0)
  assert.equal(parsed.segments.length, 3)
  assert.deepEqual(parsed.segments[0], { uri: 'seg-0.m4s', duration: 6.006, start: 0 })
  assert.equal(parsed.segments[1].uri, 'seg-1.m4s')
  assert.ok(Math.abs(parsed.segments[1].start - 6.006) < 1e-9)
  assert.ok(Math.abs(parsed.segments[2].start - 10.177) < 1e-9)
})

test('parseMediaPlaylist flags ENDLIST', () => {
  const parsed = parseMediaPlaylist(MEDIA_VOD)
  assert.equal(parsed.ended, true)
  assert.equal(parsed.segments.length, 3)
})

test('parseMediaPlaylist tolerates junk input', () => {
  assert.deepEqual(parseMediaPlaylist(null).segments, [])
  assert.deepEqual(parseMediaPlaylist('#EXTM3U\n').segments, [])
})

test('findSegmentIndexForTime locates the covering segment', () => {
  const { segments } = parseMediaPlaylist(MEDIA_EVENT)
  assert.equal(findSegmentIndexForTime(segments, 0), 0)
  assert.equal(findSegmentIndexForTime(segments, -5), 0)
  assert.equal(findSegmentIndexForTime(segments, 3), 0)
  assert.equal(findSegmentIndexForTime(segments, 6.5), 1)
  assert.equal(findSegmentIndexForTime(segments, 11), 2)
  // Beyond produced playlist → -1 (caller waits for the transcoder)
  assert.equal(findSegmentIndexForTime(segments, 60), -1)
  assert.equal(findSegmentIndexForTime([], 5), -1)
})

test('buildCompatMimeCandidates puts the stream-copied video codec first', () => {
  const candidates = buildCompatMimeCandidates('hev1.2.4.L120.B0')
  assert.equal(candidates[0], 'video/mp4; codecs="hev1.2.4.L120.B0, mp4a.40.2"')
  assert.ok(candidates.includes('video/mp4; codecs="avc1.640029, mp4a.40.2"'))
  assert.equal(candidates.at(-1), 'video/mp4')
  // No probe string available → fall back to the generic candidates only
  assert.equal(buildCompatMimeCandidates(null)[0], 'video/mp4; codecs="avc1.640029, mp4a.40.2"')
})
