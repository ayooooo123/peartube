import test from 'brittle'
import { EventEmitter } from 'node:events'

import { createProtocolClient, HOST_ERROR_CODES, PROTOCOL_EVENTS, PROTOCOL_VERSION } from '../src/index.js'

class FakeHRPC {
  static instances = []

  constructor() {
    this.handlers = {}
    FakeHRPC.instances.push(this)
  }

  getStatus() {
    return Promise.resolve({
        status: {
          blobServerPort: 9999,
          blobServerReady: true,
          blobServerError: null,
          protocolVersion: PROTOCOL_VERSION
        }
      })
  }

  onEventFeedUpdate(handler) {
    this.handlers.feedUpdate = handler
  }

  onEventLog(handler) {
    this.handlers.log = handler
  }

  onEventError(handler) {
    this.handlers.error = handler
  }

  onEventTranscodeProgress(handler) {
    this.handlers.transcodeProgress = handler
  }

  getSwarmStatus() {
    return Promise.resolve({
      connected: true,
      peerCount: 3,
      swarmConnections: 3,
      swarmPeers: 4,
      feedConnections: 2,
      feedEntries: 8,
      channelsLoaded: 5,
      swarmOffline: false,
      swarmListenResolved: true,
      peerPoolJoined: true,
      publicFeedDiscoveryJoined: true,
      feedTopicHex: 'feed-topic',
      recommendedBoundary: 'content-playback-or-ui',
      networkJson: JSON.stringify({ hyperswarm: { recentConnections: [{ type: 'client-attempt' }] } }),
      startupTimingJson: JSON.stringify({ events: [{ event: 'peer-discovered' }] }),
      doctorJson: JSON.stringify({ recommendedBoundary: 'transport-socket', socket: { swarmConnections: 0 } }),
      directPeerDialJson: JSON.stringify({ discoveredPeers: 6, pending: 3 })
    })
  }

  getCanonicalFeed() {
    return Promise.resolve({ entries: [] })
  }

  preparePlayback() {
    return Promise.resolve({ url: 'http://video.local/play' })
  }

  ffmpegDecodeAvailable() {
    return Promise.resolve({ available: true })
  }

  transcodeStart() {
    return Promise.resolve({ success: true, sessionId: 'tx', transcodeUrl: 'http://video.local/tx.m3u8' })
  }

  getMediaEntity(request) {
    return Promise.resolve({ success: true, entity: { entityId: request.entityId, entityKind: 'work' }, claims: [], conflicts: [] })
  }
}

test('createProtocolClient remaps feed update events', async (t) => {
  FakeHRPC.instances.length = 0
  const events = []
  const readyEvents = []

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: FakeHRPC
  })

  client.events.on(PROTOCOL_EVENTS.HOST_READY, (payload) => {
    readyEvents.push(payload)
  })

  client.events.on(PROTOCOL_EVENTS.FEED_UPDATED, (payload) => {
    events.push(payload)
  })

  const ready = await client.ready()

  t.alike(ready, { blobServerPort: 9999, blobServerReady: true, blobServerError: null, protocolVersion: PROTOCOL_VERSION })
  t.alike(readyEvents[0], ready)

  FakeHRPC.instances[0].handlers.feedUpdate({ action: 'update', channelKey: 'abc' })

  t.alike(events[0], { action: 'update', channelKey: 'abc' })
})

test('createProtocolClient propagates degraded blob server readiness and does not dedupe status changes', async (t) => {
  FakeHRPC.instances.length = 0
  const readyEvents = []

  class DegradedHRPC extends FakeHRPC {
    getStatus() {
      return Promise.resolve({
        status: {
          blobServerPort: null,
          blobServerReady: false,
          blobServerError: 'listen failed',
          protocolVersion: PROTOCOL_VERSION
        }
      })
    }

    onEventReady(handler) {
      this.handlers.ready = handler
    }
  }

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: DegradedHRPC
  })

  client.events.on(PROTOCOL_EVENTS.HOST_READY, (payload) => {
    readyEvents.push(payload)
  })

  const ready = await client.ready()

  t.alike(ready, { blobServerPort: null, blobServerReady: false, blobServerError: 'listen failed', protocolVersion: PROTOCOL_VERSION })
  t.alike(readyEvents, [ready])

  FakeHRPC.instances[0].handlers.ready({
    blobServerPort: null,
    blobServerReady: false,
    blobServerError: 'listen failed',
    protocolVersion: PROTOCOL_VERSION
  })
  FakeHRPC.instances[0].handlers.ready({
    blobServerPort: 4545,
    blobServerReady: true,
    blobServerError: null,
    protocolVersion: PROTOCOL_VERSION
  })

  t.alike(readyEvents, [
    ready,
    { blobServerPort: 4545, blobServerReady: true, blobServerError: null, protocolVersion: PROTOCOL_VERSION }
  ])
})

test('createProtocolClient forwards log events through the shared event map', async (t) => {
  FakeHRPC.instances.length = 0
  const logEvents = []

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: FakeHRPC
  })

  client.events.on(PROTOCOL_EVENTS.LOG, (payload) => {
    logEvents.push(payload)
  })

  await client.ready()
  FakeHRPC.instances[0].handlers.log({ level: 'info', message: 'backend ready' })

  t.alike(logEvents, [{ level: 'info', message: 'backend ready' }])
})

test('createProtocolClient exposes generated app RPC namespace methods', async (t) => {
  FakeHRPC.instances.length = 0
  const client = createProtocolClient({
    stream: {},
    HRPCImpl: FakeHRPC
  })

  t.alike(await client.feed.getCanonicalFeed(), { entries: [] })
  t.alike(await client.video.preparePlayback({ channelKey: 'ch', videoId: 'v' }), { url: 'http://video.local/play' })
  t.alike(await client.shell.ffmpegDecodeAvailable(), { available: true })
  t.alike(await client.shell.transcodeStart({ sourceUrl: 'http://video.local/source.mp4' }), {
    success: true,
    sessionId: 'tx',
    transcodeUrl: 'http://video.local/tx.m3u8'
  })
  t.alike(await client.mediaGraph.getMediaEntity({ entityId: 'work-1' }), {
    success: true,
    entity: { entityId: 'work-1', entityKind: 'work' },
    claims: [],
    conflicts: []
  })
})

test('createProtocolClient catalog methods wait for ready and preserve request presence and structured errors', async (t) => {
  FakeHRPC.instances.length = 0
  let resolveStatus

  class CatalogHRPC extends FakeHRPC {
    constructor() {
      super()
      this.calls = []
    }

    getStatus() {
      return new Promise((resolve) => {
        resolveStatus = resolve
      })
    }

    getContentCatalog(request) {
      this.calls.push(['catalog', request])
      return Promise.resolve({
        success: true,
        profile: { channelKey: request.channelKey, name: 'Catalog' },
        groups: []
      })
    }

    getContentItems(request) {
      this.calls.push(['items', request])
      if (request.cursor === 'invalid') {
        return Promise.resolve({
          success: false,
          errorCode: 'INVALID_CURSOR',
          error: 'Invalid catalog cursor',
          items: []
        })
      }
      return Promise.resolve({
        success: true,
        group: { id: request.groupId, kind: 'latest', title: 'Latest', itemCount: 0 },
        items: []
      })
    }
  }

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: CatalogHRPC
  })
  const rpc = FakeHRPC.instances[0]
  const catalogRequest = { channelKey: 'abc' }
  const explicitZeroRequest = { channelKey: 'abc', groupId: 'latest', limit: 0 }
  const omittedLimitRequest = { channelKey: 'abc', publicBeeKey: 'def', groupId: 'latest' }

  const catalogPromise = client.channel.getContentCatalog(catalogRequest)
  const explicitZeroPromise = client.channel.getContentItems(explicitZeroRequest)
  const omittedLimitPromise = client.channel.getContentItems(omittedLimitRequest)
  await Promise.resolve()
  t.alike(rpc.calls, [])

  resolveStatus({
    status: {
      blobServerPort: 9999,
      blobServerReady: true,
      blobServerError: null,
      protocolVersion: PROTOCOL_VERSION
    }
  })

  t.is((await catalogPromise).success, true)
  t.is((await explicitZeroPromise).success, true)
  t.is((await omittedLimitPromise).success, true)
  t.alike(rpc.calls, [
    ['catalog', catalogRequest],
    ['items', { ...explicitZeroRequest, limitProvided: true }],
    ['items', omittedLimitRequest]
  ])
  t.alike(
    await client.channel.getContentItems({ channelKey: 'abc', groupId: 'latest', cursor: 'invalid' }),
    {
      success: false,
      errorCode: 'INVALID_CURSOR',
      error: 'Invalid catalog cursor',
      items: []
    }
  )
})

test('createProtocolClient forwards transcode progress events through the shared event map', async (t) => {
  FakeHRPC.instances.length = 0
  const progressEvents = []

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: FakeHRPC
  })

  client.events.on(PROTOCOL_EVENTS.TRANSCODE_PROGRESS, (payload) => {
    progressEvents.push(payload)
  })

  await client.ready()
  FakeHRPC.instances[0].handlers.transcodeProgress({ sessionId: 'tx', percent: 40, bytesWritten: 1024 })

  t.alike(progressEvents, [{ sessionId: 'tx', percent: 40, bytesWritten: 1024 }])
})

test('createProtocolClient emits normalized network status from the system namespace', async (t) => {
  FakeHRPC.instances.length = 0
  const networkEvents = []

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: FakeHRPC
  })

  client.events.on(PROTOCOL_EVENTS.NETWORK_STATUS, (payload) => {
    networkEvents.push(payload)
  })

  const status = await client.system.getSwarmStatus()

  t.alike(status, {
    connected: true,
    peerCount: 3,
    swarmConnections: 3,
    swarmPeers: 4,
    feedConnections: 2,
    feedEntries: 8,
    channelsLoaded: 5,
    swarmOffline: false,
    swarmOfflineReason: null,
    swarmListenResolved: true,
    peerPoolJoined: true,
    publicFeedDiscoveryJoined: true,
    feedTopicHex: 'feed-topic',
    recommendedBoundary: 'content-playback-or-ui',
    network: { hyperswarm: { recentConnections: [{ type: 'client-attempt' }] } },
    startupTiming: { events: [{ event: 'peer-discovered' }] },
    doctor: { recommendedBoundary: 'transport-socket', socket: { swarmConnections: 0 } },
    directPeerDial: { discoveredPeers: 6, pending: 3 }
  })
  t.alike(networkEvents, [status])
})

test('createProtocolClient fails fast on protocol version mismatch', async (t) => {
  class MismatchedHRPC extends FakeHRPC {
    getStatus() {
      return Promise.resolve({
        status: {
          blobServerPort: 9999,
          protocolVersion: PROTOCOL_VERSION + 1
        }
      })
    }
  }

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: MismatchedHRPC
  })

  let error = null
  try {
    await client.ready()
  } catch (caught) {
    error = caught
  }

  t.ok(error)
  t.is(error.code, HOST_ERROR_CODES.PROTOCOL_VERSION_MISMATCH)
  t.is(error.message, 'PROTOCOL_VERSION_MISMATCH')
})

test('createProtocolClient rejects ready once when host error event arrives', async (t) => {
  FakeHRPC.instances.length = 0
  const hostErrors = []

  class PendingHRPC extends FakeHRPC {
    getStatus() {
      return new Promise(() => {})
    }
  }

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: PendingHRPC
  })

  client.events.on(PROTOCOL_EVENTS.HOST_ERROR, (payload) => {
    hostErrors.push(payload)
  })

  const readyPromise = client.ready().catch((error) => error)
  FakeHRPC.instances[0].handlers.error({
    code: 'HOST_BOOT_FAILED',
    message: 'boom',
    retryable: true
  })

  const error = await readyPromise

  t.is(hostErrors.length, 1)
  t.is(error.code, 'HOST_BOOT_FAILED')
  t.is(error.message, 'boom')
})

test('createProtocolClient treats transient backend-not-ready status probes as startup noise', async (t) => {
  FakeHRPC.instances.length = 0
  const warnCalls = []
  const originalWarn = console.warn
  console.warn = (...args) => {
    warnCalls.push(args)
  }
  t.teardown(() => {
    console.warn = originalWarn
  })

  class StartingHRPC extends FakeHRPC {
    getStatus() {
      return Promise.reject(new Error('Backend not ready'))
    }

    onEventReady(handler) {
      this.handlers.ready = handler
    }
  }

  const client = createProtocolClient({
    stream: {},
    HRPCImpl: StartingHRPC
  })

  const readyPromise = client.ready()
  await Promise.resolve()

  FakeHRPC.instances[0].handlers.ready({
    blobServerPort: 9999,
    blobServerReady: true,
    blobServerError: null,
    protocolVersion: PROTOCOL_VERSION
  })

  const ready = await readyPromise
  await Promise.resolve()

  t.alike(ready, {
    blobServerPort: 9999,
    blobServerReady: true,
    blobServerError: null,
    protocolVersion: PROTOCOL_VERSION
  })
  t.alike(warnCalls, [])
})

test('createProtocolClient rejects ready when the transport closes before host ready', async (t) => {
  class PendingHRPC extends FakeHRPC {
    getStatus() {
      return new Promise(() => {})
    }
  }

  const stream = new EventEmitter()
  const transportClosed = []
  const hostErrors = []
  const client = createProtocolClient({
    stream,
    HRPCImpl: PendingHRPC
  })

  client.events.on(PROTOCOL_EVENTS.TRANSPORT_CLOSED, (payload) => {
    transportClosed.push(payload)
  })
  client.events.on(PROTOCOL_EVENTS.HOST_ERROR, (payload) => {
    hostErrors.push(payload)
  })

  const errorPromise = client.ready().catch((error) => error)
  stream.emit('close')

  const error = await errorPromise

  t.alike(transportClosed, [{ reason: 'close' }])
  t.is(hostErrors.length, 0)
  t.is(error.code, HOST_ERROR_CODES.TRANSPORT_DISCONNECTED)
  t.is(error.retryable, true)
  t.is(error.message, 'Transport closed before host became ready: close')
})
