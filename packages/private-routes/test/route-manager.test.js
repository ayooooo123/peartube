import test from 'brittle'
import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  CAPABILITY,
  CELL_CLASS,
  CELL_SIZE,
  DIRECTION,
  PROTOCOL_VERSION,
  ROLE,
  CellCodec,
  PrivateRouteError,
  RelayService,
  RouteManager,
  VirtualNetwork,
  PrivacyDomainRegistry,
  PUBLIC_DHT,
  createCircuitAuthority,
  createRouteCandidateAuthority,
  createRouteCompilerAuthority,
  createSafetyInstallerAuthority,
  createDiscoveryEvidenceAuthority,
  createLinkSetupAuthority,
  cryptoSuite,
  encodeDescriptor,
  encodeRelayAdvertisement,
  signDelegation,
  signDescriptor,
  signRelayAdvertisement,
  verifyDescriptor
} from '../index.js'
import { TEST_ONLY_TICKET_OBSERVER } from '../lib/link-setup.js'
import { descriptorChecker, privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

function expectCode(t, fn, code) {
  try {
    fn()
    t.fail(`expected ${code}`)
  } catch (err) {
    t.is(err.code, code)
  }
}

function inertInstalledSafetyRoute(transcriptHash32 = seed(250)) {
  return {
    transcriptHash32,
    attachEntry() {
      return Object.freeze({})
    },
    sendControl() {
      return true
    },
    sendFrame() {
      return true
    },
    sendReverseFrame() {
      return true
    },
    destroy() {}
  }
}

function advertisement(pair, dial, overrides = {}) {
  const route = cryptoSuite.encryptionKeyPair(seed(dial.charCodeAt(0)))
  return signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: pair.publicKey,
      routeEncryptionKey: route.publicKey,
      dial: b4a.from(dial),
      role: ROLE.SAFETY,
      capabilities: CAPABILITY.KNOWN,
      epoch: 7n,
      expiresAt: 10_000n,
      ...overrides
    },
    pair.secretKey
  )
}

function verifiedDescriptor({
  delegated = false,
  epoch = 7n,
  expiresAt = 9_000n,
  verifyNow = 1_000n
} = {}) {
  const endpoint = cryptoSuite.keyPair(seed(220))
  const routeSigner = delegated ? cryptoSuite.keyPair(seed(219)) : endpoint
  const entry = privateRoleIdentity(1)
  const entryAdvertisement = advertisement(entry, 'entry', {
    role: ROLE.PRIVATE,
    epoch,
    expiresAt: 10_000n
  })
  const descriptor = {
    version: PROTOCOL_VERSION,
    authorizationMode: delegated ? AUTHORIZATION_MODE.DELEGATED : AUTHORIZATION_MODE.DIRECT,
    descriptorId: seed(222),
    endpointKey: endpoint.publicKey,
    routeSigningKey: routeSigner.publicKey,
    routeEncryptionKey: cryptoSuite.encryptionKeyPair(seed(223)).publicKey,
    entryAdvertisement: encodeRelayAdvertisement(entryAdvertisement),
    epoch,
    expiresAt,
    capabilities: CAPABILITY.KNOWN,
    cellSize: 1200,
    encryptedHops: b4a.from('opaque')
  }
  if (delegated) {
    descriptor.delegation = signDelegation(
      {
        version: PROTOCOL_VERSION,
        endpointKey: endpoint.publicKey,
        routeSigningKey: routeSigner.publicKey,
        notBefore: 500n,
        expiresAt,
        minEpoch: epoch,
        maxEpoch: epoch,
        capabilities: CAPABILITY.KNOWN
      },
      endpoint.secretKey
    )
  }
  const signed = signDescriptor(descriptor, routeSigner.secretKey)
  return {
    endpoint,
    entry,
    entryAdvertisement,
    verified: verifyDescriptor(encodeDescriptor(signed), {
      requestedEndpointKey: endpoint.publicKey,
      now: verifyNow
    })
  }
}

function fixture(overrides = {}) {
  const descriptor = overrides.descriptor || verifiedDescriptor()
  const guards = [safetyRoleIdentity(1), safetyRoleIdentity(20), safetyRoleIdentity(40)]
  const safety =
    overrides.safety ||
    guards.map((pair, index) => encodeRelayAdvertisement(advertisement(pair, `guard-${index}`)))
  const calls = []
  const network = overrides.network || new VirtualNetwork({ now: 1_000 })
  network.register('source', () => {})
  network.register('destination', () => {})
  const registry = overrides.registry || {
    allows(identity, operation, context) {
      calls.push(['allows', b4a.from(identity), operation, context])
      return true
    }
  }
  const routeSetup = overrides.circuitIssuer || {
    authenticate(value) {
      calls.push(['authenticate', value])
    },
    install(value) {
      calls.push(['install', value])
    },
    rollback() {
      calls.push(['rollback'])
    },
    finalize() {
      calls.push(['finalize'])
      return inertInstalledSafetyRoute()
    },
    issueFinalSafety(value) {
      calls.push(['issue', value])
      return Object.freeze({})
    }
  }
  const circuitIssuer = Object.freeze({
    issueFinalSafety(value) {
      return routeSetup.issueFinalSafety(value)
    }
  })
  const installerAuthority = createSafetyInstallerAuthority()
  const safetyInstaller = installerAuthority.issuer.issue(routeSetup)
  const compilerAuthority = createRouteCompilerAuthority()
  let compiledRequest = null
  const routeCompiler = compilerAuthority.issuer.issue((request) => {
    compiledRequest = request
    const route = installerAuthority.routeChecker.read(
      request.safetyRouteCapability,
      request.circuitContext
    )
    if (overrides.compile) return overrides.compile(request, route)
    return Object.freeze({
      sendDatagram() {},
      sendStreamFrame() {},
      drain() {},
      destroy() {
        route.destroy()
      }
    })
  })
  const manager = new RouteManager({
    network,
    registry,
    crypto: cryptoSuite,
    clock: () => 1_000,
    descriptorChecker: descriptorChecker(),
    circuitIssuer,
    safetyInstaller,
    safetyInstallerChecker: installerAuthority.checker,
    safetyRouteChecker: installerAuthority.routeChecker,
    routeCompiler,
    routeCompilerChecker: compilerAuthority.checker,
    routeCandidate: overrides.routeCandidate,
    routeCandidateChecker: overrides.routeCandidateChecker,
    limits: { maxSafetyHops: 3 }
  })
  return {
    calls,
    circuitIssuer,
    safetyInstaller,
    safetyInstallerChecker: installerAuthority.checker,
    descriptor,
    guards,
    manager,
    network,
    safety,
    get compiledRequest() {
      return compiledRequest
    }
  }
}

function candidate(epoch) {
  const descriptor = verifiedDescriptor({ epoch })
  const guards = [safetyRoleIdentity(1), safetyRoleIdentity(20)]
  return Object.freeze({
    descriptor: descriptor.verified,
    safety: guards.map((pair, index) =>
      encodeRelayAdvertisement(advertisement(pair, `guard-${index}`, { epoch }))
    )
  })
}

function replacementFixture(provider) {
  const authority = createRouteCandidateAuthority()
  const routeCandidate = authority.issuer.issue({ next: provider })
  const records = []
  const f = fixture({
    routeCandidate,
    routeCandidateChecker: authority.checker,
    compile(request, route) {
      const record = {
        epoch: request.descriptorValue.epoch,
        state: 'open',
        sends: [],
        rotate: false,
        unavailable: false,
        destroyAttempts: 0,
        destroyThrows: false
      }
      records.push(record)
      return Object.freeze({
        sendDatagram(payload) {
          if (record.state !== 'open') throw new Error('not open')
          record.sends.push(['datagram', payload])
          if (record.unavailable) throw new PrivateRouteError('ROUTE_UNAVAILABLE')
          if (record.rotate) {
            record.rotate = false
            request.requestReplacement('rotation')
          }
        },
        sendStreamFrame(payload) {
          if (record.state !== 'open') throw new Error('not open')
          record.sends.push(['stream', payload])
          if (record.unavailable) throw new PrivateRouteError('ROUTE_UNAVAILABLE')
          if (record.rotate) {
            record.rotate = false
            request.requestReplacement('rotation')
          }
        },
        drain() {
          if (record.state !== 'open') throw new Error('not open')
          record.state = 'draining'
        },
        destroy() {
          record.destroyAttempts++
          record.state = 'destroyed'
          if (record.destroyThrows) throw new Error('destroy failed')
          route.destroy()
        }
      })
    }
  })
  return { ...f, records }
}

function same(left, right) {
  return b4a.isBuffer(left) && b4a.isBuffer(right) && b4a.equals(left, right)
}

function sequenceBytes(start = 1) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

function clearTicketState(state) {
  if (!state) return
  for (const name of ['circuitId', 'localIdentity', 'peerIdentity', 'localId', 'peerLocalId']) {
    if (b4a.isBuffer(state[name])) state[name].fill(0)
  }
  for (const pair of Object.values(state.contexts || {})) {
    for (const context of [pair.tx, pair.rx]) {
      context.key.fill(0)
      context.noncePrefix.fill(0)
      context.counter.destroy()
    }
  }
}

function stateHasSecrets(state) {
  if (!state) return false
  for (const pair of Object.values(state.contexts || {})) {
    for (const context of [pair.tx, pair.rx]) {
      if (context.key.some((byte) => byte !== 0)) return true
      if (context.noncePrefix.some((byte) => byte !== 0)) return true
    }
  }
  return false
}

function realSafetyFixture({ failInstall = 0 } = {}) {
  const current = 1_000n
  const network = new VirtualNetwork({ now: Number(current) })
  const discovery = createDiscoveryEvidenceAuthority({ now: () => current })
  const circuit = createCircuitAuthority()
  const registry = new PrivacyDomainRegistry({
    evidenceChecker: discovery.checker,
    descriptorChecker: descriptorChecker(),
    circuitChecker: circuit.checker,
    now: () => current
  })
  const descriptor = verifiedDescriptor()
  const source = { identity: cryptoSuite.keyPair(seed(180)) }
  const guards = [1, 20].map((start, index) => {
    const identity = safetyRoleIdentity(start)
    const encryption = cryptoSuite.encryptionKeyPair(seed(181 + index))
    const advertisement = signRelayAdvertisement(
      {
        version: PROTOCOL_VERSION,
        identityKey: identity.publicKey,
        routeEncryptionKey: encryption.publicKey,
        dial: b4a.from(`real-link-guard-${index}`),
        role: ROLE.SAFETY,
        capabilities: CAPABILITY.KNOWN,
        epoch: 7n,
        expiresAt: 10_000n
      },
      identity.secretKey
    )
    return { identity, encryption, advertisement, name: `guard-${index}` }
  })
  const safety = guards.map(({ advertisement }) => {
    const encoded = encodeRelayAdvertisement(advertisement)
    const receipt = discovery.receiptIssuer.issue({
      advertisementHash32: cryptoSuite.hash(encoded),
      peerIdentity32: advertisement.identityKey,
      observedDial: advertisement.dial,
      observedAt: 999n,
      channel: PUBLIC_DHT
    })
    registry.learnPublic(discovery.verifier.verify(encoded, receipt))
    return encoded
  })
  const availableTickets = new Set()
  const cleanedStates = []
  const authority = createLinkSetupAuthority({
    now: () => Number(current),
    randomBytes: sequenceBytes(30),
    [TEST_ONLY_TICKET_OBSERVER](ticket) {
      availableTickets.add(ticket)
    }
  })
  const links = []
  const relays = []
  let sourceState = null
  let finalState = null
  let received = []
  let reverseReceived = []
  let rolledBack = false
  let installs = 0
  let forwardDelivery = null
  let reverseDelivery = null
  let installedRoute = null
  let compiledTranscriptHash = null

  network.register('source', (packet) => {
    if (!sourceState || !reverseDelivery) throw new Error('reverse endpoint is not installed')
    const values = openEndpoint(sourceState, packet[1], DIRECTION.REVERSE, packet)
    for (const value of values) reverseDelivery(value)
  })
  network.register('guard-0', (packet) => {
    const localId = packet.subarray(12, 28)
    const fromSource = same(localId, links[0].common.responderLocalId)
    relays[0].receive(fromSource ? source.identity.publicKey : guards[1].identity.publicKey, packet)
  })
  network.register('guard-1', (packet) => {
    if (!finalState || !forwardDelivery) throw new Error('final endpoint is not installed')
    const values = openEndpoint(finalState, packet[1], DIRECTION.FORWARD, packet)
    for (const value of values) forwardDelivery(value)
  })
  network.register('destination', () => {})

  function take(ticket) {
    availableTickets.delete(ticket)
    return authority.checker.take(ticket)
  }

  function openEndpoint(state, cellClass, direction, packet) {
    const context = state.contexts[cellClass].rx
    const opened = new CellCodec({
      crypto: cryptoSuite,
      cellSize: CELL_SIZE,
      padding: (size) => b4a.alloc(size)
    }).open(
      {
        key: context.key,
        noncePrefix: context.noncePrefix,
        receiver: context.counter,
        expectedClass: cellClass,
        expectedDirection: direction,
        expectedEpoch: state.epoch,
        expectedCircuitId: state.localId
      },
      packet
    )
    return Array.isArray(opened) ? opened : [opened]
  }

  function sealEndpoint(state, cellClass, direction, payload) {
    const context = state.contexts[cellClass].tx
    return new CellCodec({
      crypto: cryptoSuite,
      cellSize: CELL_SIZE,
      padding: (size) => b4a.alloc(size)
    }).seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: context.counter,
      class: cellClass,
      direction,
      epoch: state.epoch,
      circuitId: state.peerLocalId,
      payload
    })
  }

  function buildLink(index, binding) {
    const initiator = index === 0 ? source : guards[index - 1]
    const responder = guards[index]
    const common = {
      circuitId: binding.circuitId,
      epoch: binding.epoch,
      initiatorIdentity: initiator.identity.publicKey,
      responderIdentity: responder.identity.publicKey,
      initiatorLocalId: b4a.alloc(16, 0x40 + index * 2),
      responderLocalId: b4a.alloc(16, 0x41 + index * 2),
      expiresAt: binding.expiresAt
    }
    const started = authority.initiate({
      ...common,
      responderStaticKey: responder.encryption.publicKey,
      initiatorIdentitySecretKey: initiator.identity.secretKey
    })
    const accepted = authority.respond(started.message, {
      ...common,
      responderStaticSecretKey: responder.encryption.secretKey,
      responderIdentitySecretKey: responder.identity.secretKey
    })
    const createMessage = b4a.from(started.message)
    const createdMessage = b4a.from(accepted.message)
    return {
      common,
      createMessage,
      createdMessage,
      initiatorTicket: authority.complete(started.pending, accepted.message),
      responderTicket: accepted.ticket
    }
  }

  function rollback() {
    if (rolledBack) return
    rolledBack = true
    for (let index = relays.length - 1; index >= 0; index--) {
      try {
        relays[index].destroy(
          index === 0 ? source.identity.publicKey : guards[index - 1].identity.publicKey,
          links[index].common.responderLocalId
        )
      } catch {}
    }
    for (const ticket of [...availableTickets]) {
      try {
        const state = take(ticket)
        clearTicketState(state)
        cleanedStates.push(state)
      } catch {}
    }
    clearTicketState(sourceState)
    clearTicketState(finalState)
  }

  const circuitIssuer = {
    authenticate(value, binding) {
      const expected = guards[binding.index]
      if (!expected || !same(value.identityKey, expected.identity.publicKey)) {
        throw new Error('unexpected Safety identity')
      }
      if (binding.total !== guards.length) throw new Error('unexpected route size')
    },
    install(value, binding) {
      installs++
      if (installs === failInstall) throw new Error('injected install failure')
      const link = buildLink(binding.index, binding)
      links.push(link)
      if (binding.index === 0) return
      availableTickets.delete(links[0].responderTicket)
      availableTickets.delete(link.initiatorTicket)
      const relay = new RelayService({
        identity: guards[0].identity.publicKey,
        ticketChecker: authority.checker,
        crypto: cryptoSuite,
        now: () => Number(current),
        padding: (size) => b4a.alloc(size),
        send(peer, packet) {
          if (same(peer, source.identity.publicKey)) {
            network.send('guard-0', 'source', packet)
            return true
          }
          if (same(peer, guards[1].identity.publicKey)) {
            network.send('guard-0', 'guard-1', packet)
            return true
          }
          return false
        }
      })
      relay.install(links[0].responderTicket, link.initiatorTicket)
      relays.push(relay)
    },
    rollback,
    issueFinalSafety(value) {
      const context = circuit.issuer.issueFinalSafety(value)
      sourceState = take(links[0].initiatorTicket)
      finalState = take(links.at(-1).responderTicket)
      return context
    },
    finalize() {
      let live = true
      for (const relay of relays) {
        relay.created(source.identity.publicKey, links[0].common.responderLocalId)
        relay.open(source.identity.publicKey, links[0].common.responderLocalId)
      }
      const transcriptHash32 = cryptoSuite.hash(
        links.flatMap((link) => [link.createMessage, link.createdMessage])
      )
      installedRoute = {
        transcriptHash32,
        attachEntry() {
          return Object.freeze({})
        },
        sendControl(fragments, deliver) {
          let result
          for (const fragment of fragments) {
            forwardDelivery = (value) => {
              received.push(b4a.from(value))
              const delivered = deliver(value)
              if (delivered !== undefined) result = delivered
            }
            const packet = sealEndpoint(
              sourceState,
              CELL_CLASS.CONTROL,
              DIRECTION.FORWARD,
              fragment
            )
            network.send('source', 'guard-0', packet)
            network.flush()
            packet.fill(0)
          }
          forwardDelivery = null
          return result === undefined ? true : result
        },
        sendFrame(cellClass, frame, deliver) {
          forwardDelivery = deliver
          const packet = sealEndpoint(sourceState, cellClass, DIRECTION.FORWARD, frame)
          network.send('source', 'guard-0', packet)
          network.flush()
          packet.fill(0)
          forwardDelivery = null
          return true
        },
        sendReverseFrame(cellClass, frame, deliver) {
          reverseDelivery = deliver
          const packet = sealEndpoint(finalState, cellClass, DIRECTION.REVERSE, frame)
          network.send('guard-1', 'guard-0', packet)
          network.flush()
          packet.fill(0)
          reverseDelivery = null
          return true
        },
        destroy() {
          if (!live) return
          live = false
          rollback()
        }
      }
      return installedRoute
    }
  }
  const installerAuthority = createSafetyInstallerAuthority()
  const safetyInstaller = installerAuthority.issuer.issue(circuitIssuer)
  const compilerAuthority = createRouteCompilerAuthority()
  let compiledRequest = null
  const routeCompiler = compilerAuthority.issuer.issue((request) => {
    compiledRequest = request
    const route = installerAuthority.routeChecker.read(
      request.safetyRouteCapability,
      request.circuitContext
    )
    compiledTranscriptHash = b4a.from(route.transcriptHash32)
    return Object.freeze({
      sendDatagram() {},
      sendStreamFrame() {},
      drain() {},
      destroy() {
        route.destroy()
      }
    })
  })
  const manager = new RouteManager({
    network,
    registry,
    crypto: cryptoSuite,
    clock: () => Number(current),
    descriptorChecker: descriptorChecker(),
    circuitIssuer: Object.freeze({
      issueFinalSafety(value) {
        return circuitIssuer.issueFinalSafety(value)
      }
    }),
    safetyInstaller,
    safetyInstallerChecker: installerAuthority.checker,
    safetyRouteChecker: installerAuthority.routeChecker,
    routeCompiler,
    routeCompilerChecker: compilerAuthority.checker,
    limits: { maxSafetyHops: 3 }
  })

  return {
    circuit,
    cleanedStates,
    descriptor,
    guards,
    manager,
    network,
    relays,
    safety,
    get compiledRequest() {
      return compiledRequest
    },
    get received() {
      return received
    },
    get reverseReceived() {
      return reverseReceived
    },
    get compiledTranscriptHash() {
      return compiledTranscriptHash
    },
    get installedTranscriptHash() {
      return cryptoSuite.hash(links.flatMap((link) => [link.createMessage, link.createdMessage]))
    },
    get rolledBack() {
      return rolledBack
    },
    send(payload) {
      installedRoute.sendControl([payload], () => true)
    },
    sendFrame(cellClass, payload) {
      installedRoute.sendFrame(cellClass, payload, (value) => {
        received.push(b4a.from(value))
        return true
      })
    },
    sendReverseFrame(cellClass, payload) {
      installedRoute.sendReverseFrame(cellClass, payload, (value) => {
        reverseReceived.push(b4a.from(value))
        return true
      })
    },
    destroy: rollback
  }
}

test('Safety Route accepts direct and endpoint-delegated descriptors', (t) => {
  for (const delegated of [false, true]) {
    const f = fixture({ descriptor: verifiedDescriptor({ delegated }) })
    f.manager.open({
      safety: f.safety.slice(0, 2),
      descriptor: f.descriptor.verified
    })
    t.ok(f.compiledRequest.circuitContext)
  }
})

test('Safety installer mints an exact-context opaque route capability only at finalize', (t) => {
  const safety = createSafetyInstallerAuthority()
  const context = Object.freeze({})
  const otherContext = Object.freeze({})
  const transcriptHash32 = seed(251)
  const calls = []
  const installer = safety.issuer.issue({
    authenticate() {},
    install() {},
    rollback() {},
    finalize(value) {
      t.is(value, context)
      return {
        transcriptHash32,
        attachEntry(value) {
          calls.push(['attach', value])
          return Object.freeze({ attached: true })
        },
        sendControl(value) {
          calls.push(['control', value])
          return true
        },
        sendFrame(value) {
          calls.push(['frame', value])
          return true
        },
        sendReverseFrame(value) {
          calls.push(['reverse', value])
          return true
        },
        destroy() {
          calls.push(['destroy'])
        }
      }
    }
  })

  const capability = safety.checker.finalize(installer, context)
  t.alike(Object.keys(capability), [])
  const route = safety.routeChecker.read(capability, context)
  t.not(route.transcriptHash32, transcriptHash32)
  t.alike(route.transcriptHash32, transcriptHash32)
  const entry = Object.freeze({})
  t.alike(route.attachEntry(entry), { attached: true })
  t.is(route.sendControl(b4a.from('control')), true)
  t.is(route.sendFrame(b4a.from('frame')), true)
  t.is(route.sendReverseFrame(b4a.from('reverse')), true)
  route.destroy()
  t.alike(
    calls.map(([name]) => name),
    ['attach', 'control', 'frame', 'reverse', 'destroy']
  )
  expectCode(t, () => safety.routeChecker.read(capability, context), 'UNAUTHORIZED')
  expectCode(t, () => safety.routeChecker.read(capability, otherContext), 'UNAUTHORIZED')
  expectCode(t, () => safety.routeChecker.read(Object.freeze({}), context), 'UNAUTHORIZED')
})

test('public authorities construct RouteManager without link powers on the circuit issuer', (t) => {
  const f = fixture()
  const circuit = createCircuitAuthority()
  const compiler = createRouteCompilerAuthority()
  const safety = createSafetyInstallerAuthority()
  const installer = safety.issuer.issue({
    authenticate() {},
    install() {},
    rollback() {},
    finalize() {
      return inertInstalledSafetyRoute()
    }
  })
  const capability = compiler.issuer.issue(() =>
    Object.freeze({
      sendDatagram() {},
      sendStreamFrame() {},
      drain() {},
      destroy() {}
    })
  )

  const manager = new RouteManager({
    network: f.network,
    registry: {
      allows() {
        return true
      }
    },
    crypto: cryptoSuite,
    clock: () => 1_000,
    descriptorChecker: descriptorChecker(),
    circuitIssuer: circuit.issuer,
    safetyInstaller: installer,
    safetyInstallerChecker: safety.checker,
    safetyRouteChecker: safety.routeChecker,
    routeCompiler: capability,
    routeCompilerChecker: compiler.checker,
    limits: { maxSafetyHops: 3 }
  })

  t.ok(manager)
  t.alike(Object.keys(circuit.issuer), ['issueFinalSafety'])
  expectCode(
    t,
    () =>
      new RouteManager({
        network: f.network,
        registry: { allows: () => true },
        crypto: cryptoSuite,
        clock: () => 1_000,
        descriptorChecker: descriptorChecker(),
        circuitIssuer: circuit.issuer,
        safetyInstaller: installer,
        safetyInstallerChecker: safety.checker,
        safetyRouteChecker: safety.routeChecker,
        limits: { maxSafetyHops: 3 }
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      new RouteManager({
        network: f.network,
        registry: { allows: () => true },
        crypto: cryptoSuite,
        clock: () => 1_000,
        descriptorChecker: descriptorChecker(),
        circuitIssuer: circuit.issuer,
        safetyInstaller: installer,
        safetyInstallerChecker: { authenticate() {}, install() {}, rollback() {} },
        safetyRouteChecker: safety.routeChecker,
        routeCompiler: capability,
        routeCompilerChecker: compiler.checker,
        limits: { maxSafetyHops: 3 }
      }),
    'INVALID_ROUTE'
  )
})

test('Safety Route validates the complete path before installing any binding', (t) => {
  const f = fixture()
  const forged = b4a.from(f.safety[1])
  forged[forged.byteLength - 1] ^= 1

  expectCode(
    t,
    () =>
      f.manager.open({
        safety: [f.safety[0], forged],
        descriptor: f.descriptor.verified
      }),
    'UNAUTHORIZED'
  )
  t.alike(
    f.calls.filter(([name]) => name === 'authenticate' || name === 'install'),
    []
  )
  t.is(
    f.calls.some(([name]) => name === 'issue'),
    false
  )
})

test('Safety Route installs every authenticated binding before issuing capability', (t) => {
  const f = fixture()
  const opened = f.manager.open({
    safety: f.safety.slice(0, 2),
    descriptor: f.descriptor.verified
  })

  t.ok(f.compiledRequest.circuitContext)
  t.alike(Object.keys(f.compiledRequest).sort(), [
    'circuitContext',
    'circuitId',
    'descriptorValue',
    'requestReplacement',
    'safetyRouteCapability'
  ])
  t.is(typeof f.compiledRequest.requestReplacement, 'function')
  t.alike(
    f.calls
      .filter(
        ([name]) =>
          name === 'authenticate' || name === 'install' || name === 'issue' || name === 'finalize'
      )
      .map(([name]) => name),
    ['authenticate', 'install', 'authenticate', 'install', 'issue', 'finalize']
  )
  t.is(f.manager.directFallback, undefined)
  t.is(
    f.network
      .edges()
      .some(
        ([from, to]) =>
          (from === 'source' && to === 'destination') || (from === 'destination' && to === 'source')
      ),
    false
  )
  t.alike(Object.keys(opened).sort(), ['destroy', 'drain', 'sendDatagram', 'sendStreamFrame'])
})

test('Safety selection proves public discovery and directly dials only the guard', (t) => {
  const f = fixture()
  f.manager.open({
    safety: f.safety.slice(0, 2),
    descriptor: f.descriptor.verified
  })

  t.alike(
    f.calls
      .filter(([name]) => name === 'allows')
      .map(([, , operation, context]) => [operation, context]),
    [
      ['public-return', { consumer: 'relay-discovery' }],
      ['guard-dial', { selectedGuard: true }],
      ['public-return', { consumer: 'relay-discovery' }]
    ]
  )
})

test('Safety selection uses real discovery provenance and a branded circuit capability', (t) => {
  const current = 1_000n
  const discovery = createDiscoveryEvidenceAuthority({ now: () => current })
  const circuit = createCircuitAuthority()
  const registry = new PrivacyDomainRegistry({
    evidenceChecker: discovery.checker,
    descriptorChecker: descriptorChecker(),
    circuitChecker: circuit.checker,
    now: () => current
  })
  const descriptor = verifiedDescriptor()
  const guards = [safetyRoleIdentity(1), safetyRoleIdentity(20)]
  const safety = guards.map((identity, index) => {
    const encoded = encodeRelayAdvertisement(advertisement(identity, `real-guard-${index}`))
    const decoded = advertisement(identity, `real-guard-${index}`)
    const receipt = discovery.receiptIssuer.issue({
      advertisementHash32: cryptoSuite.hash(encoded),
      peerIdentity32: decoded.identityKey,
      observedDial: decoded.dial,
      observedAt: 999n,
      channel: PUBLIC_DHT
    })
    registry.learnPublic(discovery.verifier.verify(encoded, receipt))
    return encoded
  })
  const issuer = {
    authenticate() {},
    install() {},
    rollback() {},
    finalize() {
      return inertInstalledSafetyRoute()
    },
    issueFinalSafety(value) {
      return circuit.issuer.issueFinalSafety(value)
    }
  }
  const installerAuthority = createSafetyInstallerAuthority()
  const safetyInstaller = installerAuthority.issuer.issue(issuer)
  const compilerAuthority = createRouteCompilerAuthority()
  let compiledContext = null
  const routeCompiler = compilerAuthority.issuer.issue((request) => {
    compiledContext = request.circuitContext
    return Object.freeze({
      sendDatagram() {},
      sendStreamFrame() {},
      drain() {},
      destroy() {}
    })
  })
  const network = new VirtualNetwork({ now: Number(current) })
  const manager = new RouteManager({
    network,
    registry,
    crypto: cryptoSuite,
    clock: () => Number(current),
    descriptorChecker: descriptorChecker(),
    circuitIssuer: circuit.issuer,
    safetyInstaller,
    safetyInstallerChecker: installerAuthority.checker,
    safetyRouteChecker: installerAuthority.routeChecker,
    routeCompiler,
    routeCompilerChecker: compilerAuthority.checker,
    limits: { maxSafetyHops: 3 }
  })

  manager.open({ safety, descriptor: descriptor.verified })
  const context = circuit.checker.read(compiledContext)
  t.alike(context.finalSafetyIdentity32, guards[1].publicKey)
  t.alike(context.entryIdentity32, descriptor.entry.publicKey)
  t.is(context.epoch, 7n)
})

test('Safety Route installs real Task 10 links and forwards an authenticated fixed cell', (t) => {
  const f = realSafetyFixture()
  f.manager.open({
    safety: f.safety,
    descriptor: f.descriptor.verified
  })
  const context = f.circuit.checker.read(f.compiledRequest.circuitContext)
  const payload = b4a.from('authenticated Safety control')
  const stream = b4a.alloc(1100, 0x31)
  const datagram = b4a.alloc(1100, 0x32)
  const reverse = b4a.alloc(1100, 0x33)

  f.send(payload)
  f.sendFrame(CELL_CLASS.STREAM, stream)
  f.sendFrame(CELL_CLASS.DATAGRAM, datagram)
  f.sendReverseFrame(CELL_CLASS.STREAM, reverse)

  t.alike(f.received, [payload, stream, datagram])
  t.alike(f.reverseReceived, [reverse])
  t.alike(f.compiledTranscriptHash, f.installedTranscriptHash)
  t.not(
    b4a.toString(f.compiledTranscriptHash, 'hex'),
    b4a.toString(cryptoSuite.hash(f.guards.map((guard) => guard.identity.publicKey)), 'hex')
  )
  t.alike(f.network.edges(), [
    ['source', 'guard-0'],
    ['guard-0', 'guard-1'],
    ['guard-1', 'guard-0'],
    ['guard-0', 'source']
  ])
  t.ok(f.network.view('source').every((event) => event.byteLength === CELL_SIZE))
  t.ok(f.network.view('guard-0').every((event) => event.byteLength === CELL_SIZE))
  t.is(
    f.network
      .edges()
      .some(
        ([from, to]) =>
          (from === 'source' && to === 'destination') || (from === 'destination' && to === 'source')
      ),
    false
  )
  t.alike(context.finalSafetyIdentity32, f.guards[1].identity.publicKey)
  t.is(f.relays[0].activeCircuits, 1)
  f.destroy()
  t.is(f.relays[0].activeCircuits, 0)
  t.is(f.relays[0].queuedBytes, 0)
})

test('real partial Safety setup rolls back tickets and never issues capability', (t) => {
  const f = realSafetyFixture({ failInstall: 2 })

  t.exception(() => f.manager.open({ safety: f.safety, descriptor: f.descriptor.verified }))
  t.is(f.rolledBack, true)
  t.is(f.relays.length, 0)
  t.ok(f.cleanedStates.length > 0)
  t.ok(f.cleanedStates.every((state) => !stateHasSecrets(state)))
  t.alike(f.network.edges(), [])
})

test('Safety Route requires one to three Safety hops', (t) => {
  const empty = fixture()
  expectCode(
    t,
    () => empty.manager.open({ safety: [], descriptor: empty.descriptor.verified }),
    'INVALID_ROUTE'
  )
  const overflow = fixture()
  expectCode(
    t,
    () =>
      overflow.manager.open({
        safety: [...overflow.safety, overflow.safety[0]],
        descriptor: overflow.descriptor.verified
      }),
    'INVALID_ROUTE'
  )
})

test('Safety Route rejects duplicate relay identities', (t) => {
  const f = fixture()
  expectCode(
    t,
    () =>
      f.manager.open({
        safety: [f.safety[0], f.safety[0]],
        descriptor: f.descriptor.verified
      }),
    'INVALID_ROUTE'
  )
})

test('Safety Route rejects duplicate relay dials', (t) => {
  const f = fixture()
  const duplicateDial = encodeRelayAdvertisement(advertisement(f.guards[1], 'guard-0'))
  expectCode(
    t,
    () =>
      f.manager.open({
        safety: [f.safety[0], duplicateDial],
        descriptor: f.descriptor.verified
      }),
    'INVALID_ROUTE'
  )
})

test('Safety Route rejects a correctly signed non-Safety role', (t) => {
  const f = fixture()
  const privateRelay = privateRoleIdentity(20)
  const signedPrivate = encodeRelayAdvertisement(
    advertisement(privateRelay, 'private', { role: ROLE.PRIVATE })
  )
  expectCode(
    t,
    () =>
      f.manager.open({
        safety: [signedPrivate],
        descriptor: f.descriptor.verified
      }),
    'INVALID_ROUTE'
  )
})

test('Safety Route rejects expired relays and descriptors', (t) => {
  const expiredRelay = fixture()
  const relay = encodeRelayAdvertisement(
    advertisement(expiredRelay.guards[0], 'expired', { expiresAt: 1_000n })
  )
  expectCode(
    t,
    () =>
      expiredRelay.manager.open({
        safety: [relay],
        descriptor: expiredRelay.descriptor.verified
      }),
    'INVALID_ROUTE'
  )

  const f = fixture()
  const expiredDescriptor = verifiedDescriptor({
    expiresAt: 1_000n,
    verifyNow: 999n
  }).verified
  expectCode(
    t,
    () => f.manager.open({ safety: [f.safety[0]], descriptor: expiredDescriptor }),
    'INVALID_ROUTE'
  )
})

test('Safety Route rejects descriptor entry identity and dial conflicts', (t) => {
  const identity = fixture()
  const entryIdentity = encodeRelayAdvertisement(
    advertisement(identity.descriptor.entry, 'conflict', { role: ROLE.SAFETY })
  )
  expectCode(
    t,
    () =>
      identity.manager.open({
        safety: [entryIdentity],
        descriptor: identity.descriptor.verified
      }),
    'INVALID_ROUTE'
  )

  const dial = fixture()
  const entryDial = encodeRelayAdvertisement(advertisement(dial.guards[0], 'entry'))
  expectCode(
    t,
    () =>
      dial.manager.open({
        safety: [entryDial],
        descriptor: dial.descriptor.verified
      }),
    'INVALID_ROUTE'
  )
})

test('Safety Route rejects unbranded descriptors and forged descriptor checkers', (t) => {
  const f = fixture()
  expectCode(
    t,
    () => f.manager.open({ safety: [f.safety[0]], descriptor: Object.freeze({}) }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      new RouteManager({
        network: f.network,
        registry: {
          allows() {
            return true
          }
        },
        crypto: cryptoSuite,
        clock: () => 1_000,
        descriptorChecker: {
          isVerified() {
            return true
          },
          read() {
            return {}
          }
        },
        circuitIssuer: f.circuitIssuer,
        safetyInstaller: f.safetyInstaller,
        safetyInstallerChecker: f.safetyInstallerChecker,
        limits: { maxSafetyHops: 3 }
      }),
    'INVALID_ROUTE'
  )
})

test('Safety Route fails closed when the privacy domain denies selection', (t) => {
  const f = fixture({
    registry: {
      allows() {
        return false
      }
    }
  })
  expectCode(
    t,
    () => f.manager.open({ safety: [f.safety[0]], descriptor: f.descriptor.verified }),
    'UNAUTHORIZED'
  )
  t.is(
    f.calls.some(([name]) => name === 'issue'),
    false
  )
})

test('partial Safety installation never receives route-entry capability', (t) => {
  const calls = []
  const circuitIssuer = {
    authenticate(value) {
      calls.push(['authenticate', value])
    },
    install(value) {
      calls.push(['install', value])
      if (calls.filter(([name]) => name === 'install').length === 2) {
        throw new Error('install failed')
      }
    },
    rollback() {
      calls.push(['rollback'])
    },
    finalize() {
      return inertInstalledSafetyRoute()
    },
    issueFinalSafety(value) {
      calls.push(['issue', value])
      return Object.freeze({})
    }
  }
  const f = fixture({ circuitIssuer })

  t.exception(() =>
    f.manager.open({ safety: f.safety.slice(0, 2), descriptor: f.descriptor.verified })
  )
  t.is(
    calls.some(([name]) => name === 'issue'),
    false
  )
  t.alike(calls.at(-1), ['rollback'])
})

test('route candidate authority is branded, one-shot per increasing epoch, and immutable', (t) => {
  const authority = createRouteCandidateAuthority()
  const calls = []
  let capability = null
  capability = authority.issuer.issue({
    next(currentEpoch, reason) {
      calls.push([currentEpoch, reason])
      expectCode(
        t,
        () => authority.checker.next(capability, currentEpoch + 1n, reason),
        'UNAUTHORIZED'
      )
      return { descriptor: Object.freeze({ epoch: currentEpoch + 1n }), safety: [seed(1)] }
    }
  })

  const first = authority.checker.next(capability, 7n, 'rotation')
  t.alike(calls, [[7n, 'rotation']])
  t.ok(Object.isFrozen(first))
  t.ok(Object.isFrozen(first.safety))
  expectCode(t, () => authority.checker.next(capability, 7n, 'relay-loss'), 'UNAUTHORIZED')
  authority.checker.next(capability, 8n, 'relay-loss')
  t.alike(calls.at(-1), [8n, 'relay-loss'])
  expectCode(t, () => authority.checker.next({ ...capability }, 9n, 'rotation'), 'UNAUTHORIZED')
  expectCode(t, () => authority.checker.next(capability, 9n, 'other'), 'UNAUTHORIZED')
  expectCode(t, () => authority.issuer.issue({ next() {}, extra: true }), 'INVALID_ROUTE')
})

test('route candidate authority rejects malformed provider results', (t) => {
  for (const value of [
    null,
    {},
    { descriptor: {}, safety: [] },
    { descriptor: {}, safety: [1, 2, 3, 4] },
    { descriptor: {}, safety: [1], extra: true }
  ]) {
    const authority = createRouteCandidateAuthority()
    const capability = authority.issuer.issue({ next: () => value })
    expectCode(t, () => authority.checker.next(capability, 7n, 'rotation'), 'INVALID_ROUTE')
  }
})

test('rotation replaces at a higher epoch while retaining at most one draining generation', (t) => {
  const providerCalls = []
  const f = replacementFixture((currentEpoch, reason) => {
    providerCalls.push([currentEpoch, reason])
    return candidate(currentEpoch + 1n)
  })
  const route = f.manager.open({
    descriptor: f.descriptor.verified,
    safety: f.safety.slice(0, 2)
  })

  f.records[0].rotate = true
  route.sendStreamFrame(b4a.from('rotate-seven'))
  t.alike(providerCalls, [[7n, 'rotation']])
  t.alike(
    f.records.map(({ epoch, state }) => [epoch, state]),
    [
      [7n, 'draining'],
      [8n, 'open']
    ]
  )
  t.is(f.records[1].sends.length, 0)
  route.sendDatagram(b4a.from('new-generation'))
  t.is(f.records[1].sends.length, 1)

  f.records[1].rotate = true
  route.sendStreamFrame(b4a.from('rotate-eight'))
  t.alike(
    f.records.map(({ epoch, state }) => [epoch, state]),
    [
      [7n, 'destroyed'],
      [8n, 'draining'],
      [9n, 'open']
    ]
  )
  t.alike(Object.keys(route).sort(), ['destroy', 'drain', 'sendDatagram', 'sendStreamFrame'])
  t.is(f.manager.directFallback, undefined)

  route.drain()
  t.alike(
    f.records.map(({ epoch, state }) => [epoch, state]),
    [
      [7n, 'destroyed'],
      [8n, 'destroyed'],
      [9n, 'draining']
    ]
  )
  expectCode(t, () => route.sendDatagram(b4a.from('forward closed')), 'CIRCUIT_STATE')
})

test('relay loss makes one replacement attempt without resending the failed payload', (t) => {
  const providerCalls = []
  const f = replacementFixture((currentEpoch, reason) => {
    providerCalls.push([currentEpoch, reason])
    return candidate(currentEpoch + 1n)
  })
  const route = f.manager.open({
    descriptor: f.descriptor.verified,
    safety: f.safety.slice(0, 2)
  })
  const failed = b4a.from('do-not-resend')
  f.records[0].unavailable = true

  expectCode(t, () => route.sendStreamFrame(failed), 'ROUTE_UNAVAILABLE')
  t.alike(providerCalls, [[7n, 'relay-loss']])
  t.is(f.records[0].state, 'destroyed')
  t.is(f.records[0].sends.length, 1)
  t.is(f.records[1].sends.length, 0)
  route.sendStreamFrame(b4a.from('caller-retries-explicitly'))
  t.is(f.records[1].sends.length, 1)

  f.records[1].unavailable = true
  expectCode(t, () => route.sendDatagram(b4a.from('second-loss')), 'ROUTE_UNAVAILABLE')
  t.is(providerCalls.length, 1)
  t.ok(f.records.every(({ state }) => state === 'destroyed'))
  expectCode(t, () => route.sendDatagram(b4a.from('closed')), 'CIRCUIT_STATE')
})

test('invalid replacement epoch destroys every generation and fails closed', (t) => {
  const f = replacementFixture((currentEpoch) => candidate(currentEpoch))
  const route = f.manager.open({
    descriptor: f.descriptor.verified,
    safety: f.safety.slice(0, 2)
  })
  f.records[0].rotate = true

  expectCode(t, () => route.sendStreamFrame(b4a.from('rotate')), 'ROUTE_UNAVAILABLE')
  t.alike(
    f.records.map(({ epoch, state }) => [epoch, state]),
    [[7n, 'destroyed']]
  )
  expectCode(t, () => route.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
})

test('replacement destroy failure tears down the stale, previous, and new generations once', (t) => {
  const f = replacementFixture((currentEpoch) => candidate(currentEpoch + 1n))
  const route = f.manager.open({
    descriptor: f.descriptor.verified,
    safety: f.safety.slice(0, 2)
  })

  f.records[0].rotate = true
  route.sendStreamFrame(b4a.from('first rotation'))
  f.records[0].destroyThrows = true
  f.records[1].rotate = true

  expectCode(t, () => route.sendStreamFrame(b4a.from('second rotation')), 'ROUTE_UNAVAILABLE')
  t.alike(
    f.records.map(({ epoch, state, destroyAttempts }) => [epoch, state, destroyAttempts]),
    [
      [7n, 'destroyed', 1],
      [8n, 'destroyed', 1],
      [9n, 'destroyed', 1]
    ]
  )
  expectCode(t, () => route.sendDatagram(b4a.from('closed')), 'CIRCUIT_STATE')
  route.destroy()
  t.alike(
    f.records.map(({ destroyAttempts }) => destroyAttempts),
    [1, 1, 1]
  )
})

test('relay-loss previous destroy failure also tears down the replacement once', (t) => {
  const f = replacementFixture((currentEpoch) => candidate(currentEpoch + 1n))
  const route = f.manager.open({
    descriptor: f.descriptor.verified,
    safety: f.safety.slice(0, 2)
  })

  f.records[0].unavailable = true
  f.records[0].destroyThrows = true

  expectCode(t, () => route.sendStreamFrame(b4a.from('lost relay')), 'ROUTE_UNAVAILABLE')
  t.alike(
    f.records.map(({ epoch, state, destroyAttempts }) => [epoch, state, destroyAttempts]),
    [
      [7n, 'destroyed', 1],
      [8n, 'destroyed', 1]
    ]
  )
  expectCode(t, () => route.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
  route.destroy()
  t.alike(
    f.records.map(({ destroyAttempts }) => destroyAttempts),
    [1, 1]
  )
})
