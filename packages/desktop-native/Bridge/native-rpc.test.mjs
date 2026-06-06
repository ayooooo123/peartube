import test from 'node:test'
import { PROTOCOL_VERSION } from '../../host/src/contracts.js'
import assert from 'node:assert/strict'

import {
  BRIDGE_COMMANDS,
  BRIDGE_EVENTS,
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  bootstrapResponseCodec,
  createRPCFrameParser,
  decodeFrame,
  decodePayload,
  encodeEventFrame,
  encodePayload,
  encodeRequestFrame,
  getChannelMetaRequestCodec,
  getChannelMetaResponseCodec,
  feedUpdatedEventCodec,
  ffmpegDecodeAvailableResponseCodec,
  listChannelVideosRequestCodec,
  listChannelVideosResponseCodec,
  mpvAvailableResponseCodec,
  mpvCreateRequestCodec,
  mpvCreateResponseCodec,
  encodeResponseFrame,
  hostReadyEventCodec,
  networkStatusEventCodec,
  searchRequestCodec,
  searchResponseCodec,
  setVideoThumbnailFromFileRequestCodec,
  mutationResponseCodec,
  updateChannelAvatarRequestCodec,
  updateChannelRequestCodec,
  updateVideoMetadataRequestCodec,
  uploadProgressEventCodec,
  deleteVideoRequestCodec,
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
        width: 1080,
        height: 1920,
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
    protocolVersion: PROTOCOL_VERSION,
    storagePath: '/tmp/native',
    snapshot,
  })

  const decoded = decodePayload(bootstrapResponseCodec, encoded)
  assert.equal(decoded.blobServerPort, 64369)
  assert.equal(decoded.protocolVersion, PROTOCOL_VERSION)
  assert.equal(decoded.storagePath, '/tmp/native')
  assert.deepEqual(decoded.snapshot.sections.home, snapshot.sections.home)
  assert.deepEqual(decoded.snapshot.stats, snapshot.stats)
  assert.deepEqual(decoded.snapshot.state, snapshot.state)
})

test('bootstrap response requires explicit protocolVersion', () => {
  assert.throws(() => encodePayload(bootstrapResponseCodec, {
    storagePath: '/tmp/native',
    snapshot: {
      generatedAt: 1234,
      sections: { home: [], subscriptions: [], library: [], studio: [], diagnostics: [] },
      stats: { homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0 },
      state: {
        subscriptionChannelKeys: [],
        identityChannelKeys: [],
        activeIdentityName: null,
        activeChannelKey: null,
        activeChannelPublished: false,
      },
    },
  }), /protocolVersion is required/)

  assert.equal(NATIVE_BRIDGE_PROTOCOL_VERSION, PROTOCOL_VERSION)
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

test('feed update events roundtrip through compact encoding', () => {
  const eventFrame = encodeEventFrame({
    command: BRIDGE_EVENTS.feedUpdated,
    data: encodePayload(feedUpdatedEventCodec, {
      channelKey: 'feed',
      action: 'update',
    }),
  })

  const eventMessage = decodeFrame(eventFrame)

  assert.equal(eventMessage.kind, 'event')
  assert.equal(eventMessage.command, BRIDGE_EVENTS.feedUpdated)
  assert.deepEqual(
    decodePayload(feedUpdatedEventCodec, eventMessage.data),
    {
      channelKey: 'feed',
      action: 'update',
    }
  )
})

test('network status events roundtrip through compact encoding', () => {
  const eventFrame = encodeEventFrame({
    command: BRIDGE_EVENTS.networkStatus,
    data: encodePayload(networkStatusEventCodec, {
      bootstrapped: true,
      firewalled: false,
      peerCount: 2,
      connectionCount: 1,
      feedPeerCount: 1,
      feedEntries: 3,
      offline: false,
      offlineReason: null,
    }),
  })

  const eventMessage = decodeFrame(eventFrame)

  assert.equal(eventMessage.kind, 'event')
  assert.equal(eventMessage.command, BRIDGE_EVENTS.networkStatus)
  assert.deepEqual(
    decodePayload(networkStatusEventCodec, eventMessage.data),
    {
      bootstrapped: true,
      firewalled: false,
      peerCount: 2,
      connectionCount: 1,
      feedPeerCount: 1,
      feedEntries: 3,
      offline: false,
      offlineReason: null,
    }
  )
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
        width: 1080,
        height: 1920,
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

test('mpv payloads roundtrip through compact encoding', () => {
  const createRequest = { width: 1280, height: 720 }
  const createResponse = {
    success: true,
    playerId: 'mpv_1',
    frameServerPort: 48123,
    error: null,
  }
  const availableResponse = {
    available: true,
    error: null,
  }

  assert.equal(BRIDGE_COMMANDS.mpvAvailable, 13)
  assert.equal(BRIDGE_COMMANDS.mpvCreate, 14)
  assert.deepEqual(
    decodePayload(mpvCreateRequestCodec, encodePayload(mpvCreateRequestCodec, createRequest)),
    createRequest
  )
  assert.deepEqual(
    decodePayload(mpvCreateResponseCodec, encodePayload(mpvCreateResponseCodec, createResponse)),
    createResponse
  )
  assert.deepEqual(
    decodePayload(mpvAvailableResponseCodec, encodePayload(mpvAvailableResponseCodec, availableResponse)),
    availableResponse
  )
})

test('ffmpeg decode availability payloads roundtrip through compact encoding', () => {
  const availableResponse = {
    available: true,
    error: null,
  }

  assert.equal(BRIDGE_COMMANDS.ffmpegDecodeAvailable, 37)
  assert.deepEqual(
    decodePayload(
      ffmpegDecodeAvailableResponseCodec,
      encodePayload(ffmpegDecodeAvailableResponseCodec, availableResponse)
    ),
    availableResponse
  )
})

test('channel detail payloads roundtrip through compact encoding', () => {
  const metaRequest = {
    channelKey: 'channel-a',
    publicBeeKey: 'bee-a',
  }
  const metaResponse = {
    channelKey: 'channel-a',
    publicBeeKey: 'bee-a',
    avatarURL: 'https://example.com/avatar.jpg',
    name: 'Channel A',
    description: 'Uploads and creator notes.',
    videoCount: 12,
  }
  const listRequest = {
    channelKey: 'channel-a',
    publicBeeKey: null,
  }
  const listResponse = {
    channelKey: 'channel-a',
    videos: [
      {
        id: 'channel-a:video-1',
        backendVideoID: 'video-1',
        channelKey: 'channel-a',
        publicBeeKey: 'bee-a',
        title: 'Video 1',
        channelName: 'Channel A',
        durationText: '1:23',
        summary: 'Summary',
        tags: ['studio'],
        accentHex: '#FF7A59',
        sections: ['studio'],
        thumbnailURL: 'https://example.com/thumb.jpg',
        path: '/videos/video-1.mp4',
        blobId: '0:128:0:4096',
        blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        mimeType: 'video/mp4',
        width: 1080,
        height: 1920,
      },
    ],
  }

  assert.equal(BRIDGE_COMMANDS.getChannelMeta, 30)
  assert.equal(BRIDGE_COMMANDS.listChannelVideos, 31)
  assert.deepEqual(
    decodePayload(getChannelMetaRequestCodec, encodePayload(getChannelMetaRequestCodec, metaRequest)),
    metaRequest
  )
  assert.deepEqual(
    decodePayload(getChannelMetaResponseCodec, encodePayload(getChannelMetaResponseCodec, metaResponse)),
    metaResponse
  )
  assert.deepEqual(
    decodePayload(listChannelVideosRequestCodec, encodePayload(listChannelVideosRequestCodec, listRequest)),
    listRequest
  )
  assert.deepEqual(
    decodePayload(listChannelVideosResponseCodec, encodePayload(listChannelVideosResponseCodec, listResponse)),
    listResponse
  )
})

test('studio mutation payloads roundtrip through compact encoding', () => {
  const updateChannelRequest = {
    name: 'New Channel Name',
    description: 'Updated channel description.',
  }
  const updateChannelAvatarRequest = {
    filePath: '/tmp/avatar.jpg',
    mimeType: 'image/jpeg',
  }
  const updateVideoMetadataRequest = {
    channelKey: 'channel-a',
    videoId: 'video-1',
    title: 'Updated Title',
    description: 'Updated description.',
    category: 'Music',
  }
  const deleteVideoRequest = {
    channelKey: 'channel-a',
    videoId: 'video-1',
  }
  const setVideoThumbnailFromFileRequest = {
    videoId: 'video-1',
    filePath: '/tmp/thumb.jpg',
  }
  const mutationResponse = {
    success: true,
    error: null,
  }

  assert.equal(BRIDGE_COMMANDS.updateChannel, 32)
  assert.equal(BRIDGE_COMMANDS.updateChannelAvatar, 33)
  assert.equal(BRIDGE_COMMANDS.updateVideoMetadata, 34)
  assert.equal(BRIDGE_COMMANDS.deleteVideo, 35)
  assert.equal(BRIDGE_COMMANDS.setVideoThumbnailFromFile, 36)
  assert.deepEqual(
    decodePayload(updateChannelRequestCodec, encodePayload(updateChannelRequestCodec, updateChannelRequest)),
    updateChannelRequest
  )
  assert.deepEqual(
    decodePayload(updateChannelAvatarRequestCodec, encodePayload(updateChannelAvatarRequestCodec, updateChannelAvatarRequest)),
    updateChannelAvatarRequest
  )
  assert.deepEqual(
    decodePayload(updateVideoMetadataRequestCodec, encodePayload(updateVideoMetadataRequestCodec, updateVideoMetadataRequest)),
    updateVideoMetadataRequest
  )
  assert.deepEqual(
    decodePayload(deleteVideoRequestCodec, encodePayload(deleteVideoRequestCodec, deleteVideoRequest)),
    deleteVideoRequest
  )
  assert.deepEqual(
    decodePayload(setVideoThumbnailFromFileRequestCodec, encodePayload(setVideoThumbnailFromFileRequestCodec, setVideoThumbnailFromFileRequest)),
    setVideoThumbnailFromFileRequest
  )
  assert.deepEqual(
    decodePayload(mutationResponseCodec, encodePayload(mutationResponseCodec, mutationResponse)),
    mutationResponse
  )
})

test('upload progress events roundtrip through compact encoding', () => {
  const payload = {
    videoId: 'video-1',
    progress: 42,
    bytesUploaded: 1024,
    totalBytes: 2048,
    speed: 512,
    eta: 2,
  }
  const eventFrame = encodeEventFrame({
    command: BRIDGE_EVENTS.uploadProgress,
    data: encodePayload(uploadProgressEventCodec, payload),
  })

  const eventMessage = decodeFrame(eventFrame)

  assert.equal(BRIDGE_EVENTS.uploadProgress, 6)
  assert.equal(eventMessage.kind, 'event')
  assert.equal(eventMessage.command, BRIDGE_EVENTS.uploadProgress)
  assert.deepEqual(
    decodePayload(uploadProgressEventCodec, eventMessage.data),
    payload
  )
})


test('NATIVE_BRIDGE_PROTOCOL_VERSION follows @peartube/host', () => {
  assert.equal(NATIVE_BRIDGE_PROTOCOL_VERSION, PROTOCOL_VERSION)
})
