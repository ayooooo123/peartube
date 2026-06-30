import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createProtocolClient, HOST_ERROR_CODES, PROTOCOL_EVENTS } from '../../host/src/index.js'

class PendingHRPC {
  constructor() {
    this.handlers = {}
  }

  getStatus() {
    return new Promise(() => {})
  }

  onEventError(handler) {
    this.handlers.error = handler
  }
}

test('native startup rejects when the worklet transport closes before host ready', async () => {
  const stream = new EventEmitter()
  const transportClosed = []
  const client = createProtocolClient({
    stream,
    HRPCImpl: PendingHRPC
  })

  client.events.on(PROTOCOL_EVENTS.TRANSPORT_CLOSED, (payload) => {
    transportClosed.push(payload)
  })

  const errorPromise = client.ready().catch((error) => error)
  stream.emit('close')

  const error = await errorPromise

  assert.deepEqual(transportClosed, [{ reason: 'close' }])
  assert.equal(error.code, HOST_ERROR_CODES.TRANSPORT_DISCONNECTED)
  assert.equal(error.retryable, true)
  assert.equal(error.message, 'Transport closed before host became ready: close')
})
