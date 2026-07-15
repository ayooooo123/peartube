import test from 'brittle'
import b4a from 'b4a'

import {
  BootstrapIO,
  BRANCH_CLASS,
  CAPACITY_CLASS,
  M3AdjacencyAuthority,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  consumeBootstrapGuardLink,
  cryptoSuite,
  decodeM3Object,
  decodeRelayCapabilityAdvertisement,
  deriveM3DhtNodeId,
  digestRelayCapabilityAdvertisement,
  encodeCanonicalEndpoint,
  encodeM3Object,
  encodeRelayCapabilityAdvertisement,
  providerServicePolicyForCapabilities,
  signRelayCapabilityAdvertisement
} from '../index.js'
import { consumeBootstrapGuardReady } from '../lib/bootstrap-io.js'
import {
  completeBranchConstruction,
  createBranchConstructionAuthority,
  initializeBranchGuardLease,
  takeBranchConstructionRequest
} from '../lib/branch-construction-authority.js'
import { readEstablishedLink } from '../lib/link-bootstrap-session.js'
import {
  createIndexZeroGuardLinkResponder,
  destroyM3EstablishedLink,
  readM3EstablishedLink
} from '../lib/guard-link.js'
import { GuardRevalidationIO, consumeGuardRevalidationReady } from '../lib/guard-revalidation-io.js'
import { createTailControlSession } from '../lib/tail-control.js'
import { seed } from './helpers.js'

const CAPS_RESPONSE_DOMAIN = b4a.from('hyperdht-private-routes/m3/caps-response/v1')

function writeU64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function signatureInput(domain, messageId, body) {
  const output = b4a.allocUnsafe(2 + domain.byteLength + 8 + body.byteLength)
  output.writeUInt16BE(domain.byteLength, 0)
  domain.copy(output, 2)
  output.writeUInt32BE(1, 2 + domain.byteLength)
  output.writeUInt16BE(messageId, 6 + domain.byteLength)
  output.writeUInt16BE(body.byteLength, 8 + domain.byteLength)
  body.copy(output, 10 + domain.byteLength)
  return output
}

function canonicalCapsResponse(advertisement, signer, queryNonce, responseTime = 1_000n) {
  const advertisements = Array.isArray(advertisement) ? advertisement : [advertisement]
  const body = b4a.allocUnsafe(
    73 + advertisements.reduce((total, value) => total + 2 + value.byteLength, 0)
  )
  signer.publicKey.copy(body, 0)
  queryNonce.copy(body, 32)
  writeU64(body, responseTime, 64)
  body[72] = advertisements.length
  let offset = 73
  for (const value of advertisements) {
    body.writeUInt16BE(value.byteLength, offset)
    value.copy(body, offset + 2)
    offset += 2 + value.byteLength
  }
  const input = signatureInput(CAPS_RESPONSE_DOMAIN, M3_MESSAGE_ID.CAPS_RESPONSE_V1, body)
  return encodeM3Object({
    messageId: M3_MESSAGE_ID.CAPS_RESPONSE_V1,
    body,
    authSuffix: cryptoSuite.sign(input, signer.secretKey)
  })
}

function fakeClock(start = 1_000n) {
  let now = start
  let next = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++next
      timers.set(id, { at: now + BigInt(delay), callback })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      now += BigInt(ms)
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    }
  }
}

function signedAdvertisement(endpointOctet = 91) {
  return signedAdvertisementFixture(endpointOctet).advertisement
}

function signedAdvertisementFixture(endpointOctet = 91, signerSeed = 91) {
  const signer = cryptoSuite.keyPair(seed(signerSeed))
  const route = cryptoSuite.encryptionKeyPair(seed(signerSeed + 1))
  const reachableEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, endpointOctet]),
    port: 49737
  })
  const capabilityMask = RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  const value = signRelayCapabilityAdvertisement(
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
  return { advertisement: encodeRelayCapabilityAdvertisement(value), route, signer }
}

function sequence(first) {
  let value = first
  return (size) => b4a.alloc(size, value++)
}

function directFragments(object) {
  const digest = cryptoSuite.hash([
    b4a.from('hyperdht-private-routes/m3/core-fragment/object/v1'),
    object
  ])
  const count = Math.ceil(object.byteLength / 1_144)
  return Array.from({ length: count }, (_, index) => {
    const offset = index * 1_144
    const data = object.subarray(offset, Math.min(offset + 1_144, object.byteLength))
    const body = b4a.allocUnsafe(48 + data.byteLength)
    body.writeUInt16BE(M3_MESSAGE_ID.CAPS_RESPONSE_V1, 0)
    digest.copy(body, 2)
    body.writeUInt32BE(object.byteLength, 34)
    body.writeUInt16BE(index, 38)
    body.writeUInt16BE(count, 40)
    body.writeUInt32BE(offset, 42)
    body.writeUInt16BE(data.byteLength, 46)
    data.copy(body, 48)
    return encodeM3Object({ messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1, body })
  })
}

function wireFixture({
  advertisements = null,
  activeResponse = null,
  challengeMutation = null,
  challengeSource = null,
  responseDatagrams = null,
  responseMutation = null,
  responseSource = null,
  fragmentResponse = false
} = {}) {
  const endpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 91]),
    port: 49737
  })
  const self = signedAdvertisementFixture()
  const signer = self.signer
  const advertisement = self.advertisement
  const packets = []
  const sent = []
  let aborts = 0
  let phase0 = null
  const socket = {
    async bind() {},
    async send(target, datagram) {
      sent.push(b4a.isBuffer(datagram) ? b4a.from(datagram) : datagram)
      const object = decodeM3Object(datagram)
      if (object.messageId === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1) {
        if (activeResponse) {
          packets.push({ sourceEndpoint: b4a.from(target), datagram: activeResponse })
        }
        return
      }
      if (object.messageId !== M3_MESSAGE_ID.CAPS_QUERY_V1) throw new Error('unexpected')
      if (object.body[69] === 0) {
        phase0 = object.body
        const body = b4a.alloc(72)
        object.body.subarray(36, 68).copy(body, 0)
        writeU64(body, 5_000n, 32)
        seed(71).copy(body, 40)
        if (challengeMutation) challengeMutation(body)
        packets.push({
          sourceEndpoint: challengeSource ? b4a.from(challengeSource) : b4a.from(target),
          datagram: encodeM3Object({
            messageId: M3_MESSAGE_ID.CAPS_COOKIE_CHALLENGE_V1,
            body
          })
        })
      } else {
        if (!phase0 || !b4a.equals(object.body.subarray(0, 69), phase0.subarray(0, 69))) {
          throw new Error('phase mismatch')
        }
        let response = canonicalCapsResponse(
          advertisements || advertisement,
          signer,
          object.body.subarray(36, 68)
        )
        if (responseMutation) response = responseMutation(response)
        const datagrams = responseDatagrams
          ? responseDatagrams(response)
          : fragmentResponse
            ? directFragments(response)
            : [response]
        for (const datagram of datagrams) {
          packets.push({
            sourceEndpoint: responseSource ? b4a.from(responseSource) : b4a.from(target),
            datagram
          })
        }
      }
    },
    async receive() {
      if (packets.length > 0) return packets.shift()
      return new Promise(() => {})
    },
    abort() {
      aborts++
    },
    destroy() {}
  }
  return {
    advertisement,
    endpoint,
    get aborts() {
      return aborts
    },
    sent,
    socket
  }
}

function wireIO(wire, clock = null) {
  return new BootstrapIO({
    socketFactory: () => wire.socket,
    candidateChecker: {
      isValidated: () => false,
      read() {
        throw new Error('unauthorized')
      }
    },
    configuredBootstraps: [wire.endpoint],
    now: clock ? clock.now : () => 1_000n,
    setTimeout: clock ? clock.setTimeout : globalThis.setTimeout,
    clearTimeout: clock ? clock.clearTimeout : globalThis.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x41)
  })
}

function sortAdvertisements(advertisements, target = seed(69)) {
  return [...advertisements].sort((left, right) => {
    const a = decodeRelayCapabilityAdvertisement(left, { now: 1_000n })
    const b = decodeRelayCapabilityAdvertisement(right, { now: 1_000n })
    for (let index = 0; index < 32; index++) {
      const distance =
        (a.currentDhtNodeId[index] ^ target[index]) - (b.currentDhtNodeId[index] ^ target[index])
      if (distance !== 0) return distance
    }
    return b4a.compare(a.relayIdentity, b.relayIdentity)
  })
}

function largeCanonicalAdvertisements() {
  return sortAdvertisements(
    [
      [91, 91],
      [92, 3],
      [93, 5],
      [94, 6],
      [95, 8]
    ].map(
      ([endpointOctet, signerSeed]) =>
        signedAdvertisementFixture(endpointOctet, signerSeed).advertisement
    )
  )
}

function activeChallengeBytes() {
  const body = b4a.alloc(176)
  writeU64(body, 6_000n, 96)
  writeU64(body, 5_000n, 136)
  return encodeM3Object({ messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1, body })
}

function activeResponseBytes() {
  return encodeM3Object({
    messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1,
    body: b4a.alloc(272),
    authSuffix: b4a.alloc(64)
  })
}

function admittedChecker(token, endpoint) {
  return {
    isValidated: () => false,
    read() {
      throw new Error('unauthorized')
    },
    isAdmitted: (value) => value === token,
    readAdmitted(value) {
      if (value !== token) throw new Error('unauthorized')
      return { reachableEndpoint: endpoint, capsBinding: Object.freeze({}) }
    }
  }
}

function capsQuery(nonce = 70) {
  return {
    requestedCapabilityMask: 1,
    randomTarget: seed(69),
    queryNonce: seed(nonce),
    maximumResults: 8
  }
}

function bootstrapEndpoint(index = 0) {
  return encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 91 + index]),
    port: 49737
  })
}

function fixture({
  configuredBootstraps = [bootstrapEndpoint()],
  bindingQueryNonce = null,
  legacyReferrals = [],
  responseAdvertisements = null
} = {}) {
  const calls = []
  const advertisement = signedAdvertisement(configuredBootstraps[0][16])
  const state = {
    relayIdentity: decodeRelayCapabilityAdvertisement(advertisement, { now: 1_000n }).relayIdentity,
    reachableEndpoint: b4a.from(configuredBootstraps[0]),
    capabilityMask: 1,
    capacityClass: 1,
    advertisement
  }
  const validated = Object.freeze({})
  const admissions = new Set([Object.freeze({}), Object.freeze({}), Object.freeze({})])
  const admittedReads = []
  const packets = []
  const phase0 = new Map()
  const responseSigner = cryptoSuite.keyPair(seed(91))
  const socket = {
    async bind() {
      calls.push(['bind'])
    },
    async send(endpoint, datagram) {
      const object = decodeM3Object(datagram)
      calls.push(['socket.send', endpoint, object.messageId, b4a.from(datagram)])
      if (object.messageId === M3_MESSAGE_ID.CAPS_QUERY_V1) {
        const key = b4a.toString(endpoint, 'hex')
        if (object.body[69] === 0) {
          phase0.set(key, object.body)
          const body = b4a.alloc(72)
          ;(bindingQueryNonce || object.body.subarray(36, 68)).copy(body, 0)
          writeU64(body, 5_000n, 32)
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
        if (!phase0.has(key)) throw new Error('phase 1 without phase 0')
        const selfAdvertisement = signedAdvertisement(endpoint[16])
        const values =
          responseAdvertisements && b4a.equals(endpoint, configuredBootstraps[0])
            ? responseAdvertisements
            : [selfAdvertisement]
        const response = canonicalCapsResponse(
          sortAdvertisements(values, object.body.subarray(4, 36)),
          responseSigner,
          object.body.subarray(36, 68)
        )
        for (const datagram of response.byteLength > 1_200
          ? directFragments(response)
          : [response]) {
          packets.push({ sourceEndpoint: b4a.from(endpoint), datagram })
        }
        return
      }
      if (object.messageId === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1) {
        packets.push({ sourceEndpoint: b4a.from(endpoint), datagram: activeResponseBytes() })
        return
      }
      throw new Error(`forbidden message ${object.messageId}`)
    },
    async receive() {
      if (packets.length > 0) return packets.shift()
      return new Promise(() => {})
    },
    async legacyFindNode(endpoint, target) {
      calls.push(['legacyFindNode', endpoint, target])
      return legacyReferrals
    },
    abort() {
      calls.push(['socket.abort'])
    },
    destroy() {
      calls.push(['socket.destroy'])
    }
  }
  const candidateChecker = Object.freeze({
    isValidated(value) {
      return value === validated
    },
    read(value) {
      if (value !== validated) throw new Error('unauthorized')
      return {
        ...state,
        relayIdentity: b4a.from(state.relayIdentity),
        reachableEndpoint: b4a.from(state.reachableEndpoint),
        advertisement: b4a.from(state.advertisement)
      }
    },
    isAdmitted(value) {
      return admissions.has(value)
    },
    readAdmitted(value) {
      if (!admissions.has(value)) throw new Error('unauthorized')
      const projection = {
        reachableEndpoint: b4a.from(configuredBootstraps[0]),
        capsBinding: Object.freeze({
          queryNonce: seed(180),
          returnRoutabilityCookie: seed(181)
        })
      }
      admittedReads.push(projection)
      return projection
    },
    isReferral() {
      return false
    },
    readReferral() {
      throw new Error('unauthorized')
    }
  })
  const normalDht = Object.freeze({
    calls: 0,
    query() {
      this.calls++
      throw new Error('iterative DHT authority used')
    },
    request() {
      this.calls++
      throw new Error('generic DHT authority used')
    }
  })
  const io = new BootstrapIO({
    socketFactory() {
      calls.push(['construct'])
      return socket
    },
    candidateChecker,
    configuredBootstraps,
    normalDht,
    now: () => 1_000n,
    randomBytes: cryptoSuite.randomBytes
  })
  return {
    admissions: [...admissions],
    admittedReads,
    calls,
    configuredBootstraps,
    io,
    normalDht,
    state,
    validated
  }
}

test('BootstrapIO is the sole bounded direct authority and exposes no generic query surface', async (t) => {
  const { admissions, calls, configuredBootstraps, io, normalDht } = fixture()
  const bootstrap = configuredBootstraps[0]
  t.is(io.query, undefined)
  t.is(io.request, undefined)
  t.is(io.send, undefined)

  await io.ready()
  await io.capsQuery(bootstrap, capsQuery())
  await io.legacyFindNode(bootstrap, seed(2))
  await io.activeChallenge(admissions[0], activeChallengeBytes())

  t.alike(
    calls.map((call) => call[0]),
    ['construct', 'bind', 'socket.send', 'socket.send', 'legacyFindNode', 'socket.send']
  )
  t.alike(
    calls.filter((call) => call[0] === 'socket.send').map((call) => call[2]),
    [M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1]
  )
  t.is(normalDht.calls, 0)
  t.is(io.counters.publicProbeCount, 2)
  t.is(io.counters.activeValidationCount, 1)
})

test('CAPS exchange deadline is injected, non-extending, aborts transport, and settles', async (t) => {
  const clock = fakeClock()
  let aborts = 0
  const endpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 91]),
    port: 49737
  })
  const io = new BootstrapIO({
    socketFactory() {
      return {
        async bind() {},
        send() {
          return new Promise(() => {})
        },
        receive() {
          return new Promise(() => {})
        },
        abort() {
          aborts++
        },
        destroy() {}
      }
    },
    candidateChecker: {
      isValidated: () => false,
      read() {
        throw new Error('unauthorized')
      }
    },
    configuredBootstraps: [endpoint],
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x41)
  })
  await io.ready()
  let settled = false
  io.capsQuery(endpoint, capsQuery()).then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await Promise.resolve()
  clock.advance(5_001)
  for (let index = 0; index < 8; index++) await Promise.resolve()

  t.ok(settled)
  t.is(aborts, 1)
  io.destroy()
})

test('direct CAPS uses the exact phase-0 cookie phase-1 canonical byte transcript', async (t) => {
  const wire = wireFixture()
  const io = wireIO(wire)
  await io.ready()
  const response = await io.capsQuery(wire.endpoint, capsQuery())

  t.is(response.advertisements.length, 1)
  t.is(wire.sent.length, 2)
  t.ok(wire.sent.every((datagram) => b4a.isBuffer(datagram) && datagram.byteLength === 118))
  const phases = wire.sent.map((datagram) => decodeM3Object(datagram).body[69])
  t.alike(phases, [0, 1])
})

test('CAPS rejects cookie cross-query, cross-endpoint, late, and replay substitution', async (t) => {
  const otherEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 92]),
    port: 49737
  })
  const cases = [
    wireFixture({ challengeMutation: (body) => body.fill(0x99, 0, 32) }),
    wireFixture({ challengeSource: otherEndpoint }),
    wireFixture({ challengeMutation: (body) => writeU64(body, 6_001n, 32) }),
    wireFixture({ challengeMutation: (body) => body.fill(0, 40, 72) }),
    wireFixture({
      responseMutation(response) {
        const queryNonce = decodeM3Object(response).body.subarray(32, 64)
        const body = b4a.alloc(72)
        queryNonce.copy(body, 0)
        writeU64(body, 5_000n, 32)
        seed(71).copy(body, 40)
        return encodeM3Object({
          messageId: M3_MESSAGE_ID.CAPS_COOKIE_CHALLENGE_V1,
          body
        })
      }
    })
  ]
  for (const wire of cases) {
    const io = wireIO(wire)
    await io.ready()
    await t.exception(io.capsQuery(wire.endpoint, capsQuery()), 'invalid cookie binding')
    io.destroy()
  }
})

test('BootstrapIO permits only one global direct CAPS exchange in flight', async (t) => {
  const clock = fakeClock()
  const first = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 91]),
    port: 49737
  })
  const second = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 92]),
    port: 49737
  })
  const socket = {
    async bind() {},
    send() {
      return new Promise(() => {})
    },
    receive() {
      return new Promise(() => {})
    },
    abort() {},
    destroy() {}
  }
  const io = new BootstrapIO({
    socketFactory: () => socket,
    candidateChecker: {
      isValidated: () => false,
      read() {
        throw new Error('unauthorized')
      }
    },
    configuredBootstraps: [first, second],
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x41)
  })
  await io.ready()
  io.capsQuery(first, capsQuery(72)).catch(() => {})
  let error = null
  io.capsQuery(second, capsQuery(73)).catch((err) => {
    error = err
  })
  for (let index = 0; index < 8; index++) await Promise.resolve()

  t.is(error && error.code, 'ERR_BUSY')
  io.destroy()
})

test('CAPS rejects response source, signer, self-ad, duplicate, and ordering substitution', async (t) => {
  const otherEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 92]),
    port: 49737
  })
  const self = signedAdvertisementFixture().advertisement
  const other = signedAdvertisementFixture(92, 3).advertisement
  const sorted = sortAdvertisements([self, other])
  const cases = [
    wireFixture({ responseSource: otherEndpoint }),
    wireFixture({
      responseMutation(response) {
        const forged = b4a.from(response)
        forged[forged.byteLength - 1] ^= 1
        return forged
      }
    }),
    wireFixture({ advertisements: signedAdvertisement(92) }),
    wireFixture({ advertisements: [self, self] }),
    wireFixture({ advertisements: [...sorted].reverse() })
  ]
  for (const wire of cases) {
    const io = wireIO(wire)
    await io.ready()
    await t.exception(io.capsQuery(wire.endpoint, capsQuery()), 'invalid response binding')
    io.destroy()
  }
})

test('CAPS reassembles a canonical response larger than one direct datagram', async (t) => {
  const advertisements = largeCanonicalAdvertisements()
  const wire = wireFixture({ advertisements, fragmentResponse: true })
  const io = wireIO(wire)
  await io.ready()
  const response = await io.capsQuery(wire.endpoint, capsQuery())

  t.is(response.advertisements.length, 5)
  t.is(wire.sent.length, 2)
})

test('direct fragment reassembly bounds concurrency and reserved object bytes', async (t) => {
  const advertisements = largeCanonicalAdvertisements()
  const concurrent = wireFixture({
    advertisements,
    responseDatagrams(response) {
      return [0, 1, 2].map((value) => {
        const distinct = b4a.from(response)
        distinct[distinct.byteLength - 1] ^= value
        return directFragments(distinct)[0]
      })
    }
  })
  const concurrentIO = wireIO(concurrent)
  await concurrentIO.ready()
  await t.exception(
    concurrentIO.capsQuery(concurrent.endpoint, capsQuery()),
    'third concurrent reassembly'
  )
  t.is(concurrentIO.scratchState().reassemblies, 0)

  const overCap = wireFixture({
    responseDatagrams() {
      const body = b4a.alloc(48 + 1_144)
      body.writeUInt16BE(M3_MESSAGE_ID.CAPS_RESPONSE_V1, 0)
      seed(1).copy(body, 2)
      body.writeUInt32BE(12_289, 34)
      body.writeUInt16BE(0, 38)
      body.writeUInt16BE(11, 40)
      body.writeUInt32BE(0, 42)
      body.writeUInt16BE(1_144, 46)
      return [encodeM3Object({ messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1, body })]
    }
  })
  const overCapIO = wireIO(overCap)
  await overCapIO.ready()
  await t.exception(overCapIO.capsQuery(overCap.endpoint, capsQuery()), 'object byte cap')
  t.is(overCapIO.scratchState().reservedReassemblyBytes, 0)
})

test('direct fragments accept identical duplicates and reject conflict or digest mismatch', async (t) => {
  const advertisements = largeCanonicalAdvertisements()
  const identical = wireFixture({
    advertisements,
    responseDatagrams(response) {
      const fragments = directFragments(response)
      return [fragments[0], b4a.from(fragments[0]), ...fragments.slice(1)]
    }
  })
  const identicalIO = wireIO(identical)
  await identicalIO.ready()
  t.is((await identicalIO.capsQuery(identical.endpoint, capsQuery())).advertisements.length, 5)

  for (const mode of ['conflict', 'digest']) {
    const wire = wireFixture({
      advertisements,
      responseDatagrams(response) {
        const fragments = directFragments(response)
        if (mode === 'conflict') {
          const conflict = b4a.from(fragments[0])
          conflict[conflict.byteLength - 1] ^= 1
          return [fragments[0], conflict]
        }
        const damaged = b4a.from(fragments[fragments.length - 1])
        damaged[damaged.byteLength - 1] ^= 1
        return [...fragments.slice(0, -1), damaged]
      }
    })
    const io = wireIO(wire)
    await io.ready()
    await t.exception(io.capsQuery(wire.endpoint, capsQuery()), mode)
    t.is(io.scratchState().reassemblies, 0)
  }
})

test('direct fragment timeout is non-extending and erases reserved storage', async (t) => {
  const clock = fakeClock()
  const wire = wireFixture({
    advertisements: largeCanonicalAdvertisements(),
    responseDatagrams(response) {
      const first = directFragments(response)[0]
      return [first, b4a.from(first), b4a.from(first)]
    }
  })
  const io = wireIO(wire, clock)
  await io.ready()
  let settled = false
  io.capsQuery(wire.endpoint, capsQuery()).then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  for (let index = 0; index < 12; index++) await Promise.resolve()
  t.is(io.scratchState().reassemblies, 1)
  clock.advance(5_001)
  for (let index = 0; index < 12; index++) await Promise.resolve()

  t.ok(settled)
  t.alike(io.scratchState(), {
    addresses: 1,
    referrals: 0,
    advertisements: 0,
    configuredProbes: 1,
    reassemblies: 0,
    reservedReassemblyBytes: 0
  })
})

test('active challenge uses canonical bytes and an injected non-extending deadline', async (t) => {
  const token = Object.freeze({})
  const clock = fakeClock()
  const successWire = wireFixture({ activeResponse: activeResponseBytes() })
  const successIO = new BootstrapIO({
    socketFactory: () => successWire.socket,
    candidateChecker: admittedChecker(token, successWire.endpoint),
    configuredBootstraps: [successWire.endpoint],
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x41)
  })
  await successIO.ready()
  await successIO.capsQuery(successWire.endpoint, capsQuery())
  t.alike(await successIO.activeChallenge(token, activeChallengeBytes()), activeResponseBytes())
  t.is(successWire.sent.at(-1).byteLength, 184)

  const timeoutWire = wireFixture()
  const timeoutIO = new BootstrapIO({
    socketFactory: () => timeoutWire.socket,
    candidateChecker: admittedChecker(token, timeoutWire.endpoint),
    configuredBootstraps: [timeoutWire.endpoint],
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x41)
  })
  await timeoutIO.ready()
  await timeoutIO.capsQuery(timeoutWire.endpoint, capsQuery(72))
  let settled = false
  timeoutIO.activeChallenge(token, activeChallengeBytes()).catch(() => {
    settled = true
  })
  for (let index = 0; index < 8; index++) await Promise.resolve()
  clock.advance(5_001)
  for (let index = 0; index < 8; index++) await Promise.resolve()

  t.ok(settled)
  t.is(timeoutWire.aborts, 1)
  t.is(timeoutIO.scratchState().reassemblies, 0)
})

test('legacy FIND_NODE is one configured-bootstrap request and never iterative', async (t) => {
  const { calls, configuredBootstraps, io } = fixture()
  const bootstrap = configuredBootstraps[0]
  await io.ready()
  await io.legacyFindNode(bootstrap, seed(3))
  await t.exception(io.legacyFindNode(bootstrap, seed(4)), 'single-use')
  await t.exception(io.legacyFindNode(bootstrapEndpoint(9), seed(5)), 'configured only')
  t.is(calls.filter((call) => call[0] === 'legacyFindNode').length, 1)
})

test('legacy FIND_NODE owns its authorized endpoint and target before hostile callbacks', async (t) => {
  const endpoint = bootstrapEndpoint(0)
  const authorizedEndpoint = b4a.from(endpoint)
  const target = seed(239)
  const authorizedTarget = b4a.from(target)
  let armed = false
  let observedEndpoint = null
  let observedTarget = null
  const io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      async legacyFindNode(value, queryTarget) {
        observedEndpoint = b4a.from(value)
        observedTarget = b4a.from(queryTarget)
        return []
      },
      abort() {},
      destroy() {}
    }),
    candidateChecker: { isValidated: () => false },
    configuredBootstraps: [endpoint],
    now() {
      if (armed) {
        endpoint.fill(0)
        target.fill(0)
      }
      return 1_000n
    },
    randomBytes: (size) => b4a.alloc(size, 0x51)
  })
  await io.ready()
  armed = true
  await io.legacyFindNode(endpoint, target)

  t.alike(observedEndpoint, authorizedEndpoint, 'the clock cannot redirect bootstrap authority')
  t.alike(observedTarget, authorizedTarget, 'the clock cannot replace the lookup target')
  io.destroy()
})

test('legacy FIND_NODE cannot call a saved adapter after a terminal clock transition', async (t) => {
  for (const terminal of ['destroy', 'privateReady']) {
    const endpoint = bootstrapEndpoint(0)
    let io = null
    let armed = false
    let directCalls = 0
    io = new BootstrapIO({
      socketFactory: () => ({
        async bind() {},
        async send() {},
        async receive() {},
        async legacyFindNode() {
          directCalls++
          return []
        },
        abort() {},
        destroy() {}
      }),
      candidateChecker: { isValidated: () => false },
      configuredBootstraps: [endpoint],
      now() {
        if (armed) {
          if (terminal === 'destroy') io.destroy()
          else void io.privateReady()
        }
        return 1_000n
      },
      randomBytes: (size) => b4a.alloc(size, 0x52)
    })
    await io.ready()
    armed = true
    let code = null
    await io.legacyFindNode(endpoint, seed(238)).catch((err) => {
      code = err && err.code
    })
    t.is(code, 'ERR_DESTROYED', terminal)
    t.is(directCalls, 0, `${terminal} prevents the saved direct adapter call`)
  }
})

test('legacy FIND_NODE has a non-extending owned deadline and aborts a hung adapter', async (t) => {
  const clock = fakeClock()
  let aborted = 0
  const endpoint = bootstrapEndpoint(0)
  const io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      legacyFindNode() {
        return new Promise(() => {})
      },
      abort(value) {
        t.alike(value, endpoint)
        aborted++
      },
      destroy() {}
    }),
    candidateChecker: admittedChecker(Object.freeze({}), endpoint),
    configuredBootstraps: [endpoint],
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x51)
  })
  await io.ready()
  let code = null
  const pending = io.legacyFindNode(endpoint, seed(240)).catch((err) => {
    code = err && err.code
  })
  await Promise.resolve()
  clock.advance(5_000)
  await pending
  t.is(code, 'ERR_PRIVACY_UNAVAILABLE')
  t.is(aborted, 1)
})

test('legacy referral allocation rejects oversized responses and returns at most three endpoints', async (t) => {
  const endpoints = [1, 1, 2, 3, 4, 5].map((last) =>
    encodeCanonicalEndpoint({
      addressFamily: 4,
      addressBytes: b4a.from([192, 0, 2, last]),
      port: 49737
    })
  )
  const { configuredBootstraps, io } = fixture({ legacyReferrals: endpoints })
  await io.ready()
  const referrals = await io.legacyFindNode(configuredBootstraps[0], seed(40))
  t.is(referrals.length, 3)

  const oversized = Array.from({ length: 21 }, (_, index) =>
    encodeCanonicalEndpoint({
      addressFamily: 4,
      addressBytes: b4a.from([192, 0, 2, index + 1]),
      port: 49737
    })
  )
  const secondFixture = fixture({ legacyReferrals: oversized })
  await secondFixture.io.ready()
  await t.exception(
    secondFixture.io.legacyFindNode(secondFixture.configuredBootstraps[0], seed(41)),
    'oversized response'
  )
})

test('Task 2 exposes no first-link handoff or unbranded link acceptance surface', (t) => {
  const { io } = fixture()
  t.is(io.handoffGuard, undefined)
})

test('all direct IO stops after private readiness resolves', async (t) => {
  const { admissions, calls, configuredBootstraps, io } = fixture()
  const bootstrap = configuredBootstraps[0]
  await io.ready()
  await io.privateReady()

  for (const operation of [
    () => io.capsQuery(bootstrap, capsQuery()),
    () => io.legacyFindNode(bootstrap, seed(1)),
    () => io.activeChallenge(admissions[0], activeChallengeBytes())
  ]) {
    let error = null
    try {
      await operation()
    } catch (err) {
      error = err
    }
    t.is(error && error.code, 'ERR_DESTROYED')
  }
  t.is(calls.filter((call) => call[0] === 'socket.send').length, 0)
})

test('destroy is idempotent, clears authority state, and diagnostics remain redacted', async (t) => {
  const { calls, configuredBootstraps, io } = fixture()
  await io.ready()
  const response = await io.capsQuery(configuredBootstraps[0], capsQuery())
  io.admitReferral(response.advertisements[0].provenance)
  io.destroy()
  io.destroy()

  t.is(calls.filter((call) => call[0] === 'socket.destroy').length, 1)
  t.alike(io.scratchState(), {
    addresses: 0,
    referrals: 0,
    advertisements: 0,
    configuredProbes: 0,
    reassemblies: 0,
    reservedReassemblyBytes: 0
  })
  const diagnostic = JSON.stringify(io.diagnostics())
  t.absent(diagnostic.includes('198.51.100.7'))
  t.absent(/[a-f0-9]{32,}/i.test(diagnostic))
})

test('configured bootstraps are deduplicated/capped and raw endpoints cannot mint referral authority', async (t) => {
  const bootstrapA = bootstrapEndpoint(0)
  const bootstrapB = bootstrapEndpoint(1)
  const bootstrapC = bootstrapEndpoint(2)
  const bootstrapD = bootstrapEndpoint(3)
  const { calls, io } = fixture({
    configuredBootstraps: [bootstrapA, bootstrapA, bootstrapB, bootstrapC, bootstrapD]
  })
  await io.ready()
  let firstResponse = null
  let nonce = 70
  for (const endpoint of [bootstrapA, bootstrapB, bootstrapC]) {
    const response = await io.capsQuery(endpoint, capsQuery(nonce++))
    if (!firstResponse) firstResponse = response
  }
  await t.exception(
    io.capsQuery(bootstrapD, capsQuery(80)),
    'fourth bootstrap is outside authority'
  )
  await t.exception(
    io.capsQuery(bootstrapEndpoint(9), capsQuery(81)),
    'raw referral endpoint is not authority'
  )
  const referral = io.admitReferral(firstResponse.advertisements[0].provenance)
  await io.capsQuery(referral, capsQuery(82))
  t.is(calls.filter((call) => call[0] === 'socket.send').length, 8)
})

test('configured bootstrap endpoints are canonical owned copies', async (t) => {
  const configured = bootstrapEndpoint(4)
  const expected = b4a.from(configured)
  let observed = null
  const io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send(endpoint) {
        observed = b4a.from(endpoint)
        throw new Error('stop after stored endpoint')
      },
      async receive() {},
      abort() {},
      destroy() {}
    }),
    candidateChecker: { isValidated: () => false },
    configuredBootstraps: [configured],
    now: () => 1_000n,
    randomBytes: (size) => b4a.alloc(size, 0x71)
  })
  configured.fill(0)
  await io.ready()
  await t.exception(io.capsQuery(expected, capsQuery(83)))
  t.alike(observed, expected, 'caller mutation cannot redirect a configured bootstrap')
  io.destroy()
})

test('CAPS and candidate handoff scratch is erased after transfer or failure', async (t) => {
  {
    const { configuredBootstraps, io } = fixture()
    const scratch = []
    io._capsReferralIssuer = {
      issue({ capsBinding }) {
        scratch.push(capsBinding.queryNonce, capsBinding.returnRoutabilityCookie)
        return Object.freeze({})
      }
    }
    await io.ready()
    await io.capsQuery(configuredBootstraps[0], capsQuery(84))
    for (const bytes of scratch) t.alike(bytes, b4a.alloc(bytes.byteLength))
    io.destroy()
  }

  for (const throws of [false, true]) {
    const { configuredBootstraps, io } = fixture()
    await io.ready()
    const response = await io.capsQuery(configuredBootstraps[0], capsQuery(throws ? 86 : 85))
    const aliases = []
    const expected = Object.freeze({})
    const directory = {
      admit(advertisement, { observedEndpoint, capsBinding }) {
        aliases.push(
          advertisement,
          observedEndpoint,
          capsBinding.queryNonce,
          capsBinding.returnRoutabilityCookie
        )
        if (throws) throw new Error('directory rejected candidate')
        return expected
      }
    }
    if (throws)
      t.exception(() => io.admitCandidate(response.advertisements[0].provenance, directory))
    else t.is(io.admitCandidate(response.advertisements[0].provenance, directory), expected)
    for (const bytes of aliases) t.alike(bytes, b4a.alloc(bytes.byteLength))
    io.destroy()
  }
})

test('real branded discovery evidence alone can authorize a referral probe', async (t) => {
  const { calls, configuredBootstraps, io } = fixture()
  await io.ready()
  const response = await io.capsQuery(configuredBootstraps[0], capsQuery())
  const advertisement = response.advertisements[0].advertisement
  const evidence = response.advertisements[0].provenance

  t.exception(
    () => io.admitReferral({ advertisement, endpoint: b4a.alloc(19) }),
    'raw signed ad and endpoint are not provenance'
  )
  const capability = io.admitReferral(evidence)
  t.exception(() => io.admitReferral(evidence), 'response provenance is single-use')
  await io.capsQuery(capability, capsQuery(72))
  await t.exception(io.capsQuery(capability, capsQuery(73)), 'referral capability is query-bound')
  t.is(calls.filter((call) => call[0] === 'socket.send').length, 4)
})

test('direct referral authority caps distinct probes at three and deduplicates endpoints', async (t) => {
  const advertisements = sortAdvertisements([
    signedAdvertisementFixture(91, 91).advertisement,
    signedAdvertisementFixture(91, 3).advertisement,
    signedAdvertisementFixture(92, 5).advertisement,
    signedAdvertisementFixture(93, 6).advertisement,
    signedAdvertisementFixture(94, 8).advertisement
  ])
  const { calls, configuredBootstraps, io } = fixture({ responseAdvertisements: advertisements })
  await io.ready()
  const response = await io.capsQuery(configuredBootstraps[0], capsQuery())
  const endpointGroups = new Map()
  for (const entry of response.advertisements) {
    const endpoint = decodeRelayCapabilityAdvertisement(entry.advertisement, {
      now: 1_000n
    }).reachableEndpoint
    const key = b4a.toString(endpoint, 'hex')
    if (!endpointGroups.has(key)) endpointGroups.set(key, [])
    endpointGroups.get(key).push(io.admitReferral(entry.provenance))
  }
  const groups = [...endpointGroups.values()]
  const duplicate = groups.find((values) => values.length === 2)
  const distinct = groups.filter((values) => values !== duplicate).map((values) => values[0])

  await io.capsQuery(duplicate[0], capsQuery(72))
  await t.exception(
    io.capsQuery(duplicate[1], capsQuery(73)),
    'duplicate endpoint cannot cause a second send'
  )
  await io.capsQuery(distinct[0], capsQuery(74))
  await io.capsQuery(distinct[1], capsQuery(75))
  await t.exception(io.capsQuery(distinct[2], capsQuery(76)), 'fourth distinct endpoint')

  t.is(calls.filter((call) => call[0] === 'socket.send').length, 8)
})

test('CAPS response provenance rejects invented or cross-query cookie bindings', async (t) => {
  const { configuredBootstraps, io } = fixture({ bindingQueryNonce: seed(99) })
  await io.ready()
  let error = null
  try {
    await io.capsQuery(configuredBootstraps[0], capsQuery(70))
  } catch (err) {
    error = err
  }
  t.is(error && error.code, 'ERR_AUTHENTICATION')
  t.exception(
    () => io.admitReferral({ endpoint: b4a.alloc(19), advertisement: signedAdvertisement() }),
    'raw legacy or signed endpoints cannot become provenance'
  )
})

test('active challenge requires admitted CAPS-bound evidence, exact bytes, and a global budget of three', async (t) => {
  const { admissions, admittedReads, calls, configuredBootstraps, io } = fixture()
  await io.ready()
  await io.capsQuery(configuredBootstraps[0], capsQuery())
  await t.exception(io.activeChallenge('challenge-a', b4a.alloc(184)), 'raw endpoint')
  for (const invalid of [b4a.alloc(183), b4a.alloc(185), Object.freeze({})]) {
    await t.exception(io.activeChallenge(admissions[0], invalid), 'wrong challenge length')
  }
  for (const admission of admissions) await io.activeChallenge(admission, activeChallengeBytes())
  await t.exception(
    io.activeChallenge(admissions[0], activeChallengeBytes()),
    'global budget exhausted'
  )
  t.is(
    calls.filter(
      (call) => call[0] === 'socket.send' && call[2] === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1
    ).length,
    3
  )
  for (const projection of admittedReads) {
    t.alike(projection.reachableEndpoint, b4a.alloc(19))
    t.alike(projection.capsBinding.queryNonce, b4a.alloc(32))
    t.alike(projection.capsBinding.returnRoutabilityCookie, b4a.alloc(32))
  }
})

test('active challenge dials stored authority after hostile projection mutation', async (t) => {
  const wire = wireFixture({ activeResponse: activeResponseBytes() })
  const token = Object.freeze({})
  const projectionEndpoint = b4a.from(wire.endpoint)
  let armed = false
  let observedEndpoint = null
  const originalSend = wire.socket.send
  wire.socket.send = async (endpoint, datagram) => {
    if (decodeM3Object(datagram).messageId === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1) {
      observedEndpoint = b4a.from(endpoint)
    }
    return originalSend.call(wire.socket, endpoint, datagram)
  }
  const io = new BootstrapIO({
    socketFactory: () => wire.socket,
    candidateChecker: {
      isValidated: () => false,
      isAdmitted: (value) => value === token,
      readAdmitted() {
        return {
          reachableEndpoint: projectionEndpoint,
          capsBinding: Object.freeze({})
        }
      }
    },
    configuredBootstraps: [wire.endpoint],
    now() {
      if (armed) projectionEndpoint.fill(0)
      return 1_000n
    },
    randomBytes: (size) => b4a.alloc(size, 0x61)
  })
  await io.ready()
  await io.capsQuery(wire.endpoint, capsQuery(90))
  armed = true
  await io.activeChallenge(token, activeChallengeBytes())

  t.alike(observedEndpoint, wire.endpoint, 'the clock cannot redirect admitted authority')
  io.destroy()
})

test('active challenge reserves its global attempt budget before recursive directory reads', async (t) => {
  const wire = wireFixture({ activeResponse: activeResponseBytes() })
  const token = Object.freeze({})
  const recursive = []
  let io = null
  let reentered = false
  const candidateChecker = {
    isValidated: () => false,
    isAdmitted: (value) => value === token,
    readAdmitted() {
      if (!reentered) {
        reentered = true
        for (let index = 0; index < 5; index++) {
          recursive.push(
            io.activeChallenge(token, activeChallengeBytes()).then(
              () => 'accepted',
              (err) => err && err.code
            )
          )
        }
      }
      return {
        reachableEndpoint: b4a.from(wire.endpoint),
        capsBinding: Object.freeze({})
      }
    }
  }
  io = new BootstrapIO({
    socketFactory: () => wire.socket,
    candidateChecker,
    configuredBootstraps: [wire.endpoint],
    now: () => 1_000n,
    randomBytes: (size) => b4a.alloc(size, 0x62)
  })
  await io.ready()
  await io.capsQuery(wire.endpoint, capsQuery(91))
  await io.activeChallenge(token, activeChallengeBytes())
  await Promise.all(recursive)

  t.is(
    wire.sent.filter(
      (datagram) => decodeM3Object(datagram).messageId === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1
    ).length,
    3,
    'recursive reads cannot amplify direct challenge sends'
  )
  t.is(io.counters.activeValidationCount, 3, 'failed attempts remain charged to the budget')
  io.destroy()
})

test('BootstrapIO rejects hostile adapters and callbacks without broadening authority', async (t) => {
  const { configuredBootstraps, io } = fixture()
  await io.ready()
  const query = new Proxy(
    {},
    {
      get() {
        throw new Error('hostile')
      }
    }
  )
  let error = null
  try {
    await io.capsQuery(configuredBootstraps[0], query)
  } catch (err) {
    error = err
  }
  t.is(error && error.code, 'INVALID_ROUTE')
})

function guardSetup(branchClass = BRANCH_CLASS.LOOKUP) {
  return {
    branchClass,
    branchId: b4a.alloc(16, 0x11),
    circuitId: b4a.alloc(16, 0x22),
    generation: 1n,
    requestedLimits: {
      cellSize: 1200,
      maxCells: 100,
      maxBytes: 100_000,
      maxCommands: 10,
      idleTimeoutMs: 3_000,
      expiresAtMs: 5_000n
    }
  }
}

function guardCandidateChecker(validated, stateFactory) {
  const admissions = new WeakMap()
  let live = true
  let revokes = 0
  return {
    get revokes() {
      return revokes
    },
    isValidated: (value) => value === validated && live,
    reserveGuardAdmission(value, binding) {
      if (value !== validated || !live) throw new Error('spent validation')
      live = false
      const source = stateFactory()
      const admission = Object.freeze({})
      admissions.set(admission, {
        ...source,
        advertisementDigest: digestRelayCapabilityAdvertisement(source.advertisement, {
          now: 1_000n
        }),
        clientIdentity: b4a.from(binding.clientIdentity),
        branchClass: binding.branchClass,
        branchId: b4a.from(binding.branchId),
        circuitId: b4a.from(binding.circuitId),
        generation: binding.generation
      })
      return admission
    },
    readGuardAdmission(value) {
      if (!admissions.has(value)) throw new Error('spent admission')
      return admissions.get(value)
    },
    consumeGuardAdmission(value) {
      const state = this.readGuardAdmission(value)
      admissions.delete(value)
      return state
    },
    revokeGuardAdmission(value) {
      if (!admissions.delete(value)) return false
      revokes++
      return true
    }
  }
}

test('guard pin performs only OFFER then ACCEPT and transfers a new M3 link brand', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  const physical = Object.freeze({ id: 'physical-guard-channel', destroy() {} })
  const responderPhysical = Object.freeze({ destroy() {} })
  const predecessorEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 8]),
    port: 44000
  })
  let receivedOffer = null
  const responder = createIndexZeroGuardLinkResponder({
    advertisement: fixture.advertisement,
    responderIdentitySecretKey: fixture.signer.secretKey,
    responderRouteEncryptionSecretKey: fixture.route.secretKey,
    now: () => 1_000n,
    randomBytes: (size) => b4a.alloc(size, 0xe1),
    receiveOffer: () => ({
      offer: receivedOffer,
      observedPredecessorEndpoint: predecessorEndpoint,
      physicalChannel: responderPhysical
    })
  })
  const transcript = []
  let responderEstablished = null
  let handshakeDestroyed = 0
  const validatedState = () => ({
    ...decoded,
    relayIdentity: b4a.from(decoded.relayIdentity),
    reachableEndpoint: b4a.from(decoded.reachableEndpoint),
    routeEncryptionPublicKey: b4a.from(decoded.routeEncryptionPublicKey),
    advertisement: b4a.from(fixture.advertisement),
    challengeExpiresAtMs: 5_000n,
    cookieExpiresAtMs: 5_000n,
    queryNonce: b4a.alloc(32, 0xa1),
    returnRoutabilityCookie: b4a.alloc(32, 0xa2)
  })
  const io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {
        throw new Error('discovery send after PINNING')
      },
      async receive() {
        throw new Error('discovery receive after PINNING')
      },
      abort() {},
      destroy() {}
    }),
    candidateChecker: guardCandidateChecker(validated, validatedState),
    guardHandshakeFactory: {
      async openGuard(endpoint) {
        t.alike(endpoint, decoded.reachableEndpoint)
        let offer = null
        return {
          async sendOffer(value) {
            offer = b4a.from(value)
            receivedOffer = offer
            transcript.push(value.byteLength)
          },
          async receiveAccept() {
            const accepted = responder.accept()
            responderEstablished = accepted.established
            transcript.push(accepted.accept.byteLength)
            return accepted.accept
          },
          takePhysicalChannel() {
            return physical
          },
          destroy() {
            handshakeDestroyed++
          }
        }
      }
    },
    configuredBootstraps: [decoded.reachableEndpoint],
    now: () => 1_000n,
    randomBytes: sequence(0xd1)
  })
  await io.ready()
  const transfer = await io.pinGuard(validated, guardSetup())

  t.alike(transcript, [374, 285])
  t.ok(io.destroyed)
  t.is(handshakeDestroyed, 1)
  const moved = consumeBootstrapGuardLink(transfer)
  const link = readM3EstablishedLink(moved.established)
  t.is(link.physicalChannel, physical)
  t.is(link.extensionIndex, 0)
  t.alike(link.peerIdentity, decoded.relayIdentity)
  t.alike(link.branchId, guardSetup().branchId)
  t.ok(link.tailSharedSecret)
  t.is(link.tailControlTranscript.byteLength, 290)
  t.exception(
    () => readEstablishedLink(moved.established),
    'M2 topology-grant brand rejects M3 link'
  )
  destroyM3EstablishedLink(moved.established)
  destroyM3EstablishedLink(responderEstablished)
  responder.destroy()
})

test('manager construction request requires signed index-zero TAIL_READY before completion', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  const clientAuthority = new M3AdjacencyAuthority({ now: () => 1_000, crypto: cryptoSuite })
  const responderAuthority = new M3AdjacencyAuthority({ now: () => 1_000, crypto: cryptoSuite })
  const limits = Object.freeze(guardSetup().requestedLimits)
  const branch = (branchClass, byte) =>
    Object.freeze({
      branchClass,
      branchId: b4a.alloc(16, byte),
      circuitId: b4a.alloc(16, byte + 1),
      generation: BigInt(byte),
      clientCircuitIdentity: cryptoSuite.keyPair(seed(byte)),
      clientTailEphemeral: cryptoSuite.encryptionKeyPair(seed(byte + 1)),
      deadline: 5_000n,
      requestedLimits: limits
    })
  const construction = createBranchConstructionAuthority({
    lookup: branch(BRANCH_CLASS.LOOKUP, 0x31),
    announce: branch(BRANCH_CLASS.ANNOUNCE, 0x41),
    now: () => 1_000n,
    adjacencyAuthority: clientAuthority
  })
  const predecessorEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 18]),
    port: 44000
  })
  let receivedOffer = null
  const responder = createIndexZeroGuardLinkResponder({
    advertisement: fixture.advertisement,
    responderIdentitySecretKey: fixture.signer.secretKey,
    responderRouteEncryptionSecretKey: fixture.route.secretKey,
    now: () => 1_000n,
    randomBytes: sequence(0xa1),
    receiveOffer: () => ({
      offer: receivedOffer,
      observedPredecessorEndpoint: predecessorEndpoint,
      physicalChannel: Object.freeze({ destroy() {} })
    })
  })
  let responderResource = null
  let accepted = null
  const transcript = []
  const io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      abort() {},
      destroy() {}
    }),
    candidateChecker: guardCandidateChecker(validated, () => ({
      ...decoded,
      advertisement: fixture.advertisement,
      challengeExpiresAtMs: 5_000n,
      cookieExpiresAtMs: 5_000n,
      queryNonce: b4a.alloc(32, 0xb1),
      returnRoutabilityCookie: b4a.alloc(32, 0xb2)
    })),
    guardHandshakeFactory: {
      async openGuard() {
        return {
          async sendOffer(value) {
            receivedOffer = b4a.from(value)
            transcript.push(value.byteLength)
          },
          async receiveAccept() {
            accepted = responder.accept()
            transcript.push(accepted.accept.byteLength)
            return accepted.accept
          },
          async receiveReady() {
            const adopted = responderAuthority.adopt(accepted.established)
            const tailControl = createTailControlSession(adopted.tail, {
              now: () => 1_000,
              crypto: cryptoSuite
            })
            responderResource = { runtime: adopted.runtime, tailControl }
            const ready = tailControl.sealReady({
              identitySecretKey: fixture.signer.secretKey,
              randomBytes: (size) => b4a.alloc(size, 0xb3)
            })
            transcript.push(ready.byteLength)
            return ready
          },
          takePhysicalChannel() {
            return Object.freeze({ destroy() {} })
          },
          destroy() {}
        }
      }
    },
    configuredBootstraps: [decoded.reachableEndpoint],
    constructionRequest: construction.bootstrapRequest,
    now: () => 1_000n,
    randomBytes: sequence(0xc1)
  })
  await io.ready()
  const ready = await io.pinGuard(validated)

  t.alike(transcript, [374, 285, 1101])
  t.ok(consumeBootstrapGuardReady(ready))
  t.exception(() => consumeBootstrapGuardReady(ready), 'guard-ready transfer is one-use')
  t.alike(construction.diagnostics(), { state: 'ACTIVE', completedBranches: 1 })
  t.ok(construction.destroy(), 'paired authority owns the completed branch')
  responderResource.tailControl.destroy()
  responderResource.runtime.destroy()
  responder.destroy()
})

test('GuardRevalidationIO is pinned to one exact self advertisement and reaches TAIL_READY', async (t) => {
  for (const reentrantDestroy of [false, true]) {
    const fixture = signedAdvertisementFixture()
    const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
    const clientAuthority = new M3AdjacencyAuthority({ now: () => 1_000, crypto: cryptoSuite })
    const responderAuthority = new M3AdjacencyAuthority({ now: () => 1_000, crypto: cryptoSuite })
    const limits = Object.freeze(guardSetup().requestedLimits)
    const branch = (branchClass, byte) =>
      Object.freeze({
        branchClass,
        branchId: b4a.alloc(16, byte),
        circuitId: b4a.alloc(16, byte + 1),
        generation: BigInt(byte),
        clientCircuitIdentity: cryptoSuite.keyPair(seed(byte)),
        clientTailEphemeral: cryptoSuite.encryptionKeyPair(seed(byte + 1)),
        deadline: 5_000n,
        requestedLimits: limits
      })
    const construction = createBranchConstructionAuthority({
      lookup: branch(BRANCH_CLASS.LOOKUP, 0x51),
      announce: branch(BRANCH_CLASS.ANNOUNCE, 0x61),
      now: () => 1_000n,
      adjacencyAuthority: clientAuthority
    })
    const bootstrapSession = takeBranchConstructionRequest(construction.bootstrapRequest)
    initializeBranchGuardLease(bootstrapSession, fixture.advertisement)
    completeBranchConstruction(
      bootstrapSession,
      Object.freeze({
        destroy() {}
      })
    )

    const validated = Object.freeze({})
    const admissions = new WeakMap()
    const validatedState = () => ({
      ...decoded,
      relayIdentity: b4a.from(decoded.relayIdentity),
      reachableEndpoint: b4a.from(decoded.reachableEndpoint),
      routeEncryptionPublicKey: b4a.from(decoded.routeEncryptionPublicKey),
      advertisement: b4a.from(fixture.advertisement),
      challengeExpiresAtMs: 5_000n,
      cookieExpiresAtMs: 5_000n,
      queryNonce: b4a.alloc(32, 0xd1),
      returnRoutabilityCookie: b4a.alloc(32, 0xd2)
    })
    const directory = guardCandidateChecker(validated, validatedState)
    directory.admit = (advertisement, { observedEndpoint, capsBinding }) => {
      const admitted = Object.freeze({})
      admissions.set(admitted, {
        advertisement: b4a.from(advertisement),
        reachableEndpoint: b4a.from(observedEndpoint),
        capsBinding: Object.freeze({
          queryNonce: b4a.from(capsBinding.queryNonce),
          cookieExpiresAtMs: capsBinding.cookieExpiresAtMs,
          returnRoutabilityCookie: b4a.from(capsBinding.returnRoutabilityCookie)
        })
      })
      return admitted
    }
    directory.isAdmitted = (value) => admissions.has(value)
    directory.readAdmitted = (value) => admissions.get(value)
    directory.validate = async (admitted, challenge) => {
      await challenge(activeChallengeBytes())
      return admissions.has(admitted) ? validated : null
    }
    directory.read = (value) => {
      if (value !== validated) throw new Error('not validated')
      return validatedState()
    }

    const wire = wireFixture({ activeResponse: activeResponseBytes() })
    let receivedOffer = null
    let accepted = null
    let responderResource = null
    let physicalCloses = 0
    const responder = createIndexZeroGuardLinkResponder({
      advertisement: fixture.advertisement,
      responderIdentitySecretKey: fixture.signer.secretKey,
      responderRouteEncryptionSecretKey: fixture.route.secretKey,
      now: () => 1_000n,
      randomBytes: sequence(0xe1),
      receiveOffer: () => ({
        offer: receivedOffer,
        observedPredecessorEndpoint: decoded.reachableEndpoint,
        physicalChannel: Object.freeze({ destroy() {} })
      })
    })
    const io = new GuardRevalidationIO({
      constructionRequest: construction.revalidationRequest,
      socketFactory: () => wire.socket,
      directory,
      guardHandshakeFactory: {
        async openGuard() {
          return {
            async sendOffer(value) {
              receivedOffer = b4a.from(value)
            },
            async receiveAccept() {
              accepted = responder.accept()
              return accepted.accept
            },
            async receiveReady() {
              const adopted = responderAuthority.adopt(accepted.established)
              const tailControl = createTailControlSession(adopted.tail, {
                now: () => 1_000,
                crypto: cryptoSuite
              })
              responderResource = { runtime: adopted.runtime, tailControl }
              const ready = tailControl.sealReady({
                identitySecretKey: fixture.signer.secretKey,
                randomBytes: (size) => b4a.alloc(size, 0xe2)
              })
              if (reentrantDestroy) io.destroy()
              return ready
            },
            takePhysicalChannel() {
              return Object.freeze({
                destroy() {
                  physicalCloses++
                }
              })
            },
            destroy() {}
          }
        }
      },
      now: () => 1_000n,
      randomBytes: sequence(0xf1)
    })
    t.alike(
      Reflect.ownKeys(io),
      [],
      'guard-only actor exposes no nested IO, session, or pinned bytes'
    )
    t.alike(
      Object.getOwnPropertyNames(Object.getPrototypeOf(io)),
      ['constructor', 'open', 'diagnostics', 'destroy'],
      'guard-only actor exposes no referral or arbitrary probe surface'
    )
    let transfer = null
    let failure = null
    try {
      transfer = await io.open()
    } catch (err) {
      failure = err
    }

    if (reentrantDestroy) {
      t.ok(failure, 'queued destroy before publication fails closed')
      t.is(transfer, null, 'destroyed revalidation actor publishes no transfer')
      t.alike(construction.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })
      t.is(physicalCloses, 1, 'the adopted branch channel closes exactly once')
      t.absent(construction.destroy(), 'paired construction was already terminalized')
      responderResource.tailControl.destroy()
      responderResource.runtime.destroy()
      responder.destroy()
      continue
    }

    t.ok(consumeGuardRevalidationReady(transfer))
    t.exception(() => consumeGuardRevalidationReady(transfer), 'revalidation transfer is one-use')
    t.alike(
      wire.sent.map((encoded) => decodeM3Object(encoded).messageId),
      [M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.CAPS_QUERY_V1, M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1]
    )
    t.alike(construction.diagnostics(), { state: 'ACTIVE', completedBranches: 2 })
    construction.destroy()
    t.is(physicalCloses, 1, 'authority teardown closes the completed branch exactly once')
    responderResource.tailControl.destroy()
    responderResource.runtime.destroy()
    responder.destroy()
  }
})

test('PINNING rejects reentrant direct IO before awaiting the guard channel', async (t) => {
  for (const source of ['checkerGetter', 'isValidated', 'clock', 'randomBytes', 'openGuard']) {
    const fixture = signedAdvertisementFixture()
    const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
    const validated = Object.freeze({})
    const admitted = Object.freeze({})
    let io = null
    let directSends = 0
    let reentered = false
    let randomCalls = 0
    const reentrySettlements = []
    const candidateChecker = guardCandidateChecker(validated, () => ({
      ...decoded,
      advertisement: fixture.advertisement,
      challengeExpiresAtMs: 5_000n,
      cookieExpiresAtMs: 5_000n,
      queryNonce: b4a.alloc(32, 0xa1),
      returnRoutabilityCookie: b4a.alloc(32, 0xa2)
    }))
    candidateChecker.isAdmitted = (value) => value === admitted
    candidateChecker.readAdmitted = () => ({
      reachableEndpoint: decoded.reachableEndpoint,
      capsBinding: Object.freeze({})
    })
    const originalIsValidated = candidateChecker.isValidated
    const reenter = () => {
      if (reentered) return
      reentered = true
      for (const operation of [
        () => io.capsQuery(decoded.reachableEndpoint, capsQuery(230)),
        () => io.legacyFindNode(decoded.reachableEndpoint, seed(231)),
        () => io.activeChallenge(admitted, activeChallengeBytes())
      ]) {
        reentrySettlements.push(
          operation().then(
            () => 'RESOLVED',
            (err) => err && err.code
          )
        )
      }
    }
    candidateChecker.isValidated = (value) => {
      if (source === 'isValidated') reenter()
      return originalIsValidated(value)
    }
    const originalReserveGuardAdmission = candidateChecker.reserveGuardAdmission
    Object.defineProperty(candidateChecker, 'reserveGuardAdmission', {
      get() {
        if (source === 'checkerGetter') reenter()
        return originalReserveGuardAdmission
      }
    })
    io = new BootstrapIO({
      socketFactory: () => ({
        async bind() {},
        async send() {
          directSends++
        },
        async receive() {
          throw new Error('stop direct receive')
        },
        async legacyFindNode() {
          directSends++
          return []
        },
        abort() {},
        destroy() {}
      }),
      candidateChecker,
      guardHandshakeFactory: {
        async openGuard() {
          if (source === 'openGuard') reenter()
          throw new Error('stop after authority trap')
        }
      },
      configuredBootstraps: [decoded.reachableEndpoint],
      now() {
        if (source === 'clock') reenter()
        return 1_000n
      },
      randomBytes(size) {
        if (source === 'randomBytes' && randomCalls === 0) reenter()
        randomCalls++
        return b4a.alloc(size, 0xd5 + randomCalls)
      }
    })
    await io.ready()
    let code = null
    await io.pinGuard(validated, guardSetup()).catch((err) => {
      code = err && err.code
    })
    t.is(code, 'ERR_AUTHENTICATION', source)
    t.ok(reentered, `${source} attempted reentrant direct IO`)
    t.alike(
      await Promise.all(reentrySettlements),
      ['ERR_DESTROYED', 'ERR_DESTROYED', 'ERR_DESTROYED'],
      `${source} cannot reenter CAPS, legacy, or active challenge IO`
    )
    t.is(directSends, 0, `${source} causes zero direct sends`)
    t.is(candidateChecker.revokes, 1, source)
    t.ok(io.destroyed, source)
  }
})

test('guard open cannot revive PINNING after destroying the bootstrap authority', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  let io = null
  let channelCloses = 0
  const candidateChecker = guardCandidateChecker(validated, () => ({
    ...decoded,
    advertisement: fixture.advertisement,
    challengeExpiresAtMs: 5_000n,
    cookieExpiresAtMs: 5_000n,
    queryNonce: b4a.alloc(32, 0xa1),
    returnRoutabilityCookie: b4a.alloc(32, 0xa2)
  }))
  io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      abort() {},
      destroy() {}
    }),
    candidateChecker,
    guardHandshakeFactory: {
      async openGuard() {
        io.destroy()
        return {
          async sendOffer() {},
          async receiveAccept() {},
          takePhysicalChannel() {},
          destroy() {
            channelCloses++
          }
        }
      }
    },
    configuredBootstraps: [decoded.reachableEndpoint],
    now: () => 1_000n,
    randomBytes: sequence(0xee)
  })
  await io.ready()

  let code = null
  await io.pinGuard(validated, guardSetup()).catch((err) => {
    code = err && err.code
  })

  t.is(code, 'ERR_DESTROYED')
  t.is(channelCloses, 1, 'returned channel ownership is closed exactly once')
  t.is(candidateChecker.revokes, 1, 'pending admission is revoked through the saved authority')
  t.ok(io.destroyed)
})

test('guard timer registration cannot queue an open after destroying PINNING', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  let io = null
  let arming = false
  let opens = 0
  const candidateChecker = guardCandidateChecker(validated, () => ({
    ...decoded,
    advertisement: fixture.advertisement,
    challengeExpiresAtMs: 5_000n,
    cookieExpiresAtMs: 5_000n,
    queryNonce: b4a.alloc(32, 0xa1),
    returnRoutabilityCookie: b4a.alloc(32, 0xa2)
  }))
  io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      abort() {},
      destroy() {}
    }),
    candidateChecker,
    guardHandshakeFactory: {
      async openGuard() {
        opens++
      }
    },
    configuredBootstraps: [decoded.reachableEndpoint],
    now: () => 1_000n,
    randomBytes: sequence(0xef),
    setTimeout() {
      if (arming) io.destroy()
      return Object.freeze({})
    },
    clearTimeout() {}
  })
  await io.ready()
  arming = true

  let code = null
  await io.pinGuard(validated, guardSetup()).catch((err) => {
    code = err && err.code
  })

  t.is(code, 'ERR_DESTROYED')
  t.is(opens, 0)
  t.is(candidateChecker.revokes, 1)
  t.ok(io.destroyed)
})

test('immediate terminal transition prevents an already queued guard open', async (t) => {
  for (const terminal of ['destroy', 'privateReady']) {
    const fixture = signedAdvertisementFixture()
    const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
    const validated = Object.freeze({})
    let opens = 0
    const candidateChecker = guardCandidateChecker(validated, () => ({
      ...decoded,
      advertisement: fixture.advertisement,
      challengeExpiresAtMs: 5_000n,
      cookieExpiresAtMs: 5_000n,
      queryNonce: b4a.alloc(32, 0xa1),
      returnRoutabilityCookie: b4a.alloc(32, 0xa2)
    }))
    const io = new BootstrapIO({
      socketFactory: () => ({
        async bind() {},
        async send() {},
        async receive() {},
        abort() {},
        destroy() {}
      }),
      candidateChecker,
      guardHandshakeFactory: {
        async openGuard() {
          opens++
        }
      },
      configuredBootstraps: [decoded.reachableEndpoint],
      now: () => 1_000n,
      randomBytes: sequence(0xf0)
    })
    await io.ready()

    const pinning = io.pinGuard(validated, guardSetup())
    if (terminal === 'destroy') io.destroy()
    else await io.privateReady()
    let code = null
    await pinning.catch((err) => {
      code = err && err.code
    })

    t.is(code, 'ERR_DESTROYED', terminal)
    t.is(opens, 0, terminal)
    t.is(candidateChecker.revokes, 1, terminal)
    t.ok(io.destroyed, terminal)
  }
})

test('queued guard OFFER cannot run after a terminal channel-method getter', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  let io = null
  let sendReads = 0
  let sends = 0
  let receives = 0
  let closes = 0
  io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      abort() {},
      destroy() {}
    }),
    candidateChecker: guardCandidateChecker(validated, () => ({
      ...decoded,
      advertisement: fixture.advertisement,
      challengeExpiresAtMs: 5_000n,
      cookieExpiresAtMs: 5_000n,
      queryNonce: b4a.alloc(32, 0xa1),
      returnRoutabilityCookie: b4a.alloc(32, 0xa2)
    })),
    guardHandshakeFactory: {
      async openGuard() {
        return {
          get sendOffer() {
            sendReads++
            if (sendReads === 1) Promise.resolve().then(() => io.destroy())
            return async () => {
              sends++
            }
          },
          async receiveAccept() {
            receives++
          },
          takePhysicalChannel() {},
          destroy() {
            closes++
          }
        }
      }
    },
    configuredBootstraps: [decoded.reachableEndpoint],
    now: () => 1_000n,
    randomBytes: sequence(0xf1)
  })
  await io.ready()

  let code = null
  await io.pinGuard(validated, guardSetup()).catch((err) => {
    code = err && err.code
  })

  t.is(code, 'ERR_DESTROYED')
  t.is(sends, 0)
  t.is(receives, 0)
  t.is(closes, 1)
  t.ok(io.destroyed)
})

test('terminal guard-channel close transfers ownership before invoking the callback', async (t) => {
  for (const terminal of ['destroy', 'privateReady']) {
    const fixture = signedAdvertisementFixture()
    const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
    const validated = Object.freeze({})
    const predecessorEndpoint = encodeCanonicalEndpoint({
      addressFamily: 4,
      addressBytes: b4a.from([198, 51, 100, 9]),
      port: 44001
    })
    let receivedOffer = null
    let responderEstablished = null
    let channelCloses = 0
    let physicalCloses = 0
    let io = null
    const responder = createIndexZeroGuardLinkResponder({
      advertisement: fixture.advertisement,
      responderIdentitySecretKey: fixture.signer.secretKey,
      responderRouteEncryptionSecretKey: fixture.route.secretKey,
      now: () => 1_000n,
      randomBytes: (size) => b4a.alloc(size, 0xf2),
      receiveOffer: () => ({
        offer: receivedOffer,
        observedPredecessorEndpoint: predecessorEndpoint,
        physicalChannel: { destroy() {} }
      })
    })
    io = new BootstrapIO({
      socketFactory: () => ({
        async bind() {},
        async send() {},
        async receive() {},
        abort() {},
        destroy() {}
      }),
      candidateChecker: guardCandidateChecker(validated, () => ({
        ...decoded,
        advertisement: fixture.advertisement,
        challengeExpiresAtMs: 5_000n,
        cookieExpiresAtMs: 5_000n,
        queryNonce: b4a.alloc(32, 0xa1),
        returnRoutabilityCookie: b4a.alloc(32, 0xa2)
      })),
      guardHandshakeFactory: {
        async openGuard() {
          return {
            async sendOffer(value) {
              receivedOffer = b4a.from(value)
            },
            async receiveAccept() {
              const accepted = responder.accept()
              responderEstablished = accepted.established
              return accepted.accept
            },
            takePhysicalChannel() {
              return {
                destroy() {
                  physicalCloses++
                }
              }
            },
            destroy() {
              channelCloses++
              if (terminal === 'destroy') io.destroy()
              else void io.privateReady()
            }
          }
        }
      },
      configuredBootstraps: [decoded.reachableEndpoint],
      now: () => 1_000n,
      randomBytes: sequence(0xf3)
    })
    await io.ready()

    let code = null
    await io.pinGuard(validated, guardSetup()).catch((err) => {
      code = err && err.code
    })

    t.is(code, 'ERR_DESTROYED', terminal)
    t.is(channelCloses, 1, terminal)
    t.is(physicalCloses, 1, terminal)
    t.ok(io.destroyed, terminal)
    destroyM3EstablishedLink(responderEstablished)
    responder.destroy()
  }
})

test('guard pin rejects the exact active-challenge expiry boundary before opening a channel', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  let opens = 0
  let candidateChecker = null
  const io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      abort() {},
      destroy() {}
    }),
    candidateChecker: (candidateChecker = guardCandidateChecker(validated, () => ({
      ...decoded,
      advertisement: fixture.advertisement,
      challengeExpiresAtMs: 1_000n,
      cookieExpiresAtMs: 5_000n,
      queryNonce: b4a.alloc(32, 0xa1),
      returnRoutabilityCookie: b4a.alloc(32, 0xa2)
    }))),
    guardHandshakeFactory: {
      async openGuard() {
        opens++
      }
    },
    configuredBootstraps: [decoded.reachableEndpoint],
    now: () => 1_000n,
    randomBytes: sequence(0xd6)
  })
  await io.ready()
  let code = null
  await io.pinGuard(validated, guardSetup()).catch((err) => {
    code = err && err.code
  })
  t.is(code, 'ERR_AUTHENTICATION')
  t.is(opens, 0)
  t.is(candidateChecker.revokes, 1)
  t.ok(io.destroyed)
})

test('invalid guard ACCEPT closes transferred physical ownership exactly once', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  let closes = 0
  const io = new BootstrapIO({
    socketFactory: () => ({
      async bind() {},
      async send() {},
      async receive() {},
      abort() {},
      destroy() {}
    }),
    candidateChecker: guardCandidateChecker(validated, () => ({
      ...decoded,
      advertisement: fixture.advertisement,
      challengeExpiresAtMs: 5_000n,
      cookieExpiresAtMs: 5_000n
    })),
    guardHandshakeFactory: {
      async openGuard() {
        return {
          async sendOffer() {},
          async receiveAccept() {
            return b4a.alloc(285)
          },
          takePhysicalChannel() {
            return {
              destroy() {
                closes++
              }
            }
          },
          destroy() {}
        }
      }
    },
    configuredBootstraps: [decoded.reachableEndpoint],
    now: () => 1_000n,
    randomBytes: sequence(0xe9)
  })
  await io.ready()
  await t.exception(io.pinGuard(validated, guardSetup()))
  t.is(closes, 1)
  t.ok(io.destroyed)
})

test('two BootstrapIO instances sharing one validation emit exactly one OFFER', async (t) => {
  const fixture = signedAdvertisementFixture()
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: 1_000n })
  const validated = Object.freeze({})
  const admissions = new WeakMap()
  let validationLive = true
  let offers = 0
  let opens = 0
  const validatedState = () => ({
    ...decoded,
    relayIdentity: b4a.from(decoded.relayIdentity),
    reachableEndpoint: b4a.from(decoded.reachableEndpoint),
    advertisement: b4a.from(fixture.advertisement),
    challengeExpiresAtMs: 5_000n,
    cookieExpiresAtMs: 5_000n,
    queryNonce: b4a.alloc(32, 0xa1),
    returnRoutabilityCookie: b4a.alloc(32, 0xa2)
  })
  const checker = {
    isValidated: (value) => value === validated && validationLive,
    read: validatedState,
    consumeValidated(value) {
      if (value !== validated || !validationLive) throw new Error('spent')
      validationLive = false
      return validatedState()
    },
    revokeValidated() {
      validationLive = false
      return true
    },
    reserveGuardAdmission(value, binding) {
      if (value !== validated || !validationLive) throw new Error('spent')
      validationLive = false
      const admission = Object.freeze({})
      admissions.set(admission, {
        ...validatedState(),
        advertisementDigest: digestRelayCapabilityAdvertisement(fixture.advertisement, {
          now: 1_000n
        }),
        ...binding
      })
      return admission
    },
    readGuardAdmission(value) {
      if (!admissions.has(value)) throw new Error('spent')
      return admissions.get(value)
    },
    consumeGuardAdmission(value) {
      const state = this.readGuardAdmission(value)
      admissions.delete(value)
      return state
    },
    revokeGuardAdmission(value) {
      return admissions.delete(value)
    }
  }
  const createIO = () =>
    new BootstrapIO({
      socketFactory: () => ({
        async bind() {},
        async send() {},
        async receive() {},
        abort() {},
        destroy() {}
      }),
      candidateChecker: checker,
      guardHandshakeFactory: {
        async openGuard() {
          opens++
          return {
            async sendOffer() {
              offers++
            },
            async receiveAccept() {
              throw new Error('stop after OFFER')
            },
            takePhysicalChannel() {
              throw new Error('unreachable')
            },
            destroy() {}
          }
        }
      },
      configuredBootstraps: [decoded.reachableEndpoint],
      now: () => 1_000n,
      randomBytes: sequence(0xe8)
    })
  const left = createIO()
  const right = createIO()
  await Promise.all([left.ready(), right.ready()])
  await Promise.allSettled([
    left.pinGuard(validated, guardSetup()),
    right.pinGuard(validated, guardSetup())
  ])
  t.is(opens, 1)
  t.is(offers, 1)
})
