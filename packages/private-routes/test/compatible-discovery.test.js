import test from 'brittle'
import b4a from 'b4a'

import {
  BootstrapIO,
  BRANCH_CLASS,
  CAPACITY_CLASS,
  CapsResponder,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  CompatibleDiscovery,
  RelayCapabilityDirectory,
  consumeBootstrapGuardLink,
  cryptoSuite,
  deriveM3DhtNodeId,
  decodeM3Object,
  encodeCanonicalEndpoint,
  encodeM3Object,
  encodeRelayCapabilityAdvertisement,
  providerServicePolicyForCapabilities,
  signRelayCapabilityAdvertisement,
  selectDiverseRelayCapabilities
} from '../index.js'
import {
  createIndexZeroGuardLinkResponder,
  destroyM3EstablishedLink,
  readM3EstablishedLink
} from '../lib/guard-link.js'
import { expectCode, seed } from './helpers.js'

const CAPS_RESPONSE_DOMAIN = b4a.from('hyperdht-private-routes/m3/caps-response/v1')

function writeU64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function capsSignatureInput(body) {
  const output = b4a.allocUnsafe(2 + CAPS_RESPONSE_DOMAIN.byteLength + 8 + body.byteLength)
  output.writeUInt16BE(CAPS_RESPONSE_DOMAIN.byteLength, 0)
  CAPS_RESPONSE_DOMAIN.copy(output, 2)
  output.writeUInt32BE(1, 2 + CAPS_RESPONSE_DOMAIN.byteLength)
  output.writeUInt16BE(M3_MESSAGE_ID.CAPS_RESPONSE_V1, 6 + CAPS_RESPONSE_DOMAIN.byteLength)
  output.writeUInt16BE(body.byteLength, 8 + CAPS_RESPONSE_DOMAIN.byteLength)
  body.copy(output, 10 + CAPS_RESPONSE_DOMAIN.byteLength)
  return output
}

function activeChallengeBytes(now = 1_000n) {
  const body = b4a.alloc(176)
  writeU64(body, now + 5_000n, 96)
  writeU64(body, now + 5_000n, 136)
  return encodeM3Object({ messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1, body })
}

function activeResponseBytes() {
  return encodeM3Object({
    messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1,
    body: b4a.alloc(272),
    authSuffix: b4a.alloc(64)
  })
}

function candidate(id, address = [192, 0, 2, id], dhtId = seed(id), capabilities = 1) {
  return Object.freeze({
    relayIdentity: seed(id),
    currentDhtNodeId: dhtId,
    reachableEndpoint: b4a.from([4, ...b4a.alloc(12), ...address, 0x12, id || 1]),
    capabilityMask: capabilities,
    capacityClass: 1,
    epoch: 1n,
    advertisement: b4a.from([id])
  })
}

function fakeDirectory() {
  const validated = new WeakSet()
  return {
    admit(advertisement, { observedEndpoint }) {
      return Object.freeze({ advertisement, observedEndpoint })
    },
    async validate(value, exchange) {
      const result = await exchange(value)
      if (!result) throw Object.assign(new Error('auth'), { code: 'ERR_AUTHENTICATION' })
      validated.add(result)
      return result
    },
    isValidated(value) {
      return validated.has(value)
    },
    read(value) {
      return value
    }
  }
}

function fakeIO({
  compatible = new Map(),
  legacy = [],
  challenges = new Map(),
  transfer = Object.freeze({})
} = {}) {
  const calls = []
  let destroyed = false
  return {
    calls,
    async capsQuery(endpoint) {
      calls.push(['caps', endpoint])
      return compatible.get(endpoint) || null
    },
    async legacyFindNode(endpoint) {
      calls.push(['legacy', endpoint])
      return legacy
    },
    async activeChallenge(endpoint, admitted) {
      calls.push(['challenge', endpoint])
      return challenges.get(endpoint) || null
    },
    async pinGuard(validated) {
      calls.push(['pin', validated])
      destroyed = true
      return transfer
    },
    destroy() {
      calls.push(['destroy'])
      destroyed = true
    },
    get destroyed() {
      return destroyed
    }
  }
}

function response(...entries) {
  return {
    advertisements: entries.map(({ endpoint, value }) => ({
      endpoint,
      advertisement: value.advertisement,
      validated: value
    }))
  }
}

test('compatible discovery rejects an external guard-link establishment callback', (t) => {
  expectCode(
    t,
    () =>
      new CompatibleDiscovery({
        bootstrapIO: fakeIO(),
        directory: fakeDirectory(),
        establishGuardLink: async () => Object.freeze({}),
        randomBytes: (size) => b4a.alloc(size),
        now: () => 1_000n
      }),
    'INVALID_ROUTE'
  )
})

function realAdvertisement() {
  const signer = cryptoSuite.keyPair(seed(91))
  const route = cryptoSuite.encryptionKeyPair(seed(92))
  const reachableEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 91]),
    port: 49737
  })
  const capabilityMask = RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  const signed = signRelayCapabilityAdvertisement(
    {
      relayIdentity: signer.publicKey,
      currentDhtNodeId: deriveM3DhtNodeId(reachableEndpoint),
      reachableEndpoint,
      routeEncryptionPublicKey: route.publicKey,
      capabilityMask,
      minimumProtocolVersion: 1,
      maximumProtocolVersion: 1,
      cellSize: 1200,
      maxCellPayload: 1146,
      contextEnvelopeSize: 1101,
      routeFrameSize: 1100,
      maxRoutePayload: 1073,
      datagramReplayWindow: 64,
      maxConcurrentCircuits: 8,
      capacityClass: CAPACITY_CLASS.SMALL,
      maxCellsPerCircuit: 100,
      maxBytesPerCircuit: 100_000,
      maxCommandsPerCircuit: 10,
      idleTimeoutMs: 30_000,
      maxQueuedBytes: 65_536,
      epoch: 1n,
      issuedAtMs: 1_000n,
      expiresAtMs: 20_000n,
      providerServicePolicyEntries: providerServicePolicyForCapabilities(capabilityMask)
    },
    signer.secretKey
  )
  return {
    encoded: encodeRelayCapabilityAdvertisement(signed),
    reachableEndpoint,
    route,
    signed,
    signer
  }
}

function compatibleWireSocket(fixture, sends, { legacyEndpoint = null, now = () => 1_000n } = {}) {
  const packets = []
  return {
    async bind() {},
    async send(endpoint, datagram) {
      const object = decodeM3Object(datagram)
      sends.push({ endpoint: b4a.from(endpoint), messageId: object.messageId })
      if (object.messageId === M3_MESSAGE_ID.CAPS_QUERY_V1) {
        if (legacyEndpoint && b4a.equals(endpoint, legacyEndpoint)) return
        if (object.body[69] === 0) {
          const body = b4a.alloc(72)
          object.body.subarray(36, 68).copy(body, 0)
          writeU64(body, now() + 5_000n, 32)
          seed(71).copy(body, 40)
          packets.push({
            sourceEndpoint: b4a.from(endpoint),
            datagram: encodeM3Object({
              messageId: M3_MESSAGE_ID.CAPS_COOKIE_CHALLENGE_V1,
              body
            })
          })
          return
        }
        const body = b4a.alloc(75 + fixture.encoded.byteLength)
        fixture.signer.publicKey.copy(body, 0)
        object.body.subarray(36, 68).copy(body, 32)
        writeU64(body, now(), 64)
        body[72] = 1
        body.writeUInt16BE(fixture.encoded.byteLength, 73)
        fixture.encoded.copy(body, 75)
        packets.push({
          sourceEndpoint: b4a.from(endpoint),
          datagram: encodeM3Object({
            messageId: M3_MESSAGE_ID.CAPS_RESPONSE_V1,
            body,
            authSuffix: cryptoSuite.sign(capsSignatureInput(body), fixture.signer.secretKey)
          })
        })
        return
      }
      if (object.messageId === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1) {
        packets.push({
          sourceEndpoint: b4a.from(endpoint),
          datagram: activeResponseBytes()
        })
      }
    },
    async legacyFindNode() {
      return [fixture.reachableEndpoint]
    },
    async receive() {
      if (packets.length > 0) return packets.shift()
      return new Promise(() => {})
    },
    abort() {},
    destroy() {}
  }
}

function productionWireSocket({
  responder,
  responderEndpoint,
  clientEndpoint,
  sends,
  legacyEndpoint = null
}) {
  const packets = []
  return {
    async bind() {},
    async send(endpoint, datagram) {
      const object = decodeM3Object(datagram)
      sends.push({
        endpoint: b4a.from(endpoint),
        datagram: b4a.from(datagram),
        messageId: object.messageId
      })
      if (legacyEndpoint && b4a.equals(endpoint, legacyEndpoint)) return
      if (!b4a.equals(endpoint, responderEndpoint)) throw new Error('unexpected direct endpoint')
      for (const response of responder.receive(datagram, clientEndpoint)) {
        packets.push({
          sourceEndpoint: b4a.from(responderEndpoint),
          datagram: response
        })
      }
    },
    async legacyFindNode() {
      return [b4a.from(responderEndpoint)]
    },
    async receive() {
      if (packets.length > 0) return packets.shift()
      return new Promise(() => {})
    },
    abort() {},
    destroy() {}
  }
}

function realDirectory({ now, randomByte }) {
  let value = randomByte
  return new RelayCapabilityDirectory({
    now,
    randomBytes: (size) => b4a.alloc(size, value++),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  })
}

function realGuardFixture({ fixture, now, randomByte, predecessorEndpoint }) {
  const responderPhysical = Object.freeze({ destroy() {} })
  let clientPhysicalCloses = 0
  const clientPhysical = Object.freeze({
    destroy() {
      clientPhysicalCloses++
    }
  })
  let receivedOffer = null
  const responder = createIndexZeroGuardLinkResponder({
    advertisement: fixture.encoded,
    responderIdentitySecretKey: fixture.signer.secretKey,
    responderRouteEncryptionSecretKey: fixture.route.secretKey,
    now,
    randomBytes: (size) => b4a.alloc(size, randomByte),
    receiveOffer: () => ({
      offer: receivedOffer,
      observedPredecessorEndpoint: predecessorEndpoint,
      physicalChannel: responderPhysical
    })
  })
  let responderEstablished = null
  return {
    responder,
    get responderEstablished() {
      return responderEstablished
    },
    get clientPhysicalCloses() {
      return clientPhysicalCloses
    },
    factory: {
      async openGuard() {
        receivedOffer = null
        return {
          async sendOffer(value) {
            receivedOffer = b4a.from(value)
          },
          async receiveAccept() {
            const accepted = responder.accept()
            responderEstablished = accepted.established
            return accepted.accept
          },
          takePhysicalChannel: () => clientPhysical,
          destroy() {}
        }
      }
    }
  }
}

function fakeClock(start = 1_000n) {
  let current = start
  let next = 0
  const timers = new Map()
  return {
    now: () => current,
    setTimeout(callback, delay) {
      const id = ++next
      timers.set(id, { callback, expiresAt: current + BigInt(delay) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      current += BigInt(ms)
      for (const [id, timer] of timers) {
        if (timer.expiresAt <= current) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    suspendTo(value) {
      current = BigInt(value)
    }
  }
}

test('compatible bootstrap pins only an actively validated compatible guard', async (t) => {
  const guard = candidate(1)
  const transfer = Object.freeze({})
  const io = fakeIO({
    compatible: new Map([['bootstrap-a', response({ endpoint: 'bootstrap-a', value: guard })]]),
    challenges: new Map([['bootstrap-a', guard]]),
    transfer
  })
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    randomBytes: (size) => b4a.alloc(size, 7),
    now: () => 1_000n
  })
  const result = await discovery.discoverGuard({
    bootstraps: ['bootstrap-a'],
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  })

  t.is(result, transfer)
  t.ok(io.destroyed)
  t.alike(
    io.calls.map((call) => call[0]),
    ['caps', 'challenge', 'pin']
  )
  t.alike(discovery.counters, {
    publicProbeCount: 1,
    candidateRejectCount: 0,
    activeValidationCount: 1
  })
  t.is(discovery.diagnostics().state, 'completed')
  const callsBeforeSecondDiscover = io.calls.length
  let secondError = null
  try {
    await discovery.discoverGuard({
      bootstraps: ['bootstrap-a'],
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
    })
  } catch (err) {
    secondError = err
  }
  t.is(secondError && secondError.code, 'INVALID_ROUTE')
  t.is(io.calls.length, callsBeforeSecondDiscover)
})

test('compatible discovery erases per-probe randomness after awaited success and failure', async (t) => {
  for (const reject of [false, true]) {
    const queries = []
    const generated = []
    const io = {
      async capsQuery(_endpoint, query) {
        queries.push(query)
        if (reject) throw new Error('network failure')
        return null
      },
      destroy() {}
    }
    const discovery = new CompatibleDiscovery({
      bootstrapIO: io,
      directory: fakeDirectory(),
      allowLegacyDiscovery: false,
      randomBytes(size) {
        const value = b4a.alloc(size, reject ? 0x92 : 0x91)
        generated.push(value)
        return value
      },
      now: () => 1_000n
    })
    let error = null
    try {
      await discovery.discoverGuard({
        bootstraps: ['bootstrap'],
        requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
      })
    } catch (err) {
      error = err
    }
    t.is(error && error.code, 'ERR_PRIVACY_UNAVAILABLE')
    t.is(queries.length, 1)
    t.alike(queries[0].randomTarget, b4a.alloc(32))
    t.alike(queries[0].queryNonce, b4a.alloc(32))
    t.is(generated.length, 2)
    t.alike(generated[0], b4a.alloc(32))
    t.alike(generated[1], b4a.alloc(32))
  }
})

test('compatible discovery erases validated projections after pin success and failure', async (t) => {
  for (const reject of [false, true]) {
    const guard = candidate(reject ? 12 : 11)
    const validated = Object.freeze({})
    const queryNonce = b4a.alloc(32, reject ? 0xa2 : 0xa1)
    const returnRoutabilityCookie = b4a.alloc(32, reject ? 0xb2 : 0xb1)
    const transfer = Object.freeze({})
    const directory = {
      admit() {
        return Object.freeze({})
      },
      async validate(_value, exchange) {
        await exchange(Object.freeze({}))
        return validated
      },
      isValidated(value) {
        return value === validated
      },
      read() {
        return {
          capabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
          queryNonce,
          returnRoutabilityCookie
        }
      }
    }
    const io = {
      async capsQuery() {
        return response({ endpoint: 'bootstrap', value: guard })
      },
      async activeChallenge() {
        return Object.freeze({})
      },
      async pinGuard() {
        t.alike(queryNonce, b4a.alloc(32, reject ? 0xa2 : 0xa1))
        t.alike(returnRoutabilityCookie, b4a.alloc(32, reject ? 0xb2 : 0xb1))
        if (reject) throw new Error('pin failed')
        return transfer
      },
      destroy() {}
    }
    const discovery = new CompatibleDiscovery({
      bootstrapIO: io,
      directory,
      allowLegacyDiscovery: false,
      randomBytes: (size) => b4a.alloc(size, 0xc1),
      now: () => 1_000n
    })
    let result = null
    let error = null
    try {
      result = await discovery.discoverGuard({
        bootstraps: ['bootstrap'],
        requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
      })
    } catch (err) {
      error = err
    }
    if (reject) t.is(error && error.code, 'ERR_PRIVACY_UNAVAILABLE')
    else t.is(result, transfer)
    t.alike(queryNonce, b4a.alloc(32))
    t.alike(returnRoutabilityCookie, b4a.alloc(32))
  }
})

test('legacy-only cold start uses one non-iterative FIND_NODE and one global three-challenge budget', async (t) => {
  const candidates = [candidate(1), candidate(2), candidate(3), candidate(4)]
  const transfer = Object.freeze({})
  const compatible = new Map()
  const challenges = new Map()
  for (let index = 0; index < candidates.length; index++) {
    const endpoint = `referral-${index}`
    compatible.set(endpoint, response({ endpoint, value: candidates[index] }))
    if (index === 2) challenges.set(endpoint, candidates[index])
  }
  const io = fakeIO({
    compatible,
    legacy: [...compatible.keys()],
    challenges,
    transfer
  })
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    randomBytes: (size) => b4a.alloc(size, 8),
    now: () => 1_000n
  })
  const result = await discovery.discoverGuard({
    bootstraps: ['legacy-bootstrap', 'unused-bootstrap'],
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  })

  t.is(result, transfer)
  t.is(io.calls.filter((call) => call[0] === 'legacy').length, 1)
  t.is(io.calls.filter((call) => call[0] === 'challenge').length, 3)
  t.absent(io.calls.some((call) => call[1] === 'referral-3'))
  t.is(discovery.counters.activeValidationCount, 3)
})

test('compatible and legacy referral sources share one challenge budget and cannot force an extra probe', async (t) => {
  const referrals = Array.from({ length: 8 }, (_, index) => candidate(index + 1))
  const entries = referrals.map((value, index) => ({ endpoint: `r-${index}`, value }))
  const compatible = new Map([['bootstrap', response(...entries)]])
  for (const entry of entries) compatible.set(entry.endpoint, response(entry))
  const io = fakeIO({ compatible, legacy: ['evil-extra'] })
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    randomBytes: (size) => b4a.alloc(size, 9),
    now: () => 1_000n
  })

  await t.exception(
    discovery.discoverGuard({
      bootstraps: ['bootstrap'],
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
    }),
    'fails closed'
  )
  t.is(io.calls.filter((call) => call[0] === 'challenge').length, 3)
  t.is(io.calls.filter((call) => call[0] === 'legacy').length, 0)
  t.absent(io.calls.some((call) => call[1] === 'evil-extra'))
})

test('cold start contacts at most three bootstraps and deduplicates referral endpoints and identities', async (t) => {
  const duplicate = candidate(9)
  const compatible = new Map([
    [
      'bootstrap-0',
      response(
        { endpoint: 'same-referral', value: duplicate },
        { endpoint: 'same-referral', value: duplicate },
        { endpoint: 'other-endpoint', value: duplicate }
      )
    ],
    ['same-referral', response({ endpoint: 'same-referral', value: duplicate })]
  ])
  const io = fakeIO({ compatible })
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    allowLegacyDiscovery: false,
    randomBytes: (size) => b4a.alloc(size, 9),
    now: () => 1_000n
  })

  try {
    await discovery.discoverGuard({
      bootstraps: ['bootstrap-0', 'bootstrap-1', 'bootstrap-2', 'bootstrap-3'],
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
    })
  } catch {}

  t.is(io.calls.filter((call) => call[0] === 'caps' && call[1].startsWith('bootstrap-')).length, 3)
  t.is(io.calls.filter((call) => call[0] === 'challenge').length, 1)
  t.is(io.calls.filter((call) => call[0] === 'caps').length, 4)
  t.ok(discovery.counters.candidateRejectCount >= 2)
})

test('legacy discovery can be disabled and exhaustion has the stable privacy error', async (t) => {
  const io = fakeIO({ legacy: ['never'] })
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    allowLegacyDiscovery: false,
    randomBytes: (size) => b4a.alloc(size, 10),
    now: () => 1_000n
  })

  let error = null
  try {
    await discovery.discoverGuard({
      bootstraps: ['legacy'],
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
    })
  } catch (err) {
    error = err
  }
  t.is(error && error.code, 'ERR_PRIVACY_UNAVAILABLE')
  t.is(io.calls.filter((call) => call[0] === 'legacy').length, 0)
  t.ok(io.destroyed)
})

test('null and duplicate referrals cannot exceed three distinct prospective guard CAPS probes', async (t) => {
  const referrals = [
    'candidate-a',
    'candidate-a',
    'candidate-b',
    'candidate-c',
    'candidate-d',
    'candidate-e',
    'candidate-f',
    'candidate-g',
    'candidate-h',
    'candidate-i'
  ]
  const io = fakeIO({ legacy: referrals })
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    randomBytes: (size) => b4a.alloc(size, 0x19),
    now: () => 1_000n
  })
  try {
    await discovery.discoverGuard({
      bootstraps: ['legacy-bootstrap'],
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
    })
  } catch {}

  t.alike(
    io.calls
      .filter((call) => call[0] === 'caps' && call[1].startsWith('candidate-'))
      .map((call) => call[1]),
    ['candidate-a', 'candidate-b', 'candidate-c']
  )
  t.is(discovery.counters.activeValidationCount, 0)
})

test('discovery never returns unvalidated or role-incompatible evidence', async (t) => {
  const exitOnly = candidate(
    1,
    [192, 0, 2, 1],
    seed(1),
    RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1
  )
  const io = fakeIO({
    compatible: new Map([['bootstrap', response({ endpoint: 'bootstrap', value: exitOnly })]]),
    challenges: new Map([['bootstrap', exitOnly]])
  })
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    randomBytes: (size) => b4a.alloc(size, 11),
    now: () => 1_000n
  })
  let error = null
  try {
    await discovery.discoverGuard({
      bootstraps: ['bootstrap'],
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
    })
  } catch (err) {
    error = err
  }
  t.is(error && error.code, 'ERR_PRIVACY_UNAVAILABLE')
  t.is(discovery.counters.candidateRejectCount, 1)
  t.is(discovery.counters.activeValidationCount, 0)
})

test('bounded selection uses XOR order, identity uniqueness, and IPv4 /24 diversity', (t) => {
  const target = b4a.alloc(32)
  const values = [
    candidate(1, [192, 0, 2, 1], b4a.alloc(32, 1)),
    candidate(2, [192, 0, 2, 2], b4a.alloc(32, 2)),
    candidate(3, [198, 51, 100, 3], b4a.alloc(32, 3)),
    candidate(4, [203, 0, 113, 4], b4a.alloc(32, 4)),
    candidate(1, [203, 0, 114, 5], b4a.alloc(32, 5))
  ]
  const selected = selectDiverseRelayCapabilities(values, { target, maximumResults: 3 })
  t.alike(
    selected.map((value) => value.relayIdentity[0]),
    [1, 3, 4]
  )
})

test('discovery counters are read-only copies and diagnostics redact endpoints and identifiers', (t) => {
  const discovery = new CompatibleDiscovery({
    bootstrapIO: fakeIO(),
    directory: fakeDirectory(),
    randomBytes: (size) => b4a.alloc(size),
    now: () => 1_000n
  })
  const counters = discovery.counters
  counters.publicProbeCount = 99
  t.is(discovery.counters.publicProbeCount, 0)
  const text = JSON.stringify(discovery.diagnostics())
  t.absent(text.includes('192.0.2'))
  t.absent(/[a-f0-9]{32,}/i.test(text))
  expectCode(
    t,
    () => selectDiverseRelayCapabilities([], { target: seed(1), maximumResults: 9 }),
    'INVALID_ROUTE'
  )
})

test('compatible discovery passes only opaque referral and admission capabilities into direct IO', async (t) => {
  const guard = candidate(21)
  const provenance = Object.freeze({})
  const referralCapability = Object.freeze({})
  const calls = []
  const io = {
    usesOpaqueDiscoveryAuthority: true,
    async capsQuery(target) {
      calls.push(['caps', target])
      if (target === 'bootstrap') {
        return {
          advertisements: [
            {
              endpoint: 'raw-referral',
              advertisement: guard.advertisement,
              validated: guard,
              relayIdentity: guard.relayIdentity,
              capabilityMask: guard.capabilityMask,
              provenance,
              self: false
            }
          ]
        }
      }
      t.is(target, referralCapability)
      return {
        advertisements: [
          {
            advertisement: guard.advertisement,
            relayIdentity: guard.relayIdentity,
            capabilityMask: guard.capabilityMask,
            provenance,
            self: true
          }
        ]
      }
    },
    admitReferral(value) {
      t.is(value, provenance)
      return referralCapability
    },
    admitCandidate(value, directory) {
      t.is(value, provenance)
      return directory.admit(guard.advertisement, { observedEndpoint: 'raw-referral' })
    },
    async activeChallenge(admitted) {
      t.absent(typeof admitted === 'string')
      calls.push(['challenge', admitted])
      return guard
    },
    async pinGuard(validated) {
      calls.push(['pin', validated])
      return validated
    },
    destroy() {}
  }
  const result = await new CompatibleDiscovery({
    bootstrapIO: io,
    directory: fakeDirectory(),
    randomBytes: (size) => b4a.alloc(size, 0x77),
    now: () => 1_000n
  }).discoverGuard({
    bootstraps: ['bootstrap'],
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  })
  t.is(result, guard)
  t.ok(calls.some((call) => call[0] === 'challenge'))
})

test('real BootstrapIO fails closed when no branded guard-link authority is configured', async (t) => {
  const fixture = realAdvertisement()
  const admitted = new WeakMap()
  const validated = new WeakMap()
  const directory = {
    admit(advertisement, { observedEndpoint, capsBinding }) {
      const token = Object.freeze({})
      admitted.set(token, {
        advertisement: b4a.from(advertisement),
        observedEndpoint: b4a.from(observedEndpoint),
        capsBinding: {
          queryNonce: b4a.from(capsBinding.queryNonce),
          cookieExpiresAtMs: capsBinding.cookieExpiresAtMs,
          returnRoutabilityCookie: b4a.from(capsBinding.returnRoutabilityCookie)
        }
      })
      return token
    },
    isAdmitted(value) {
      return admitted.has(value)
    },
    readAdmitted(value) {
      const state = admitted.get(value)
      if (!state) throw new Error('not admitted')
      return {
        reachableEndpoint: b4a.from(state.observedEndpoint),
        capsBinding: {
          queryNonce: b4a.from(state.capsBinding.queryNonce),
          cookieExpiresAtMs: state.capsBinding.cookieExpiresAtMs,
          returnRoutabilityCookie: b4a.from(state.capsBinding.returnRoutabilityCookie)
        }
      }
    },
    async validate(token, exchange) {
      await exchange(activeChallengeBytes())
      const result = Object.freeze({})
      const state = admitted.get(token)
      validated.set(result, {
        relayIdentity: fixture.signed.relayIdentity,
        reachableEndpoint: state.observedEndpoint,
        capabilityMask: fixture.signed.capabilityMask,
        capacityClass: fixture.signed.capacityClass,
        advertisement: fixture.encoded
      })
      return result
    },
    isValidated(value) {
      return validated.has(value)
    },
    read(value) {
      return validated.get(value)
    }
  }
  const sends = []
  const io = new BootstrapIO({
    socketFactory() {
      return compatibleWireSocket(fixture, sends)
    },
    candidateChecker: directory,
    configuredBootstraps: [fixture.reachableEndpoint],
    now: () => 1_000n,
    randomBytes: (size) => b4a.alloc(size, 0x55)
  })
  await io.ready()
  let code = null
  await new CompatibleDiscovery({
    bootstrapIO: io,
    directory,
    randomBytes: (size) => b4a.alloc(size, 0x66),
    now: () => 1_000n
  })
    .discoverGuard({
      bootstraps: [fixture.reachableEndpoint],
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
    })
    .catch((err) => {
      code = err && err.code
    })

  t.is(code, 'ERR_PRIVACY_UNAVAILABLE')
  t.alike(
    sends.map((value) => value.messageId),
    [M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1]
  )
  t.ok(io.destroyed)
})

test('real compatible cold start runs CAPS challenge OFFER ACCEPT and returns an opaque M3 link', async (t) => {
  const fixture = realAdvertisement()
  const now = () => 1_000n
  const directory = realDirectory({ now, randomByte: 0x61 })
  const sends = []
  const clientEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 10]),
    port: 43000
  })
  const capsResponder = new CapsResponder({
    now,
    advertisement: fixture.encoded,
    identitySecretKey: fixture.signer.secretKey,
    routeEncryptionSecretKey: fixture.route.secretKey,
    crypto: { ...cryptoSuite, randomBytes: (size) => b4a.alloc(size, 0x71) }
  })
  const predecessorEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 14]),
    port: 44000
  })
  const guard = realGuardFixture({
    fixture,
    now,
    randomByte: 0x81,
    predecessorEndpoint
  })
  const io = new BootstrapIO({
    socketFactory: () =>
      productionWireSocket({
        responder: capsResponder,
        responderEndpoint: fixture.reachableEndpoint,
        clientEndpoint,
        sends
      }),
    candidateChecker: directory,
    guardHandshakeFactory: guard.factory,
    configuredBootstraps: [fixture.reachableEndpoint],
    now,
    randomBytes: (() => {
      let value = 0x90
      return (size) => b4a.alloc(size, value++)
    })()
  })
  await io.ready()
  const transfer = await new CompatibleDiscovery({
    bootstrapIO: io,
    directory,
    guardLinkSetup: {
      branchClass: BRANCH_CLASS.LOOKUP,
      branchId: b4a.alloc(16, 0x11),
      circuitId: b4a.alloc(16, 0x22),
      generation: 1n,
      requestedLimits: {
        cellSize: 1200,
        maxCells: 100,
        maxBytes: 100_000,
        maxCommands: 10,
        idleTimeoutMs: 30_000,
        expiresAtMs: 5_000n
      }
    },
    randomBytes: (size) => b4a.alloc(size, 0x66),
    now: () => 1_000n
  }).discoverGuard({
    bootstraps: [fixture.reachableEndpoint],
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  })
  const moved = consumeBootstrapGuardLink(transfer)
  t.ok(readM3EstablishedLink(moved.established))
  t.ok(readM3EstablishedLink(guard.responderEstablished))
  t.alike(
    sends.map((value) => value.datagram.byteLength),
    [118, 118, 184]
  )
  t.alike(
    sends.slice(0, 2).map((value) => decodeM3Object(value.datagram).body[69]),
    [0, 1]
  )
  t.alike(
    sends.map((value) => value.messageId),
    [M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1]
  )
  t.alike(directory.diagnostics(), {
    identities: 1,
    quarantined: 0,
    pending: 0,
    validated: 0,
    guardAdmissions: 0
  })
  destroyM3EstablishedLink(moved.established)
  destroyM3EstablishedLink(guard.responderEstablished)
  guard.responder.destroy()
  capsResponder.destroy()
  directory.destroy()
})

test('real legacy cold start transfer expires synchronously when its timer is suspended', async (t) => {
  const clock = fakeClock()
  const fixture = realAdvertisement()
  const legacyEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 90]),
    port: 49736
  })
  const directory = realDirectory({ now: clock.now, randomByte: 0x62 })
  const sends = []
  const clientEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 11]),
    port: 43001
  })
  const capsResponder = new CapsResponder({
    now: clock.now,
    advertisement: fixture.encoded,
    identitySecretKey: fixture.signer.secretKey,
    routeEncryptionSecretKey: fixture.route.secretKey,
    crypto: { ...cryptoSuite, randomBytes: (size) => b4a.alloc(size, 0x72) },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  })
  const predecessorEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 15]),
    port: 44001
  })
  const guard = realGuardFixture({
    fixture,
    now: clock.now,
    randomByte: 0x82,
    predecessorEndpoint
  })
  const socket = productionWireSocket({
    responder: capsResponder,
    responderEndpoint: fixture.reachableEndpoint,
    clientEndpoint,
    sends,
    legacyEndpoint
  })
  const io = new BootstrapIO({
    socketFactory: () => socket,
    candidateChecker: directory,
    guardHandshakeFactory: guard.factory,
    configuredBootstraps: [legacyEndpoint],
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x55)
  })
  await io.ready()
  const discovery = new CompatibleDiscovery({
    bootstrapIO: io,
    directory,
    randomBytes: (() => {
      let value = 0x66
      return (size) => b4a.alloc(size, value++)
    })(),
    guardLinkSetup: {
      branchClass: BRANCH_CLASS.LOOKUP,
      branchId: b4a.alloc(16, 0x31),
      circuitId: b4a.alloc(16, 0x32),
      generation: 1n,
      requestedLimits: {
        cellSize: 1200,
        maxCells: 100,
        maxBytes: 100_000,
        maxCommands: 10,
        idleTimeoutMs: 30_000,
        expiresAtMs: 10_000n
      }
    },
    now: clock.now
  })
  const pending = discovery.discoverGuard({
    bootstraps: [legacyEndpoint],
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  })
  for (let index = 0; index < 8; index++) await Promise.resolve()
  clock.advance(5_001)
  for (let index = 0; index < 12; index++) await Promise.resolve()
  const transfer = await pending
  clock.suspendTo(10_000n)
  let consumeError = null
  try {
    consumeBootstrapGuardLink(transfer)
  } catch (err) {
    consumeError = err
  }
  t.is(consumeError && consumeError.code, 'ERR_REPLAY')
  t.is(guard.clientPhysicalCloses, 1)
  t.ok(readM3EstablishedLink(guard.responderEstablished))
  t.is(sends.filter((value) => b4a.equals(value.endpoint, legacyEndpoint)).length, 1)
  t.alike(
    sends.map((value) => value.datagram.byteLength),
    [118, 118, 118, 184]
  )
  t.alike(
    sends
      .filter((value) => value.messageId === M3_MESSAGE_ID.CAPS_QUERY_V1)
      .map((value) => decodeM3Object(value.datagram).body[69]),
    [0, 0, 1]
  )
  t.alike(
    sends.map((value) => value.messageId),
    [
      M3_MESSAGE_ID.CAPS_QUERY_V1,
      M3_MESSAGE_ID.CAPS_QUERY_V1,
      M3_MESSAGE_ID.CAPS_QUERY_V1,
      M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1
    ]
  )
  t.alike(directory.diagnostics(), {
    identities: 1,
    quarantined: 0,
    pending: 0,
    validated: 0,
    guardAdmissions: 0
  })
  destroyM3EstablishedLink(guard.responderEstablished)
  guard.responder.destroy()
  capsResponder.destroy()
  directory.destroy()
})
