import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BRIDGE_COMMANDS,
  BRIDGE_EVENTS,
  bootstrapResponseCodec,
  createRPCFrameParser,
  decodeFrame,
  decodePayload,
  encodeEventFrame,
  encodePayload,
  encodeRequestFrame,
  encodeResponseFrame,
  hostReadyEventCodec,
  searchRequestCodec,
  searchResponseCodec,
} from './native-rpc.mjs'

test('bootstrap payload roundtrips through compact encoding', () => {
  const snapshot = {
    generatedAt: 1234.5,
    sections: {
      home: [{
        id: 'channel-a:video-1',
        backendVideoID: 'video-1',
        channelKey: 'channel-a',
        publicBeeKey: 'bee-a',
        title: 'Video 1',
        channelName: 'Channel A',
        durationText: '1:23',
        summary: 'Summary',
        tags: ['home'],
        accentHex: '#FF7A59',
        sections: ['home', 'library'],
        thumbnailURL: 'https://example.com/thumb.jpg',
        path: '/videos/video-1.mp4',
        blobId: '0:128:0:4096',
        blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        mimeType: 'video/mp4',
      }],
      subscriptions: [],
      library: [],
      studio: [],
      diagnostics: [],
    },
    stats: {
      homeCount: 1,
      subscriptionCount: 0,
      libraryCount: 0,
      channelCount: 1,
    },
    state: {
      subscriptionChannelKeys: [],
      identityChannelKeys: [],
      activeIdentityName: null,
      activeIdentityChannelKey: null,
      activeChannelPublished: false,
    },
  }

  const encoded = encodePayload(bootstrapResponseCodec, {
    blobServerPort: 64369,
    protocolVersion: 1,
    storagePath: '/tmp/native',
    snapshot,
  })

  const decoded = decodePayload(bootstrapResponseCodec, encoded)
  assert.equal(decoded.blobServerPort, 64369)
  assert.equal(decoded.protocolVersion, 1)
  assert.equal(decoded.storagePath, '/tmp/native')
  assert.deepEqual(decoded.snapshot.sections.home, snapshot.sections.home)
  assert.deepEqual(decoded.snapshot.stats, snapshot.stats)
  assert.deepEqual(decoded.snapshot.state, snapshot.state)
})

test('rpc frame parser assembles chunked request frames', () => {
  const parser = createRPCFrameParser()
  const request = encodeRequestFrame({
    id: 7,
    command: BRIDGE_COMMANDS.resolvePlayback,
    data: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  })

  assert.equal(parser.push(request.subarray(0, 5)).length, 0)

  const frames = parser.push(request.subarray(5))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].kind, 'request')
  assert.equal(frames[0].id, 7)
  assert.equal(frames[0].command, BRIDGE_COMMANDS.resolvePlayback)
  assert.deepEqual(frames[0].data, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
})

test('event and response frames decode with stable command ids', () => {
  const eventFrame = encodeEventFrame({
    command: BRIDGE_EVENTS.hostReady,
    data: encodePayload(hostReadyEventCodec, { blobServerPort: 59883 }),
  })
  const responseFrame = encodeResponseFrame({
    id: 4,
    data: Buffer.from([1, 2, 3]),
  })

  const eventMessage = decodeFrame(eventFrame)
  const responseMessage = decodeFrame(responseFrame)

  assert.equal(eventMessage.kind, 'event')
  assert.equal(eventMessage.command, BRIDGE_EVENTS.hostReady)
  assert.deepEqual(
    decodePayload(hostReadyEventCodec, eventMessage.data),
    { blobServerPort: 59883 }
  )

  assert.equal(responseMessage.kind, 'response')
  assert.equal(responseMessage.id, 4)
  assert.equal(responseMessage.isError, false)
  assert.deepEqual(responseMessage.data, Buffer.from([1, 2, 3]))
})

test('search payloads roundtrip through compact encoding', () => {
  const request = {
    query: 'drum machine',
    topK: 12,
  }

  const response = {
    query: 'drum machine',
    results: [
      {
        id: 'channel-a:video-1',
        backendVideoID: 'video-1',
        channelKey: 'channel-a',
        publicBeeKey: 'bee-a',
        title: 'Drum Machine Breakdown',
        channelName: 'Channel A',
        durationText: '4:04',
        summary: 'Percussion-heavy synth exploration.',
        tags: ['search', 'music'],
        accentHex: '#FF7A59',
        sections: ['home'],
        thumbnailURL: 'https://example.com/thumb.jpg',
        path: '/videos/video-1.mp4',
        blobId: '0:128:0:4096',
        blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        mimeType: 'video/mp4',
      },
    ],
  }

  assert.equal(BRIDGE_COMMANDS.searchVideos, 5)
  assert.deepEqual(
    decodePayload(searchRequestCodec, encodePayload(searchRequestCodec, request)),
    request
  )
  assert.deepEqual(
    decodePayload(searchResponseCodec, encodePayload(searchResponseCodec, response)),
    response
  )
})
