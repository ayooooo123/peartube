import test from 'brittle'
import { EventEmitter } from 'node:events'

import { createProtocolClient, HOST_ERROR_CODES, PROTOCOL_EVENTS } from '../src/index.js'

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
          protocolVersion: 2
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
      recommendedBoundary: 'content-playback-or-ui'
    })
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

  t.alike(ready, { blobServerPort: 9999, blobServerReady: true, blobServerError: null, protocolVersion: 2 })
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
          protocolVersion: 2
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

  t.alike(ready, { blobServerPort: null, blobServerReady: false, blobServerError: 'listen failed', protocolVersion: 2 })
  t.alike(readyEvents, [ready])

  FakeHRPC.instances[0].handlers.ready({
    blobServerPort: null,
    blobServerReady: false,
    blobServerError: 'listen failed',
    protocolVersion: 2
  })
  FakeHRPC.instances[0].handlers.ready({
    blobServerPort: 4545,
    blobServerReady: true,
    blobServerError: null,
    protocolVersion: 2
  })

  t.alike(readyEvents, [
    ready,
    { blobServerPort: 4545, blobServerReady: true, blobServerError: null, protocolVersion: 2 }
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
    recommendedBoundary: 'content-playback-or-ui'
  })
  t.alike(networkEvents, [status])
})

test('createProtocolClient fails fast on protocol version mismatch', async (t) => {
  class MismatchedHRPC extends FakeHRPC {
    getStatus() {
      return Promise.resolve({
        status: {
          blobServerPort: 9999,
          protocolVersion: 1
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
