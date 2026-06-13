import c from 'compact-encoding'

export const NATIVE_BRIDGE_PROTOCOL_VERSION = 3

export const BRIDGE_COMMANDS = Object.freeze({
  bootstrap: 1,
  refreshBrowse: 2,
  resolvePlayback: 3,
  shutdown: 4,
  searchVideos: 5,
  createIdentity: 6,
  refreshFeed: 7,
  publishActiveChannel: 8,
  subscribeChannel: 9,
  unsubscribeChannel: 10,
  uploadVideo: 11,
  resolveThumbnail: 12,
  getVideoStats: 22,
  addComment: 23,
  listComments: 24,
  hideComment: 25,
  removeComment: 26,
  addReaction: 27,
  removeReaction: 28,
  getReactions: 29,
  getChannelMeta: 30,
  listChannelVideos: 31,
  updateChannel: 32,
  updateChannelAvatar: 33,
  updateVideoMetadata: 34,
  deleteVideo: 35,
  setVideoThumbnailFromFile: 36,
  ffmpegDecodeAvailable: 37,
})

export const BRIDGE_EVENTS = Object.freeze({
  hostReady: 1,
  hostError: 2,
  hostLog: 3,
  workletReady: 4,
  feedUpdated: 5,
  uploadProgress: 6,
  networkStatus: 7,
})

class IgnoredRPCFrameError extends Error {}

function optional(codec) {
  return {
    preencode(state, value) {
      const hasValue = value !== undefined && value !== null
      c.bool.preencode(state, hasValue)
      if (hasValue) codec.preencode(state, value)
    },
    encode(state, value) {
      const hasValue = value !== undefined && value !== null
      c.bool.encode(state, hasValue)
      if (hasValue) codec.encode(state, value)
    },
    decode(state) {
      const hasValue = c.bool.decode(state)
      return hasValue ? codec.decode(state) : null
    },
  }
}

function objectCodec(fields) {
  return {
    preencode(state, value = {}) {
      for (const field of fields) {
        field.codec.preencode(state, field.read(value))
      }
    },
    encode(state, value = {}) {
      for (const field of fields) {
        field.codec.encode(state, field.read(value))
      }
    },
    decode(state) {
      const value = {}
      for (const field of fields) {
        value[field.key] = field.codec.decode(state)
      }
      return value
    },
  }
}

function field(key, codec, defaultValue = undefined) {
  return {
    key,
    codec,
    read(value) {
      const resolved = value?.[key]
      if (resolved !== undefined) return resolved
      if (typeof defaultValue === 'function') return defaultValue()
      return defaultValue
    },
  }
}

function encodeValue(codec, value) {
  const state = c.state()
  codec.preencode(state, value)
  state.buffer = Buffer.allocUnsafe(state.end)
  codec.encode(state, value)
  return state.buffer
}

function decodeValue(codec, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const state = c.state(0, buffer.length, buffer)
  return codec.decode(state)
}

const stringArrayCodec = c.array(c.string)
const optionalStringCodec = optional(c.string)
const optionalUIntCodec = optional(c.uint)
const optionalBufferCodec = optional(c.buffer)

export const pushRequestCodec = objectCodec([
  field('command', c.uint),
  field('data', optionalBufferCodec, null),
])

const nativeVideoCodec = objectCodec([
  field('id', c.string),
  field('backendVideoID', c.string),
  field('channelKey', c.string),
  field('publicBeeKey', optionalStringCodec, null),
  field('title', c.string),
  field('channelName', c.string),
  field('durationText', c.string),
  field('summary', c.string),
  field('tags', stringArrayCodec, () => []),
  field('accentHex', c.string),
  field('sections', stringArrayCodec, () => []),
  field('thumbnailURL', optionalStringCodec, null),
  field('path', optionalStringCodec, null),
  field('blobId', optionalStringCodec, null),
  field('blobsCoreKey', optionalStringCodec, null),
  field('mimeType', optionalStringCodec, null),
  field('width', optionalUIntCodec, null),
  field('height', optionalUIntCodec, null),
])

const nativeBrowseSectionsCodec = objectCodec([
  field('home', c.array(nativeVideoCodec), () => []),
  field('subscriptions', c.array(nativeVideoCodec), () => []),
  field('library', c.array(nativeVideoCodec), () => []),
  field('studio', c.array(nativeVideoCodec), () => []),
  field('diagnostics', c.array(nativeVideoCodec), () => []),
])

const nativeBrowseStatsCodec = objectCodec([
  field('homeCount', c.uint, 0),
  field('subscriptionCount', c.uint, 0),
  field('libraryCount', c.uint, 0),
  field('channelCount', c.uint, 0),
])

const nativeBrowseStateCodec = objectCodec([
  field('subscriptionChannelKeys', stringArrayCodec, () => []),
  field('identityChannelKeys', stringArrayCodec, () => []),
  field('activeIdentityName', optionalStringCodec, null),
  field('activeIdentityChannelKey', optionalStringCodec, null),
  field('activeChannelPublished', c.bool, false),
])

export const bootstrapRequestCodec = objectCodec([
  field('storagePath', c.string),
])

export const browseSnapshotCodec = objectCodec([
  field('generatedAt', c.float64),
  field('sections', nativeBrowseSectionsCodec),
  field('stats', nativeBrowseStatsCodec),
  field('state', nativeBrowseStateCodec, () => ({
    subscriptionChannelKeys: [],
    identityChannelKeys: [],
    activeIdentityName: null,
    activeIdentityChannelKey: null,
    activeChannelPublished: false,
  })),
])

export const bootstrapResponseCodec = objectCodec([
  field('blobServerPort', optionalUIntCodec, null),
  field('protocolVersion', c.uint, NATIVE_BRIDGE_PROTOCOL_VERSION),
  field('storagePath', c.string),
  field('snapshot', browseSnapshotCodec),
])

export const resolvePlaybackRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('publicBeeKey', optionalStringCodec, null),
  field('videoId', c.string),
  field('videoPath', optionalStringCodec, null),
  field('blobId', optionalStringCodec, null),
  field('blobsCoreKey', optionalStringCodec, null),
  field('mimeType', optionalStringCodec, null),
])

export const resolvePlaybackResponseCodec = objectCodec([
  field('videoId', c.string),
  field('url', c.string),
])

export const videoStatsRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
  field('videoPath', optionalStringCodec, null),
])

export const videoStatsResponseCodec = objectCodec([
  field('success', c.bool, true),
  field('status', optionalStringCodec, null),
  field('progress', c.uint, 0),
  field('totalBlocks', c.uint, 0),
  field('downloadedBlocks', c.uint, 0),
  field('totalBytes', c.uint, 0),
  field('downloadedBytes', c.uint, 0),
  field('peerCount', c.uint, 0),
  field('swarmConnections', c.uint, 0),
  field('speedMBps', c.string, '0'),
  field('uploadSpeedMBps', optionalStringCodec, null),
  field('elapsed', c.uint, 0),
  field('isComplete', c.bool, false),
  field('error', optionalStringCodec, null),
])

export const addCommentRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
  field('text', c.string),
  field('parentId', optionalStringCodec, null),
  field('authorChannelKey', optionalStringCodec, null),
  field('publicBeeKey', optionalStringCodec, null),
])

export const addCommentResponseCodec = objectCodec([
  field('success', c.bool, false),
  field('commentId', optionalStringCodec, null),
  field('queued', c.bool, false),
  field('error', optionalStringCodec, null),
])

export const listCommentsRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
  field('page', c.uint, 0),
  field('limit', c.uint, 50),
  field('publicBeeKey', optionalStringCodec, null),
])

export const commentCodec = objectCodec([
  field('videoId', c.string),
  field('commentId', c.string),
  field('text', c.string),
  field('authorKeyHex', c.string),
  field('timestamp', c.uint, 0),
  field('parentId', optionalStringCodec, null),
  field('isAdmin', c.bool, false),
])

export const listCommentsResponseCodec = objectCodec([
  field('success', c.bool, false),
  field('comments', c.array(commentCodec), () => []),
  field('error', optionalStringCodec, null),
])

export const commentModerationRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
  field('commentId', c.string),
  field('authorChannelKey', optionalStringCodec, null),
  field('publicBeeKey', optionalStringCodec, null),
])

export const hideCommentResponseCodec = objectCodec([
  field('success', c.bool, false),
  field('error', optionalStringCodec, null),
])

export const removeCommentResponseCodec = objectCodec([
  field('success', c.bool, false),
  field('queued', c.bool, false),
  field('error', optionalStringCodec, null),
])

export const addReactionRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
  field('reactionType', c.string),
  field('authorChannelKey', optionalStringCodec, null),
  field('publicBeeKey', optionalStringCodec, null),
])

export const reactionRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
  field('authorChannelKey', optionalStringCodec, null),
  field('publicBeeKey', optionalStringCodec, null),
])

export const reactionMutationResponseCodec = objectCodec([
  field('success', c.bool, false),
  field('queued', c.bool, false),
  field('error', optionalStringCodec, null),
])

export const reactionCountCodec = objectCodec([
  field('reactionType', c.string),
  field('count', c.uint, 0),
])

export const getReactionsResponseCodec = objectCodec([
  field('success', c.bool, false),
  field('counts', c.array(reactionCountCodec), () => []),
  field('userReaction', optionalStringCodec, null),
  field('error', optionalStringCodec, null),
])

export const resolveThumbnailRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('publicBeeKey', optionalStringCodec, null),
  field('videoId', c.string),
  field('videoPath', optionalStringCodec, null),
])

export const resolveThumbnailResponseCodec = objectCodec([
  field('videoId', c.string),
  field('url', optionalStringCodec, null),
  field('exists', c.bool, false),
])

export const searchRequestCodec = objectCodec([
  field('query', c.string),
  field('topK', c.uint, 12),
])

export const searchResponseCodec = objectCodec([
  field('query', c.string),
  field('results', c.array(nativeVideoCodec), () => []),
])

export const createIdentityRequestCodec = objectCodec([
  field('name', c.string),
])

export const subscribeChannelRequestCodec = objectCodec([
  field('channelKey', c.string),
])

export const uploadVideoRequestCodec = objectCodec([
  field('filePath', c.string),
  field('title', c.string),
  field('description', c.string, ''),
  field('category', optionalStringCodec, null),
])

export const getChannelMetaRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('publicBeeKey', optionalStringCodec, null),
])

export const getChannelMetaResponseCodec = objectCodec([
  field('channelKey', c.string),
  field('publicBeeKey', optionalStringCodec, null),
  field('avatarURL', optionalStringCodec, null),
  field('name', optionalStringCodec, null),
  field('description', optionalStringCodec, null),
  field('videoCount', optionalUIntCodec, null),
])

export const listChannelVideosRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('publicBeeKey', optionalStringCodec, null),
])

export const listChannelVideosResponseCodec = objectCodec([
  field('channelKey', c.string),
  field('videos', c.array(nativeVideoCodec), () => []),
])

export const updateChannelRequestCodec = objectCodec([
  field('name', optionalStringCodec, null),
  field('description', optionalStringCodec, null),
])

export const updateChannelAvatarRequestCodec = objectCodec([
  field('filePath', c.string),
  field('mimeType', optionalStringCodec, null),
])

export const updateVideoMetadataRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
  field('title', optionalStringCodec, null),
  field('description', optionalStringCodec, null),
  field('category', optionalStringCodec, null),
])

export const deleteVideoRequestCodec = objectCodec([
  field('channelKey', c.string),
  field('videoId', c.string),
])

export const setVideoThumbnailFromFileRequestCodec = objectCodec([
  field('videoId', c.string),
  field('filePath', c.string),
])

export const mutationResponseCodec = objectCodec([
  field('success', c.bool, false),
  field('error', optionalStringCodec, null),
])

export const hostReadyEventCodec = objectCodec([
  field('blobServerPort', optionalUIntCodec, null),
])

export const hostErrorEventCodec = objectCodec([
  field('message', c.string),
])

export const hostLogEventCodec = objectCodec([
  field('message', c.string),
])

export const workletReadyEventCodec = objectCodec([
  field('stage', c.string),
])

export const feedUpdatedEventCodec = objectCodec([
  field('channelKey', c.string),
  field('action', c.string),
])

export const uploadProgressEventCodec = objectCodec([
  field('videoId', c.string),
  field('progress', c.uint, 0),
  field('bytesUploaded', optionalUIntCodec, null),
  field('totalBytes', optionalUIntCodec, null),
  field('speed', optionalUIntCodec, null),
  field('eta', optionalUIntCodec, null),
])

export const networkStatusEventCodec = objectCodec([
  field('bootstrapped', c.bool, false),
  field('firewalled', c.bool, false),
  field('peerCount', c.uint, 0),
  field('connectionCount', c.uint, 0),
  field('feedPeerCount', c.uint, 0),
  field('feedEntries', c.uint, 0),
  field('offline', c.bool, false),
  field('offlineReason', optionalStringCodec, null),
])

export const ffmpegDecodeAvailableResponseCodec = objectCodec([
  field('available', c.bool, false),
  field('error', optionalStringCodec, null),
])

const requestMessageCodec = {
  preencode(state, value) {
    c.uint.preencode(state, value.id)
    c.uint.preencode(state, value.command)
    c.uint.preencode(state, 0)
    c.buffer.preencode(state, value.data ?? null)
  },
  encode(state, value) {
    c.uint.encode(state, value.id)
    c.uint.encode(state, value.command)
    c.uint.encode(state, 0)
    c.buffer.encode(state, value.data ?? null)
  },
  decode(state) {
    const id = c.uint.decode(state)
    const command = c.uint.decode(state)
    const stream = c.uint.decode(state)
    if (stream !== 0) throw new IgnoredRPCFrameError('Streaming is not supported')
    return {
      kind: id === 0 ? 'event' : 'request',
      id,
      command,
      data: c.buffer.decode(state),
    }
  },
}

const responseMessageCodec = {
  preencode(state, value) {
    c.uint.preencode(state, value.id)
    c.bool.preencode(state, value.isError)
    c.uint.preencode(state, 0)
    if (value.isError) {
      c.string.preencode(state, value.message)
      c.string.preencode(state, value.code)
      c.int.preencode(state, value.errno)
      return
    }
    c.buffer.preencode(state, value.data ?? null)
  },
  encode(state, value) {
    c.uint.encode(state, value.id)
    c.bool.encode(state, value.isError)
    c.uint.encode(state, 0)
    if (value.isError) {
      c.string.encode(state, value.message)
      c.string.encode(state, value.code)
      c.int.encode(state, value.errno)
      return
    }
    c.buffer.encode(state, value.data ?? null)
  },
  decode(state) {
    const id = c.uint.decode(state)
    const isError = c.bool.decode(state)
    const stream = c.uint.decode(state)
    if (stream !== 0) throw new IgnoredRPCFrameError('Streaming is not supported')
    if (isError) {
      return {
        kind: 'response',
        id,
        isError: true,
        message: c.string.decode(state),
        code: c.string.decode(state),
        errno: c.int.decode(state),
      }
    }
    return {
      kind: 'response',
      id,
      isError: false,
      data: c.buffer.decode(state),
    }
  },
}

const decodedMessageCodec = {
  preencode(state, value) {
    if (value.kind === 'response') {
      c.uint.preencode(state, 2)
      responseMessageCodec.preencode(state, value)
      return
    }

    c.uint.preencode(state, 1)
    requestMessageCodec.preencode(state, value)
  },
  encode(state, value) {
    if (value.kind === 'response') {
      c.uint.encode(state, 2)
      responseMessageCodec.encode(state, value)
      return
    }

    c.uint.encode(state, 1)
    requestMessageCodec.encode(state, value)
  },
  decode(state) {
    const type = c.uint.decode(state)
    if (type === 1) return requestMessageCodec.decode(state)
    if (type === 2) return responseMessageCodec.decode(state)
    throw new IgnoredRPCFrameError(`Unknown RPC message type: ${type}`)
  },
}

export function encodePayload(codec, value) {
  return encodeValue(codec, value)
}

export function decodePayload(codec, value) {
  if (value === undefined || value === null) return null
  return decodeValue(codec, value)
}

export function encodeRequestFrame({ id, command, data = null }) {
  return encodeFrame({ kind: 'request', id, command, data })
}

export function encodeEventFrame({ command, data = null }) {
  return encodeRequestFrame({ id: 0, command, data })
}

export function encodeResponseFrame({ id, data = null }) {
  return encodeFrame({ kind: 'response', id, isError: false, data })
}

export function encodeErrorResponseFrame({
  id,
  message,
  code = 'ERROR',
  errno = 0,
}) {
  return encodeFrame({
    kind: 'response',
    id,
    isError: true,
    message,
    code,
    errno,
  })
}

function encodeFrame(message) {
  const body = encodeValue(decodedMessageCodec, message)
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

export function decodeFrame(frame) {
  const buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
  if (buffer.length < 4) throw new Error('RPC frame is too short')

  const bodyLength = buffer.readUInt32LE(0)
  if (bodyLength !== buffer.length - 4) {
    throw new Error('RPC frame length prefix does not match payload size')
  }

  try {
    return decodeValue(decodedMessageCodec, buffer.subarray(4))
  } catch (error) {
    if (error instanceof IgnoredRPCFrameError) return null
    throw error
  }
}

export function createRPCFrameParser() {
  let pending = Buffer.alloc(0)

  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      pending = pending.length === 0 ? Buffer.from(incoming) : Buffer.concat([pending, incoming])

      const frames = []

      while (pending.length >= 4) {
        const bodyLength = pending.readUInt32LE(0)
        const frameLength = bodyLength + 4
        if (pending.length < frameLength) break

        frames.push(decodeFrame(pending.subarray(0, frameLength)))
        pending = pending.subarray(frameLength)
      }

      return frames.filter(Boolean)
    },
  }
}
