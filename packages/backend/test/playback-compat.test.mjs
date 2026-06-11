import assert from 'node:assert/strict'
import test from 'node:test'

import { decidePlayback, osPlayerCanHandle, PLAYER_POLICIES } from '../src/transcode/playback-compat.mjs'

// ─── AVPlayer (iOS + macOS-native) ──────────────────────────────────────────

test('avplayer: plain MP4/H.264/AAC plays directly', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264', audioCodec: 'aac' })
  assert.equal(d.mode, 'direct')
  assert.equal(d.needsRemux, false)
})

test('avplayer: HEVC/AAC in MP4 plays directly', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' })
  assert.equal(d.mode, 'direct')
})

test('avplayer: MKV container with supported codecs needs remux', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' })
  assert.equal(d.mode, 'remux')
  assert.equal(d.needsRemux, true)
})

test('avplayer: AC-3 audio needs audio-only transcode (video copied)', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'mp4', videoCodec: 'h264', audioCodec: 'ac3' })
  assert.equal(d.mode, 'audio-only')
  assert.equal(d.needsAudioTranscode, true)
  assert.equal(d.needsVideoTranscode, false)
})

test('avplayer: Opus audio needs audio-only transcode', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'mp4', videoCodec: 'h264', audioCodec: 'opus' })
  assert.equal(d.mode, 'audio-only')
})

test('avplayer: VP9 video needs full transcode', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' })
  assert.equal(d.mode, 'full')
  assert.equal(d.needsVideoTranscode, true)
})

test('avplayer: MKV + AC-3 collapses to audio-only (transcode subsumes remux)', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'matroska', videoCodec: 'h264', audioCodec: 'ac3' })
  assert.equal(d.mode, 'audio-only')
  assert.equal(d.needsRemux, false)
})

test('avplayer: 10-bit H.264 needs full transcode', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoProfile: 'High 10' })
  assert.equal(d.mode, 'full')
})

// ─── ExoPlayer (Android) — codec-complete ───────────────────────────────────

test('exoplayer: MKV/VP9/Opus plays directly (no compat layer)', () => {
  const d = decidePlayback({ player: 'exoplayer', container: 'matroska,webm', videoCodec: 'vp9', audioCodec: 'opus' })
  assert.equal(d.mode, 'direct')
})

test('exoplayer: AC-3 plays directly', () => {
  const d = decidePlayback({ player: 'exoplayer', container: 'matroska', videoCodec: 'h264', audioCodec: 'ac3' })
  assert.equal(d.mode, 'direct')
})

test('exoplayer: DTS audio still needs transcode', () => {
  const d = decidePlayback({ player: 'exoplayer', container: 'mp4', videoCodec: 'h264', audioCodec: 'dts' })
  assert.equal(d.mode, 'audio-only')
})

// ─── WKWebView / Chromium (Electrobun) — faithful to checkWebTranscodeNeeded ──

test('webkit: Opus/Vorbis/FLAC audio plays directly', () => {
  for (const audioCodec of ['opus', 'vorbis', 'flac', 'mp3', 'aac']) {
    const d = decidePlayback({ player: 'webkit', container: 'mp4', videoCodec: 'h264', audioCodec })
    assert.equal(d.mode, 'direct', `expected direct for ${audioCodec}`)
  }
})

test('webkit: AC-3 / E-AC-3 / DTS need audio transcode', () => {
  for (const audioCodec of ['ac3', 'eac3', 'dts']) {
    const d = decidePlayback({ player: 'webkit', container: 'mp4', videoCodec: 'h264', audioCodec })
    assert.equal(d.mode, 'audio-only', `expected audio-only for ${audioCodec}`)
  }
})

test('webkit: MKV needs remux', () => {
  const d = decidePlayback({ player: 'webkit', container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' })
  assert.equal(d.mode, 'remux')
})

// ─── Chromecast — faithful to checkTranscodeNeeded (AAC-only) ────────────────

test('chromecast: Opus needs audio transcode (cast supports AAC only)', () => {
  const d = decidePlayback({ player: 'chromecast', container: 'mp4', videoCodec: 'h264', audioCodec: 'opus' })
  assert.equal(d.mode, 'audio-only')
})

test('chromecast: H.264 level above cap needs full transcode', () => {
  const d = decidePlayback({ player: 'chromecast', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoLevel: 5.1 })
  assert.equal(d.mode, 'full')
})

// ─── Normalization + edge cases ─────────────────────────────────────────────

test('codec aliases normalize (avc1→h264, h265→hevc, ec-3→eac3)', () => {
  assert.equal(decidePlayback({ player: 'avplayer', container: 'mp4', videoCodec: 'avc1', audioCodec: 'aac' }).mode, 'direct')
  assert.equal(decidePlayback({ player: 'avplayer', container: 'mp4', videoCodec: 'h265', audioCodec: 'aac' }).mode, 'direct')
  assert.equal(decidePlayback({ player: 'webkit', container: 'mp4', videoCodec: 'h264', audioCodec: 'ec-3' }).mode, 'audio-only')
})

test('unknown player → passthrough direct', () => {
  const d = decidePlayback({ player: 'roku', container: 'mp4', videoCodec: 'h264', audioCodec: 'ac3' })
  assert.equal(d.mode, 'direct')
})

test('missing codec info → direct', () => {
  const d = decidePlayback({ player: 'avplayer', container: 'mp4' })
  assert.equal(d.mode, 'direct')
})

test('unknown container does not force remux', () => {
  const d = decidePlayback({ player: 'avplayer', container: null, videoCodec: 'h264', audioCodec: 'aac' })
  assert.equal(d.needsRemux, false)
})

test('osPlayerCanHandle mirrors decidePlayback direct mode', () => {
  assert.equal(osPlayerCanHandle({ player: 'avplayer', container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' }), true)
  assert.equal(osPlayerCanHandle({ player: 'avplayer', container: 'mkv', videoCodec: 'h264', audioCodec: 'dts' }), false)
})

test('every policy exposes the expected shape', () => {
  for (const [name, p] of Object.entries(PLAYER_POLICIES)) {
    assert.ok(p.video instanceof Set, `${name}.video`)
    assert.ok(p.audio instanceof Set, `${name}.audio`)
    assert.ok(Array.isArray(p.remuxContainerPatterns), `${name}.remuxContainerPatterns`)
  }
})
