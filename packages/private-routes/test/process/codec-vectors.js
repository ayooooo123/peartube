import b4a from 'b4a'

import {
  BOOTSTRAP_TYPE,
  BootstrapEnvelopeCodec,
  CELL_CLASS,
  DIRECTION,
  LINK_CONTROL_KIND,
  LINK_OPERATION,
  LinkDirectory,
  PROTOCOL_VERSION,
  RemoteControlMux,
  TOPOLOGY_ROLE,
  createLinkSetupAuthority,
  cryptoSuite,
  signTopologyGrant
} from '../../index.js'
import { seed } from '../helpers.js'

function random(first) {
  let value = first
  return (size) => b4a.alloc(size, value++)
}

function directory(options) {
  const value = new LinkDirectory({
    localIdentity32: options.local.publicKey,
    localRole: options.localRole,
    authorityPublicKey: options.authority.publicKey,
    epoch: options.epoch,
    runId32: options.runId32,
    now: () => 1_000n,
    schedule: (callback) => callback,
    cancel() {},
    onClose() {}
  })
  const digest32 = value.add(options.grant)
  const handle = value.authorize({
    digest32,
    operation: options.operation,
    localIdentity32: options.local.publicKey,
    localRole: options.localRole,
    peerIdentity32: options.peer.publicKey,
    peerRole: options.peerRole,
    epoch: options.epoch,
    runId32: options.runId32
  })
  digest32.fill(0)
  return { value, handle }
}

function fingerprint(value) {
  const digest = cryptoSuite.hash(value)
  const encoded = b4a.toString(digest, 'hex')
  digest.fill(0)
  return encoded
}

export function createProcessCodecVectors() {
  const authority = cryptoSuite.keyPair(seed(240))
  const initiator = cryptoSuite.keyPair(seed(241))
  const responder = cryptoSuite.keyPair(seed(242))
  const responderStatic = cryptoSuite.encryptionKeyPair(seed(243))
  const epoch = 7n
  const runId32 = seed(244)
  const grant = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(245),
      endpointA: {
        identity32: initiator.publicKey,
        role: TOPOLOGY_ROLE.SOURCE,
        host: '127.0.0.1',
        port: 43_001,
        operations: LINK_OPERATION.INITIATE
      },
      endpointB: {
        identity32: responder.publicKey,
        role: TOPOLOGY_ROLE.SAFETY_GUARD,
        host: '127.0.0.2',
        port: 43_002,
        operations: LINK_OPERATION.ACCEPT
      },
      epoch,
      notBefore: 900n,
      expiresAt: 2_000n,
      runId32
    },
    authority.secretKey
  )
  const left = directory({
    local: initiator,
    peer: responder,
    localRole: TOPOLOGY_ROLE.SOURCE,
    peerRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    operation: LINK_OPERATION.INITIATE,
    authority,
    grant,
    epoch,
    runId32
  })
  const right = directory({
    local: responder,
    peer: initiator,
    localRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    peerRole: TOPOLOGY_ROLE.SOURCE,
    operation: LINK_OPERATION.ACCEPT,
    authority,
    grant,
    epoch,
    runId32
  })
  const leftCodec = new BootstrapEnvelopeCodec({
    linkHandle: left.handle,
    localIdentitySecretKey: initiator.secretKey,
    padding: (size) => b4a.alloc(size, 0xa5)
  })
  const rightCodec = new BootstrapEnvelopeCodec({
    linkHandle: right.handle,
    localIdentitySecretKey: responder.secretKey,
    padding: (size) => b4a.alloc(size, 0xb5)
  })
  let packet = null
  let roundtrip = null
  let control = null
  let controlRoundtrip = null
  let decoded = null
  let decodedControl = null
  try {
    const common = {
      circuitId: b4a.alloc(16, 0x21),
      epoch,
      initiatorIdentity: initiator.publicKey,
      responderIdentity: responder.publicKey,
      initiatorLocalId: b4a.alloc(16, 0x22),
      responderLocalId: b4a.alloc(16, 0x23),
      expiresAt: 2_000n
    }
    const setup = createLinkSetupAuthority({ now: () => 1_000, randomBytes: random(0x31) })
    const started = setup.initiate({
      ...common,
      responderStaticKey: responderStatic.publicKey,
      initiatorIdentitySecretKey: initiator.secretKey
    })
    packet = leftCodec.encode({
      type: BOOTSTRAP_TYPE.LINK_CREATE,
      requestId: 0x0102_0304_0506_0708n,
      epoch,
      body: started.message,
      requestDigest32: b4a.alloc(32)
    })
    decoded = rightCodec.decode(packet, { host: '127.0.0.1', port: 43_001 })
    roundtrip = leftCodec.encode({
      type: decoded.type,
      requestId: decoded.requestId,
      epoch: decoded.epoch,
      body: decoded.body,
      requestDigest32: b4a.alloc(32)
    })
    if (!b4a.equals(packet, roundtrip)) throw new Error('bootstrap vector mismatch')

    const mux = new RemoteControlMux()
    const outer = {
      class: CELL_CLASS.CONTROL,
      direction: DIRECTION.FORWARD,
      circuitId: b4a.alloc(16, 0x41)
    }
    control = mux.encodeLink(
      {
        version: PROTOCOL_VERSION,
        kind: LINK_CONTROL_KIND.LINK_PING,
        flags: 0,
        direction: DIRECTION.FORWARD,
        circuitId: outer.circuitId,
        generation: 0n,
        challenge: b4a.alloc(16, 0x42)
      },
      outer
    )
    decodedControl = mux.decode(control, outer)
    controlRoundtrip = mux.encodeLink(decodedControl.message, outer)
    if (!b4a.equals(control, controlRoundtrip)) throw new Error('control vector mismatch')
    return Object.freeze({ bootstrap: fingerprint(packet), control: fingerprint(control) })
  } finally {
    for (const value of [packet, roundtrip, control, controlRoundtrip]) {
      if (value) value.fill(0)
    }
    if (decoded) {
      for (const value of Object.values(decoded)) if (b4a.isBuffer(value)) value.fill(0)
    }
    if (decodedControl?.message) {
      for (const value of Object.values(decodedControl.message)) {
        if (b4a.isBuffer(value)) value.fill(0)
      }
    }
    leftCodec.destroy()
    rightCodec.destroy()
    left.value.destroy()
    right.value.destroy()
    grant.fill(0)
    runId32.fill(0)
    authority.secretKey.fill(0)
    initiator.secretKey.fill(0)
    responder.secretKey.fill(0)
    responderStatic.secretKey.fill(0)
  }
}
