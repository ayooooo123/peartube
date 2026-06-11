import test from 'brittle'

import {
  probeMp4Buffer,
  probeMp4File,
  probeMp4PlaybackProfile,
  isMp4MimeType,
} from '../src/mp4-playback-probe.js'

function box(type, ...payloads) {
  const content = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + content.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, content])
}

function fullBoxPayload(version, ...payloads) {
  const head = Buffer.alloc(4)
  head.writeUInt8(version, 0)
  return Buffer.concat([head, ...payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))])
}

function u32 (...values) {
  const buf = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => buf.writeUInt32BE(v, i * 4))
  return buf
}

function buildVideoTrak({
  timescale = 1000,
  duration = 6000,
  // stts entries: [sampleCount, sampleDelta]
  stts = [[6, 1000]],
  // 1-based sync sample numbers; null = omit stss (all samples are sync)
  syncSamples = [1, 4],
  uniformSampleSize = 100,
  // stsc entries: [firstChunk, samplesPerChunk]
  sampleToChunk = [[1, 3]],
  chunkOffsets = [1000, 1300],
} = {}) {
  const mdhd = box('mdhd', fullBoxPayload(0, u32(0, 0, timescale, duration), Buffer.alloc(4)))
  const hdlr = box('hdlr', fullBoxPayload(0, u32(0), Buffer.from('vide'), Buffer.alloc(12)))

  const sampleCount = stts.reduce((sum, [count]) => sum + count, 0)
  const sttsBox = box('stts', fullBoxPayload(0, u32(stts.length, ...stts.flat())))
  const stszBox = box('stsz', fullBoxPayload(0, u32(uniformSampleSize, sampleCount)))
  const stscBox = box('stsc', fullBoxPayload(0, u32(sampleToChunk.length, ...sampleToChunk.flatMap(([first, per]) => [first, per, 1]))))
  const stcoBox = box('stco', fullBoxPayload(0, u32(chunkOffsets.length, ...chunkOffsets)))
  const stblChildren = [sttsBox, stscBox, stszBox, stcoBox]
  if (syncSamples) {
    stblChildren.push(box('stss', fullBoxPayload(0, u32(syncSamples.length, ...syncSamples))))
  }

  const stbl = box('stbl', ...stblChildren)
  const minf = box('minf', stbl)
  const mdia = box('mdia', mdhd, hdlr, minf)
  return box('trak', mdia)
}

function buildMp4({ moovFirst = true, trak = buildVideoTrak(), extraMoovChildren = [], mdatBytes = 2048 } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2'))
  const moov = box('moov', trak, ...extraMoovChildren)
  const mdat = box('mdat', Buffer.alloc(mdatBytes))
  return moovFirst
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov])
}

test('probeMp4Buffer extracts moov position and keyframe index from a front-moov file', async (t) => {
  const file = buildMp4({ moovFirst: true })
  const profile = await probeMp4Buffer(file)

  t.ok(profile, 'profile parsed')
  t.is(profile.moovPosition, 'front')
  t.is(profile.container, 'mp4')
  t.is(profile.fragmented, false)
  t.is(profile.timescale, 1000)
  t.is(profile.durationMs, 6000)
  // Sync samples 1 and 4: sample 1 starts chunk 1 (offset 1000) at t=0;
  // sample 4 starts chunk 2 (offset 1300) at t=3000ms.
  t.alike(profile.keyframeTimesMs, [0, 3000])
  t.alike(profile.keyframeOffsets, [1000, 1300])
  // Largest gap: between the keyframes (3000ms) and from last keyframe to
  // duration (6000-3000=3000ms).
  t.is(profile.maxGopMs, 3000)
})

test('probeMp4Buffer flags back-moov files', async (t) => {
  const file = buildMp4({ moovFirst: false })
  const profile = await probeMp4Buffer(file)

  t.ok(profile, 'profile parsed')
  t.is(profile.moovPosition, 'back')
  t.ok(profile.moovStart > 0, 'moov sits after media data')
  t.is(profile.moovEnd - profile.moovStart > 0, true)
  t.alike(profile.keyframeOffsets, [1000, 1300], 'keyframe index still extracted')
})

test('probeMp4Buffer treats every sample as a keyframe when stss is absent', async (t) => {
  const file = buildMp4({ trak: buildVideoTrak({ syncSamples: null }) })
  const profile = await probeMp4Buffer(file)

  t.ok(profile, 'profile parsed')
  t.is(profile.keyframeOffsets.length, 6, 'all six samples are sync samples')
  t.alike(profile.keyframeTimesMs.slice(0, 3), [0, 1000, 2000])
  // Samples are 100 bytes, chunks of 3 at offsets 1000 and 1300.
  t.alike(profile.keyframeOffsets, [1000, 1100, 1200, 1300, 1400, 1500])
})

test('probeMp4Buffer keyframe offsets respect per-sample sizes within a chunk', async (t) => {
  // Non-uniform stsz: sizes 10..60 across two 3-sample chunks at 1000/2000.
  const sizes = [10, 20, 30, 40, 50, 60]
  const mdhd = box('mdhd', fullBoxPayload(0, u32(0, 0, 1000, 6000), Buffer.alloc(4)))
  const hdlr = box('hdlr', fullBoxPayload(0, u32(0), Buffer.from('vide'), Buffer.alloc(12)))
  const stts = box('stts', fullBoxPayload(0, u32(1, 6, 1000)))
  const stsc = box('stsc', fullBoxPayload(0, u32(1, 1, 3, 1)))
  const stsz = box('stsz', fullBoxPayload(0, u32(0, sizes.length, ...sizes)))
  const stco = box('stco', fullBoxPayload(0, u32(2, 1000, 2000)))
  const stss = box('stss', fullBoxPayload(0, u32(2, 2, 5)))
  const stbl = box('stbl', stts, stsc, stsz, stco, stss)
  const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', stbl)))

  const profile = await probeMp4Buffer(buildMp4({ trak }))

  t.ok(profile, 'profile parsed')
  // Sample 2 is 10 bytes into chunk 1 (after sample 1); sample 5 is 40 bytes
  // into chunk 2 (after sample 4).
  t.alike(profile.keyframeOffsets, [1000 + 10, 2000 + 40])
  t.alike(profile.keyframeTimesMs, [1000, 4000])
})

test('probeMp4Buffer marks fragmented MP4s via mvex', async (t) => {
  const mvex = box('mvex', box('trex', fullBoxPayload(0, u32(1, 1, 1, 0, 0))))
  const file = buildMp4({ extraMoovChildren: [mvex] })
  const profile = await probeMp4Buffer(file)

  t.ok(profile, 'profile parsed')
  t.is(profile.fragmented, true)
})

test('probeMp4Buffer rejects non-MP4 and truncated input without throwing', async (t) => {
  t.is(await probeMp4Buffer(Buffer.from('not an mp4 file at all, just text')), null)
  t.is(await probeMp4Buffer(Buffer.alloc(4)), null)
  t.is(await probeMp4Buffer(buildMp4().subarray(0, 20)), null, 'truncated mid-box')
  // EBML header (WebM) — wrong container.
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)])
  t.is(await probeMp4Buffer(webm), null)
})

test('probeMp4PlaybackProfile survives a moov larger than the inspection cap', async (t) => {
  const file = buildMp4()
  const readAt = async (offset, length) => file.subarray(offset, Math.min(file.length, offset + length))
  const profile = await probeMp4PlaybackProfile(readAt, file.length, { maxMoovBytes: 16 })

  t.ok(profile, 'position-only profile still returned')
  t.is(profile.moovPosition, 'front')
  t.alike(profile.keyframeOffsets, [], 'index skipped when moov exceeds cap')
})

test('probeMp4PlaybackProfile downsamples oversized keyframe tables', async (t) => {
  // 1000 samples, all keyframes (no stss), capped to 100 entries.
  const file = buildMp4({
    trak: buildVideoTrak({
      stts: [[1000, 30]],
      syncSamples: null,
      sampleToChunk: [[1, 1000]],
      chunkOffsets: [1000],
      duration: 30000,
    }),
  })
  const readAt = async (offset, length) => file.subarray(offset, Math.min(file.length, offset + length))
  const profile = await probeMp4PlaybackProfile(readAt, file.length, { maxKeyframeEntries: 100 })

  t.ok(profile, 'profile parsed')
  t.ok(profile.keyframeOffsets.length <= 100, 'entries capped')
  t.is(profile.keyframeOffsets[0], 1000, 'first keyframe always kept')
})

test('probeMp4File reads through an injected fs module', async (t) => {
  const file = buildMp4({ moovFirst: false })
  const fakeFs = {
    statSync: () => ({ size: file.length }),
    openSync: () => 42,
    readSync: (fd, buf, bufOffset, length, position) => {
      const slice = file.subarray(position, Math.min(file.length, position + length))
      slice.copy(buf, bufOffset)
      return slice.length
    },
    closeSync: () => {},
  }

  const profile = await probeMp4File(fakeFs, '/fake/video.mp4')
  t.ok(profile, 'profile parsed via fs reads')
  t.is(profile.moovPosition, 'back')
  t.alike(profile.keyframeOffsets, [1000, 1300])
})

test('isMp4MimeType matches the mp4 family only', (t) => {
  t.ok(isMp4MimeType('video/mp4'))
  t.ok(isMp4MimeType('video/quicktime'))
  t.ok(isMp4MimeType('VIDEO/MP4'))
  t.absent(isMp4MimeType('video/webm'))
  t.absent(isMp4MimeType('video/x-matroska'))
  t.absent(isMp4MimeType(null))
})
