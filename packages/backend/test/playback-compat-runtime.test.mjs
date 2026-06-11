import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCompatPlaybackUrl } from '../src/transcode/playback-compat-runtime.mjs'

const DIRECT = 'http://127.0.0.1:9000/blobs/abc/0?byteOffset=0&byteLength=10'

function mockTranscoder(overrides = {}) {
  const calls = { start: [], hls: [], status: [] }
  return {
    calls,
    async startCompatTranscode(url, opts) {
      calls.start.push({ url, opts })
      return overrides.startResult ?? { success: true, sessionId: 'sess1', mode: 'audio-only' }
    },
    getCastStatus(sessionId) {
      calls.status.push(sessionId)
      return overrides.status ?? { status: 'transcoding', fragmentCount: 1 }
    },
    getCastHlsUrl(sessionId, host) {
      calls.hls.push({ sessionId, host })
      return overrides.hlsUrl ?? `http://${host}:9000/cast/${sessionId}/master.m3u8`
    },
    ...overrides.methods,
  }
}

test('non-compat player passes through with no transcoder calls', async () => {
  for (const player of ['webkit', 'exoplayer', undefined]) {
    const t = mockTranscoder()
    const r = await resolveCompatPlaybackUrl({ player, directUrl: DIRECT, castTranscoder: t })
    assert.equal(r.transcoded, false)
    assert.equal(r.url, DIRECT)
    assert.equal(t.calls.start.length, 0)
  }
})

test('avplayer without a transcoder passes through', async () => {
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: DIRECT, castTranscoder: null })
  assert.equal(r.transcoded, false)
  assert.equal(r.url, DIRECT)
})

test('avplayer + compatible source (no-transcode-needed) plays directly', async () => {
  const t = mockTranscoder({ startResult: { success: false, reason: 'no-transcode-needed', sessionId: 's' } })
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: DIRECT, castTranscoder: t })
  assert.equal(r.transcoded, false)
  assert.equal(r.url, DIRECT)
  assert.equal(t.calls.hls.length, 0)
})

test('avplayer + incompatible source returns local HLS url', async () => {
  const t = mockTranscoder()
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: DIRECT, sourceKey: 'k1', castTranscoder: t, readyTimeoutMs: 1000 })
  assert.equal(r.transcoded, true)
  assert.equal(r.mode, 'audio-only')
  assert.equal(r.url, 'http://127.0.0.1:9000/cast/sess1/master.m3u8')
  assert.equal(t.calls.start[0].opts.player, 'avplayer')
  assert.equal(t.calls.start[0].opts.sourceKey, 'k1')
  assert.deepEqual(t.calls.hls[0], { sessionId: 'sess1', host: '127.0.0.1' })
})

test('reused session skips the fragment wait', async () => {
  const t = mockTranscoder({ startResult: { success: true, sessionId: 'reuse', mode: 'remux', reused: true } })
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: DIRECT, castTranscoder: t })
  assert.equal(r.transcoded, true)
  assert.equal(t.calls.status.length, 0)
})

test('startCompatTranscode throwing falls back to direct url', async () => {
  const t = mockTranscoder()
  t.startCompatTranscode = async () => { throw new Error('ffmpeg unavailable') }
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: DIRECT, castTranscoder: t })
  assert.equal(r.transcoded, false)
  assert.equal(r.url, DIRECT)
})

test('transcode error status still yields the HLS url (best-effort)', async () => {
  const t = mockTranscoder({ status: { status: 'error' } })
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: DIRECT, castTranscoder: t, readyTimeoutMs: 500 })
  assert.equal(r.transcoded, true)
  assert.equal(r.url, 'http://127.0.0.1:9000/cast/sess1/master.m3u8')
})

test('missing getCastHlsUrl falls back to direct', async () => {
  const t = mockTranscoder()
  delete t.getCastHlsUrl
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: DIRECT, castTranscoder: t })
  assert.equal(r.transcoded, false)
  assert.equal(r.url, DIRECT)
})

test('null directUrl passes through', async () => {
  const t = mockTranscoder()
  const r = await resolveCompatPlaybackUrl({ player: 'avplayer', directUrl: null, castTranscoder: t })
  assert.equal(r.url, null)
  assert.equal(t.calls.start.length, 0)
})
