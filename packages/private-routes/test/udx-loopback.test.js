import test from 'brittle'
import b4a from 'b4a'

import {
  CELL_CLASS,
  DIRECTION,
  LINK_OPERATION,
  LinkDirectory,
  PROTOCOL_VERSION,
  TOPOLOGY_ROLE,
  UdxCellEndpoint,
  BootstrapEnvelopeCodec,
  CellCodec,
  createLinkSetupAuthority,
  cryptoSuite,
  signTopologyGrant
} from '../index.js'
import { readEstablishedLink } from '../lib/link-bootstrap-session.js'
import { selectUdxLoopbackHosts } from '../lib/udx-adapter.js'
import { safetyRoleIdentity, seed } from './helpers.js'

function random(first) {
  let value = first
  return (size) => b4a.alloc(size, value++)
}

function directory(options) {
  const value = new LinkDirectory({
    localIdentity32: options.local.publicKey,
    localRole: options.role,
    authorityPublicKey: options.authority.publicKey,
    epoch: options.epoch,
    runId32: options.runId32,
    now: () => BigInt(Date.now()),
    schedule: setTimeout,
    cancel: clearTimeout,
    onClose() {}
  })
  const digest32 = value.add(options.grant)
  const handle = value.authorize({
    digest32,
    operation: options.operation,
    localIdentity32: options.local.publicKey,
    localRole: options.role,
    peerIdentity32: options.peer.publicKey,
    peerRole: options.peerRole,
    epoch: options.epoch,
    runId32: options.runId32
  })
  return { value, handle }
}

test('real UDX numeric loopback authenticates bootstrap and one established cell', async (t) => {
  t.timeout(10_000)
  const authority = cryptoSuite.keyPair(seed(170))
  const initiator = cryptoSuite.keyPair(seed(171))
  const responder = safetyRoleIdentity(172)
  const responderStatic = cryptoSuite.encryptionKeyPair(seed(173))
  const epoch = 11n
  const runId32 = seed(174)
  const expiresAt = BigInt(Date.now() + 30_000)
  const portSeed = cryptoSuite.randomBytes(2)
  const leftPort = 40_000 + ((portSeed[0] * 256 + portSeed[1]) % 10_000)
  const rightPort = leftPort + 1
  portSeed.fill(0)
  const platform = typeof Bare === 'undefined' ? process.platform : Bare.platform
  const forceDistinct =
    typeof process !== 'undefined' && process.env.PRIVATE_ROUTES_DISTINCT_LOOPBACK === '1'
  // macOS fallback is explicit because this host probes extra 127/8 aliases as
  // EADDRNOTAVAIL. Linux/CI and the env gate prove distinct-IP source pinning.
  const [leftHost, rightHost] = selectUdxLoopbackHosts({ platform, forceDistinct })
  t.not(leftPort, rightPort)
  const grant = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(175),
      endpointA: {
        identity32: initiator.publicKey,
        role: TOPOLOGY_ROLE.SOURCE,
        host: leftHost,
        port: leftPort,
        operations: LINK_OPERATION.INITIATE
      },
      endpointB: {
        identity32: responder.publicKey,
        role: TOPOLOGY_ROLE.SAFETY_GUARD,
        host: rightHost,
        port: rightPort,
        operations: LINK_OPERATION.ACCEPT
      },
      epoch,
      notBefore: BigInt(Date.now() - 1_000),
      expiresAt,
      runId32
    },
    authority.secretKey
  )
  const leftDirectory = directory({
    local: initiator,
    peer: responder,
    role: TOPOLOGY_ROLE.SOURCE,
    peerRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    operation: LINK_OPERATION.INITIATE,
    authority,
    grant,
    epoch,
    runId32
  })
  const rightDirectory = directory({
    local: responder,
    peer: initiator,
    role: TOPOLOGY_ROLE.SAFETY_GUARD,
    peerRole: TOPOLOGY_ROLE.SOURCE,
    operation: LINK_OPERATION.ACCEPT,
    authority,
    grant,
    epoch,
    runId32
  })
  const common = {
    circuitId: b4a.alloc(16, 0x61),
    epoch,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    initiatorLocalId: b4a.alloc(16, 0x62),
    responderLocalId: b4a.alloc(16, 0x63),
    expiresAt
  }
  let leftSession
  let rightSession
  let received
  let finish
  let fail
  let timeout
  const completed = new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const cell = new CellCodec({ crypto: cryptoSuite, cellSize: 1200, padding: random(0x51) })
  const leftEndpoint = new UdxCellEndpoint({
    host: leftHost,
    port: leftPort,
    onBootstrap: (packet) => leftSession.receive(packet),
    onCell() {}
  })
  const rightEndpoint = new UdxCellEndpoint({
    host: rightHost,
    port: rightPort,
    onBootstrap: (packet) => rightSession.receive(packet),
    onCell(packet) {
      try {
        const state = readEstablishedLink(rightSession.established)
        const context = state.contexts[CELL_CLASS.STREAM].rx
        received = cell.open(
          {
            key: context.key,
            noncePrefix: context.noncePrefix,
            receiver: context.counter,
            expectedClass: CELL_CLASS.STREAM,
            expectedDirection: DIRECTION.FORWARD,
            expectedEpoch: epoch,
            expectedCircuitId: common.circuitId
          },
          packet
        )
        finish()
      } catch (err) {
        fail(err)
      }
    }
  })
  try {
    await leftEndpoint.bind()
    await rightEndpoint.bind()
    leftSession = leftEndpoint.openLink(leftDirectory.handle, {
      mode: 'initiate',
      codec: new BootstrapEnvelopeCodec({
        linkHandle: leftDirectory.handle,
        localIdentitySecretKey: initiator.secretKey,
        padding: random(0x31)
      }),
      linkSetup: createLinkSetupAuthority({ now: Date.now, randomBytes: random(0x11) }),
      setup: {
        ...common,
        responderStaticKey: responderStatic.publicKey,
        initiatorIdentitySecretKey: initiator.secretKey
      },
      now: Date.now,
      schedule: setTimeout,
      cancel: clearTimeout,
      randomBytes: random(1)
    })
    rightSession = rightEndpoint.openLink(rightDirectory.handle, {
      mode: 'accept',
      codec: new BootstrapEnvelopeCodec({
        linkHandle: rightDirectory.handle,
        localIdentitySecretKey: responder.secretKey,
        padding: random(0x41)
      }),
      linkSetup: createLinkSetupAuthority({ now: Date.now, randomBytes: random(0x21) }),
      setup: {
        ...common,
        responderStaticSecretKey: responderStatic.secretKey,
        responderIdentitySecretKey: responder.secretKey
      },
      now: Date.now,
      schedule: setTimeout,
      cancel: clearTimeout,
      randomBytes: random(11)
    })
    const established = await leftSession.open()
    const rightDeadline = Date.now() + 5_000
    while (rightSession.state !== 'OPEN') {
      if (Date.now() >= rightDeadline) throw new Error('responder bootstrap deadline exceeded')
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const state = readEstablishedLink(established)
    const context = state.contexts[CELL_CLASS.STREAM].tx
    const packet = cell.seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: context.counter,
      class: CELL_CLASS.STREAM,
      direction: DIRECTION.FORWARD,
      epoch,
      circuitId: common.circuitId,
      payload: b4a.from('loopback-private-cell')
    })
    const sendHandle = leftEndpoint.openLink(leftDirectory.handle)
    t.is(await leftEndpoint.send(sendHandle, packet), true)
    const bounded = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('UDX loopback deadline exceeded')), 5_000)
      completed.then(resolve, reject)
    })
    await bounded
    t.is(received.length, 1)
    t.ok(b4a.equals(received[0], b4a.from('loopback-private-cell')))
    received[0].fill(0)
    t.alike(state.peerIdentity, responder.publicKey)
    t.alike(readEstablishedLink(rightSession.established).peerIdentity, initiator.publicKey)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (leftSession) await leftSession.close()
    if (rightSession) await rightSession.close()
    await leftEndpoint.close()
    await rightEndpoint.close()
    leftDirectory.value.destroy()
    rightDirectory.value.destroy()
  }
})
