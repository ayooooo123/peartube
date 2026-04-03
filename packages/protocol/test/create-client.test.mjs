import test from 'brittle'

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

  t.alike(ready, { blobServerPort: 9999, protocolVersion: 2 })
  t.alike(readyEvents[0], ready)

  FakeHRPC.instances[0].handlers.feedUpdate({ action: 'update', channelKey: 'abc' })

  t.alike(events[0], { action: 'update', channelKey: 'abc' })
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
