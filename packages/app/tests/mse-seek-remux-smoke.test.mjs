/**
 * Validates the on-demand seek-remux approach used by WebMseVideoBackend.web.tsx
 * against the installed mediabunny version:
 *
 * - random access into a media file via EncodedPacketSink.getKeyPacket
 * - restarting a remux pipeline mid-file (the seek path)
 * - fMP4 fragments carrying ABSOLUTE timestamps, so they land at the correct
 *   position on an MSE timeline without timestampOffset bookkeeping
 * - audio/video packet interleaving through separate packet sources
 *
 * Skips when mediabunny is not installed (source-pattern tests still run).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

let mb = null
try {
  mb = await import('mediabunny')
} catch {
  // node_modules not installed in this environment
}

const FPS = 30
const GOP = 30
const SECONDS = 10

function makeAvcPacketData(key) {
  const nal = new Uint8Array([key ? 0x65 : 0x41, 0x88, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00])
  const data = new Uint8Array(4 + nal.length)
  new DataView(data.buffer).setUint32(0, nal.length)
  data.set(nal, 4)
  return data
}

function makeVideoDecoderConfig() {
  const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0x84, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58])
  const pps = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0])
  const avcC = new Uint8Array([
    1, 0x64, 0x00, 0x28, 0xff, 0xe1,
    (sps.length >> 8) & 0xff, sps.length & 0xff, ...sps,
    1,
    (pps.length >> 8) & 0xff, pps.length & 0xff, ...pps,
  ])
  return { codec: 'avc1.640028', codedWidth: 640, codedHeight: 360, description: avcC }
}

async function buildSourceFile({ withAudio = false } = {}) {
  const { Output, BufferTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket } = mb
  const target = new BufferTarget()
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'fragmented' }) })
  const videoSource = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(videoSource)
  let audioSource = null
  if (withAudio) {
    audioSource = new EncodedAudioPacketSource('aac')
    output.addAudioTrack(audioSource)
  }
  await output.start()

  const audioDecoderConfig = {
    codec: 'mp4a.40.2',
    numberOfChannels: 2,
    sampleRate: 48000,
    description: new Uint8Array([0x11, 0x90]),
  }
  const audioFrameDuration = 1024 / 48000
  let audioTime = 0
  for (let i = 0; i < FPS * SECONDS; i++) {
    const key = i % GOP === 0
    const packet = new EncodedPacket(makeAvcPacketData(key), key ? 'key' : 'delta', i / FPS, 1 / FPS)
    await videoSource.add(packet, i === 0 ? { decoderConfig: makeVideoDecoderConfig() } : undefined)
    if (audioSource) {
      let firstAudio = audioTime === 0
      while (audioTime <= (i + 1) / FPS) {
        const aPacket = new EncodedPacket(new Uint8Array([0x21, 0x10, 0x05, 0x00]), 'key', audioTime, audioFrameDuration)
        await audioSource.add(aPacket, firstAudio ? { decoderConfig: audioDecoderConfig } : undefined)
        firstAudio = false
        audioTime += audioFrameDuration
      }
    }
  }
  await output.finalize()
  return target.buffer
}

test('seek-remux: keyframe lookup + mid-file remux emits fragments at absolute timestamps', { skip: !mb && 'mediabunny not installed' }, async () => {
  const { Input, Output, BufferSource, Mp4OutputFormat, NullTarget, EncodedPacketSink, EncodedVideoPacketSource, ALL_FORMATS } = mb
  const fileBuffer = await buildSourceFile()

  const input = new Input({ source: new BufferSource(fileBuffer), formats: ALL_FORMATS })
  const duration = await input.computeDuration()
  assert.ok(Math.abs(duration - SECONDS) < 0.5, `full duration known up front (got ${duration})`)

  const track = await input.getPrimaryVideoTrack()
  const sink = new EncodedPacketSink(track)

  const startPacket = await sink.getKeyPacket(7.4, { verifyKeyPackets: true })
  assert.equal(startPacket.type, 'key')
  assert.ok(Math.abs(startPacket.timestamp - 7) < 0.01, `keyframe at 7s (got ${startPacket.timestamp})`)

  const moofTimestamps = []
  const output = new Output({
    target: new NullTarget(),
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      onMoof: (_data, _pos, timestamp) => moofTimestamps.push(timestamp),
    }),
  })
  const videoOut = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(videoOut)
  await output.start()

  const decoderConfig = await track.getDecoderConfig()
  let first = true
  let count = 0
  for await (const packet of sink.packets(startPacket, undefined, { verifyKeyPackets: true })) {
    await videoOut.add(packet, first ? { decoderConfig } : undefined)
    first = false
    count++
  }
  await output.finalize()

  assert.equal(count, FPS * (SECONDS - 7), 'remux consumed exactly the packets from the seek keyframe to EOF')
  assert.ok(moofTimestamps.length > 0, 'fragments were emitted')
  assert.ok(Math.abs(moofTimestamps[0] - 7) < 0.05, `first fragment lands at ~7s absolute (got ${moofTimestamps[0]})`)
})

test('seek-remux: canceling an in-flight pipeline and restarting at a new position works', { skip: !mb && 'mediabunny not installed' }, async () => {
  const { Input, Output, BufferSource, Mp4OutputFormat, NullTarget, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, ALL_FORMATS } = mb
  const fileBuffer = await buildSourceFile({ withAudio: true })

  const input = new Input({ source: new BufferSource(fileBuffer), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  const audioTrack = await input.getPrimaryAudioTrack()
  assert.ok(audioTrack, 'audio track found')
  const videoSink = new EncodedPacketSink(videoTrack)
  const audioSink = new EncodedPacketSink(audioTrack)
  const videoDecoderConfig = await videoTrack.getDecoderConfig()
  const audioDecoderConfig = await audioTrack.getDecoderConfig()

  const runPipeline = async (fromTime, { stopAfterFragments = Infinity } = {}) => {
    const moofTimestamps = []
    const output = new Output({
      target: new NullTarget(),
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        onMoof: (_data, _pos, timestamp) => moofTimestamps.push(timestamp),
      }),
    })
    const videoOut = new EncodedVideoPacketSource('avc')
    output.addVideoTrack(videoOut)
    const audioOut = new EncodedAudioPacketSource('aac')
    output.addAudioTrack(audioOut)
    await output.start()

    const startPacket = await videoSink.getKeyPacket(fromTime, { verifyKeyPackets: true })
    const videoIter = videoSink.packets(startPacket, undefined, { verifyKeyPackets: true })
    let nextVideo = await videoIter.next()
    const audioStart = (await audioSink.getPacket(startPacket.timestamp)) ?? (await audioSink.getFirstPacket())
    const audioIter = audioSink.packets(audioStart)
    let nextAudio = await audioIter.next()

    let firstVideo = true
    let firstAudio = true
    while (!nextVideo.done || !nextAudio.done) {
      if (moofTimestamps.length >= stopAfterFragments) {
        await output.cancel()
        return { moofTimestamps, canceled: true }
      }
      // Feed whichever track is furthest behind (same logic as the player)
      if (nextAudio.done || (!nextVideo.done && nextVideo.value.timestamp <= nextAudio.value.timestamp)) {
        await videoOut.add(nextVideo.value, firstVideo ? { decoderConfig: videoDecoderConfig } : undefined)
        firstVideo = false
        nextVideo = await videoIter.next()
      } else {
        await audioOut.add(nextAudio.value, firstAudio ? { decoderConfig: audioDecoderConfig } : undefined)
        firstAudio = false
        nextAudio = await audioIter.next()
      }
    }
    await output.finalize()
    return { moofTimestamps, canceled: false }
  }

  // Play from the start, then "seek": cancel and restart at 6s
  const firstRun = await runPipeline(0, { stopAfterFragments: 2 })
  assert.equal(firstRun.canceled, true)
  assert.ok(Math.abs(firstRun.moofTimestamps[0] - 0) < 0.05, 'initial pipeline starts at 0')

  const secondRun = await runPipeline(6.2)
  assert.equal(secondRun.canceled, false)
  assert.ok(secondRun.moofTimestamps.length > 0, 'post-seek pipeline emits fragments')
  assert.ok(
    Math.abs(secondRun.moofTimestamps[0] - 6) < 0.2,
    `post-seek fragments start at the 6s keyframe (got ${secondRun.moofTimestamps[0]})`
  )
})
