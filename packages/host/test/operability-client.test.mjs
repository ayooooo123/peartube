import test from 'brittle'

import { createProtocolClient, PROTOCOL_VERSION } from '../src/index.js'

class OperabilityHRPC {
  constructor() {
    this.calls = []
    OperabilityHRPC.instance = this
  }

  getStatus() {
    return Promise.resolve({
      status: { blobServerPort: null, blobServerReady: false, protocolVersion: PROTOCOL_VERSION }
    })
  }

  getPublisherDeviceStatus(request) { return this.respond('getPublisherDeviceStatus', request) }
  exportPortableState(request) { return this.respond('exportPortableState', request) }
  restorePortableState(request) { return this.respond('restorePortableState', request) }
  previewStorageLimit(request) { return this.respond('previewStorageLimit', request) }
  getArchiveOperatorStatus(request) { return this.respond('getArchiveOperatorStatus', request) }

  respond(method, request) {
    this.calls.push([method, request])
    return Promise.resolve({ success: true, method })
  }
}

test('host exposes operability methods through grouped namespaces', async (t) => {
  const client = createProtocolClient({ stream: {}, HRPCImpl: OperabilityHRPC })
  const manifestBytes = new Uint8Array([4, 5, 6])

  await client.publisher.getPublisherDeviceStatus({ publisherId: 'publisher', devicePublicKey: 'device' })
  await client.publisher.exportPortableState({})
  await client.publisher.restorePortableState({ manifestBytes, manifestDigest: 'digest' })
  await client.transfer.previewStorageLimit({ maxBytes: 1024 })
  await client.transfer.getArchiveOperatorStatus({})

  t.alike(OperabilityHRPC.instance.calls, [
    ['getPublisherDeviceStatus', { publisherId: 'publisher', devicePublicKey: 'device' }],
    ['exportPortableState', {}],
    ['restorePortableState', { manifestBytes, manifestDigest: 'digest' }],
    ['previewStorageLimit', { maxBytes: 1024 }],
    ['getArchiveOperatorStatus', {}]
  ])
})
