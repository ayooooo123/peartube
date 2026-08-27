import test from 'brittle'

import { createProtocolClient, PROTOCOL_EVENTS, PROTOCOL_VERSION } from '../src/index.js'

class ProviderHRPC {
  constructor() {
    this.handlers = {}
  }

  getStatus() {
    return Promise.resolve({ status: { protocolVersion: PROTOCOL_VERSION } })
  }

  providerSearch(request) {
    return Promise.resolve({ success: true, hits: [{ resolutionRef: 'ref-1', title: request.query }] })
  }

  resolveProviderRef(request) {
    return Promise.resolve({ success: true, resolution: { resolutionRef: request.resolutionRef } })
  }

  requestAcquisition(request) {
    return Promise.resolve({ success: true, acquisition: { acquisitionId: request.idempotencyKey, state: 'queued' }, replayed: false })
  }

  getAcquisition(request) {
    return Promise.resolve({ success: true, acquisition: { acquisitionId: request.acquisitionId, state: 'queued' } })
  }

  listAcquisitions() {
    return Promise.resolve({ success: true, acquisitions: [] })
  }

  cancelAcquisition(request) {
    return Promise.resolve({ success: true, acquisition: { acquisitionId: request.acquisitionId, state: 'cancelled' } })
  }

  getAcquisitionPolicy() {
    return Promise.resolve({ success: true, policy: { policyVersion: 1 } })
  }

  setAcquisitionPolicy(request) {
    return Promise.resolve({ success: true, policy: request.policy })
  }

  onEventAcquisitionLifecycle(handler) {
    this.handlers.lifecycle = handler
  }
}

test('host exposes provider methods and acquisition lifecycle events', async (t) => {
  const client = createProtocolClient({ stream: {}, HRPCImpl: ProviderHRPC })
  await client.ready()

  t.is((await client.provider.search({ query: 'Title' })).hits[0].title, 'Title')
  t.is((await client.provider.resolveProviderRef({ resolutionRef: 'ref-1' })).resolution.resolutionRef, 'ref-1')
  t.is((await client.provider.requestAcquisition({ idempotencyKey: 'key-1', request: {} })).acquisition.state, 'queued')
  t.alike((await client.provider.listAcquisitions()).acquisitions, [])
  t.is((await client.provider.cancelAcquisition({ acquisitionId: 'a-1' })).acquisition.state, 'cancelled')

  const events = []
  client.events.on(PROTOCOL_EVENTS.ACQUISITION_LIFECYCLE, (event) => events.push(event))
  client.rpc.handlers.lifecycle({ acquisitionId: 'a-1', state: 'acquiring' })
  t.is(events[0].state, 'acquiring')
})
