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
  }

  const encoded = encodePayload(bootstrapResponseCodec, {
    blobServerPort: 64369,
    protocolVersion: 1,
    storagePath: '/tmp/native',
    snapshot,
  })

  assert.deepEqual(decodePayload(bootstrapResponseCodec, encoded), {
    blobServerPort: 64369,
    protocolVersion: 1,
    storagePath: '/tmp/native',
    snapshot,
  })
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
