import b4a from 'b4a'
import test from 'brittle'

import {
  createExtensionOfferReceiver,
  createExtensionResponseReceiver,
  finishExtensionResponse,
  sendExtensionAccept,
  sendExtensionProof,
  takeExtensionOffer,
  takeExtensionResponse
} from '../lib/extension-setup-channel.js'
import { LINK_ACCEPT_SIZE, LINK_OFFER_SIZE } from '../lib/guard-link.js'
import { REDACTED_RESPONDER_PROOF_SIZE } from '../lib/redacted-responder-proof.js'
import { encodeCanonicalEndpoint } from '../lib/relay-capability.js'

function bytes(size, byte) {
  return b4a.alloc(size, byte)
}

function endpoint(last = 1) {
  return encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port: 44_000 + last
  })
}

function expectCode(t, operation, code, message) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  t.is(error && error.code, code, message)
}

test('extension offer receiver binds one OFFER, peer endpoint, writer, and physical channel', (t) => {
  const offer = bytes(LINK_OFFER_SIZE, 0x11)
  const accept = bytes(LINK_ACCEPT_SIZE, 0x12)
  const proof = bytes(REDACTED_RESPONDER_PROOF_SIZE, 0x13)
  const inbound = [offer, null]
  const outbound = []
  const physicalChannel = Object.freeze({ destroy() {} })
  let transferred = false
  let finished = 0
  let destroyed = 0
  const receiver = createExtensionOfferReceiver({
    observedPredecessorEndpoint: endpoint(),
    receiveObject: () => inbound.shift(),
    takePhysicalChannel() {
      if (transferred) return null
      transferred = true
      return physicalChannel
    },
    sendObject: (object) => outbound.push(object),
    finish: () => finished++,
    destroy: () => destroyed++
  })

  const received = takeExtensionOffer(receiver)
  t.alike(received.offer, offer)
  t.alike(received.observedPredecessorEndpoint, endpoint())
  t.is(received.physicalChannel, physicalChannel)
  t.ok(Object.isFrozen(received.responseWriter))
  t.alike(Object.keys(received.responseWriter), [])
  expectCode(t, () => sendExtensionProof(received.responseWriter, proof), 'ERR_REPLAY')
  sendExtensionAccept(received.responseWriter, accept)
  expectCode(t, () => finishExtensionResponse(received.responseWriter), 'ERR_REPLAY')
  sendExtensionProof(received.responseWriter, proof)
  finishExtensionResponse(received.responseWriter)
  t.alike(outbound, [accept, proof])
  t.is(finished, 1)
  t.is(destroyed, 0)
  expectCode(t, () => takeExtensionOffer(receiver), 'ERR_REPLAY')
  expectCode(t, () => sendExtensionAccept(received.responseWriter, accept), 'ERR_REPLAY')
})

test('extension offer receiver rejects a second initiator object before channel transfer', (t) => {
  const inbound = [bytes(LINK_OFFER_SIZE, 0x21), bytes(1, 0x22)]
  let transferred = 0
  let destroyed = 0
  const receiver = createExtensionOfferReceiver({
    observedPredecessorEndpoint: endpoint(2),
    receiveObject: () => inbound.shift(),
    takePhysicalChannel() {
      transferred++
      return Object.freeze({ destroy() {} })
    },
    sendObject() {},
    finish() {},
    destroy: () => destroyed++
  })

  expectCode(t, () => takeExtensionOffer(receiver), 'INVALID_ROUTE')
  t.is(transferred, 0)
  t.is(destroyed, 1)
  expectCode(t, () => takeExtensionOffer(receiver), 'ERR_REPLAY')
})

test('extension response receiver transfers only exact ACCEPT then PROOF and no fourth object', (t) => {
  const accept = bytes(LINK_ACCEPT_SIZE, 0x31)
  const proof = bytes(REDACTED_RESPONDER_PROOF_SIZE, 0x32)
  const physicalChannel = Object.freeze({ destroy() {} })
  const inbound = [accept, proof, null]
  let transferred = false
  let destroyed = 0
  const receiver = createExtensionResponseReceiver({
    receiveObject: () => inbound.shift(),
    takePhysicalChannel() {
      if (transferred) return null
      transferred = true
      return physicalChannel
    },
    destroy: () => destroyed++
  })

  const received = takeExtensionResponse(receiver)
  t.alike(received.accept, accept)
  t.alike(received.proof, proof)
  t.is(received.physicalChannel, physicalChannel)
  t.is(destroyed, 0)
  expectCode(t, () => takeExtensionResponse(receiver), 'ERR_REPLAY')
})

test('extension response receiver erases partial state and rejects malformed order or trailing objects', (t) => {
  for (const [name, inbound] of [
    [
      'reordered',
      [bytes(REDACTED_RESPONDER_PROOF_SIZE, 0x41), bytes(LINK_ACCEPT_SIZE, 0x42), null]
    ],
    ['malformed proof', [bytes(LINK_ACCEPT_SIZE, 0x43), bytes(1, 0x44), null]],
    [
      'fourth object',
      [bytes(LINK_ACCEPT_SIZE, 0x45), bytes(REDACTED_RESPONDER_PROOF_SIZE, 0x46), bytes(1, 0x47)]
    ]
  ]) {
    let transferred = 0
    let destroyed = 0
    const receiver = createExtensionResponseReceiver({
      receiveObject: () => inbound.shift(),
      takePhysicalChannel() {
        transferred++
        return Object.freeze({ destroy() {} })
      },
      destroy: () => destroyed++
    })
    expectCode(t, () => takeExtensionResponse(receiver), 'INVALID_ROUTE', name)
    t.is(transferred, 0, `${name} does not transfer the channel`)
    t.is(destroyed, 1, `${name} destroys the setup receiver`)
  }
})
