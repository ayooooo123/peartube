import b4a from 'b4a'
import sodium from 'sodium-universal'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  MAX_CAPABILITY_ADVERTISEMENTS,
  createActiveChallengeResponderAuthority,
  decodeCanonicalEndpoint,
  decodeRelayCapabilityAdvertisement,
  digestRelayCapabilityAdvertisement
} from './relay-capability.js'
import { M3_MESSAGE_ID, M3_PROTOCOL_VERSION, decodeM3Object, encodeM3Object } from './protocol.js'

const CAPS_RESPONSE_DOMAIN = b4a.from('hyperdht-private-routes/m3/caps-response/v1')
const CORE_FRAGMENT_DOMAIN = b4a.from('hyperdht-private-routes/m3/core-fragment/object/v1')
const KNOWN_CAPABILITY_MASK = 0x00000007
const CAPS_COOKIE_LIFETIME = 5_000n
const MAX_CAPS_REPLAY_ENTRIES = 4_096
const DIRECT_DATAGRAM_BYTES = 1_200
const DIRECT_FRAGMENT_DATA_BYTES = 1_144
const DIRECT_FRAGMENT_COUNT = 11
const CORE_OBJECT_BYTES = 12_288

const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray
const fillIntrinsic = Uint8Array.prototype.fill

function incompatible() {
  throw PrivateRouteError.ERR_INCOMPATIBLE_RELAY()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function get(value, name) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) incompatible()
    return value[name]
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    incompatible()
  }
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function set(target, source, offset = 0) {
  try {
    setIntrinsic.call(target, source, offset)
  } catch {
    incompatible()
  }
}

function subarray(value, start, end) {
  try {
    return subarrayIntrinsic.call(value, start, end)
  } catch {
    incompatible()
  }
}

function copy(value, expected = null) {
  const size = length(value)
  if (size < 0 || (expected !== null && size !== expected)) incompatible()
  const output = b4a.allocUnsafeSlow(size)
  set(output, value)
  return output
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {
    // JavaScript zeroization is best-effort.
  }
}

function equal(left, right) {
  try {
    return length(left) === length(right) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function writeUint16(output, value, offset) {
  output[offset] = value >>> 8
  output[offset + 1] = value
}

function writeUint32(output, value, offset) {
  output[offset] = value >>> 24
  output[offset + 1] = value >>> 16
  output[offset + 2] = value >>> 8
  output[offset + 3] = value
}

function writeUint64(output, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint16(input, offset) {
  return (input[offset] << 8) | input[offset + 1]
}

function readUint32(input, offset) {
  return (
    input[offset] * 0x1000000 +
    (input[offset + 1] << 16) +
    (input[offset + 2] << 8) +
    input[offset + 3]
  )
}

function readUint64(input, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(input[index])
  }
  return value
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn
}

function signatureInput(domain, messageId, body) {
  const output = b4a.allocUnsafe(2 + domain.byteLength + 8 + body.byteLength)
  writeUint16(output, domain.byteLength, 0)
  set(output, domain, 2)
  writeUint32(output, M3_PROTOCOL_VERSION, 2 + domain.byteLength)
  writeUint16(output, messageId, 6 + domain.byteLength)
  writeUint16(output, body.byteLength, 8 + domain.byteLength)
  set(output, body, 10 + domain.byteLength)
  return output
}

function parseQuery(datagram) {
  const object = decodeM3Object(datagram)
  if (object.messageId !== M3_MESSAGE_ID.CAPS_QUERY_V1 || length(datagram) !== 118) incompatible()
  const body = object.body
  const requestedCapabilityMask = readUint32(body, 0)
  const maximumResults = body[68]
  const cookiePhase = body[69]
  const cookieExpiresAtMs = readUint64(body, 70)
  const returnRoutabilityCookie = copy(subarray(body, 78, 110), 32)
  if (
    requestedCapabilityMask === 0 ||
    requestedCapabilityMask & ~KNOWN_CAPABILITY_MASK ||
    maximumResults < 1 ||
    maximumResults > MAX_CAPABILITY_ADVERTISEMENTS ||
    (cookiePhase !== 0 && cookiePhase !== 1)
  ) {
    clear(returnRoutabilityCookie)
    incompatible()
  }
  let zeroCookie = true
  for (let index = 0; index < 32; index++)
    zeroCookie = zeroCookie && returnRoutabilityCookie[index] === 0
  if (
    (cookiePhase === 0 && (cookieExpiresAtMs !== 0n || !zeroCookie)) ||
    (cookiePhase === 1 && (cookieExpiresAtMs === 0n || zeroCookie))
  ) {
    clear(returnRoutabilityCookie)
    incompatible()
  }
  return {
    body,
    requestedCapabilityMask,
    randomTarget: copy(subarray(body, 4, 36), 32),
    queryNonce: copy(subarray(body, 36, 68), 32),
    maximumResults,
    cookiePhase,
    cookieExpiresAtMs,
    returnRoutabilityCookie
  }
}

function clearQuery(query) {
  if (!query) return
  clear(query.body)
  clear(query.randomTarget)
  clear(query.queryNonce)
  clear(query.returnRoutabilityCookie)
}

function queryAuthorityValue(query, sourceEndpoint) {
  return {
    sourceEndpoint,
    requestedCapabilityMask: query.requestedCapabilityMask,
    randomTarget: query.randomTarget,
    queryNonce: query.queryNonce,
    maximumResults: query.maximumResults,
    cookieExpiresAtMs: query.cookieExpiresAtMs,
    returnRoutabilityCookie: query.returnRoutabilityCookie
  }
}

function challengeFor(query, cookie) {
  const body = b4a.allocUnsafe(72)
  try {
    set(body, query.queryNonce, 0)
    writeUint64(body, cookie.cookieExpiresAtMs, 32)
    set(body, cookie.returnRoutabilityCookie, 40)
    return encodeM3Object({ messageId: M3_MESSAGE_ID.CAPS_COOKIE_CHALLENGE_V1, body })
  } finally {
    clear(body)
  }
}

function xorCompare(left, right, target) {
  for (let index = 0; index < 32; index++) {
    const leftByte = left.currentDhtNodeId[index] ^ target[index]
    const rightByte = right.currentDhtNodeId[index] ^ target[index]
    if (leftByte !== rightByte) return leftByte - rightByte
  }
  const identityOrder = b4a.compare(left.relayIdentity, right.relayIdentity)
  if (identityOrder !== 0) return identityOrder
  return left.epoch < right.epoch ? -1 : left.epoch > right.epoch ? 1 : 0
}

function responseBody(identity, query, advertisements, now) {
  let bytes = 73
  for (const advertisement of advertisements) bytes += 2 + length(advertisement.encoded)
  const body = b4a.allocUnsafe(bytes)
  let offset = 0
  set(body, identity, offset)
  offset += 32
  set(body, query.queryNonce, offset)
  offset += 32
  writeUint64(body, now, offset)
  offset += 8
  body[offset++] = advertisements.length
  for (const advertisement of advertisements) {
    writeUint16(body, length(advertisement.encoded), offset)
    offset += 2
    set(body, advertisement.encoded, offset)
    offset += length(advertisement.encoded)
  }
  return body
}

function fragmentsFor(complete, crypto) {
  if (length(complete) <= DIRECT_DATAGRAM_BYTES) return [copy(complete)]
  if (length(complete) > CORE_OBJECT_BYTES) incompatible()
  const fragmentCount = Math.ceil(length(complete) / DIRECT_FRAGMENT_DATA_BYTES)
  if (fragmentCount > DIRECT_FRAGMENT_COUNT) incompatible()
  const digest = crypto.hash([CORE_FRAGMENT_DOMAIN, complete])
  const outputs = []
  try {
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
      const fragmentOffset = fragmentIndex * DIRECT_FRAGMENT_DATA_BYTES
      const fragmentData = subarray(
        complete,
        fragmentOffset,
        Math.min(fragmentOffset + DIRECT_FRAGMENT_DATA_BYTES, length(complete))
      )
      const body = b4a.allocUnsafe(48 + length(fragmentData))
      try {
        writeUint16(body, M3_MESSAGE_ID.CAPS_RESPONSE_V1, 0)
        set(body, digest, 2)
        writeUint32(body, length(complete), 34)
        writeUint16(body, fragmentIndex, 38)
        writeUint16(body, fragmentCount, 40)
        writeUint32(body, fragmentOffset, 42)
        writeUint16(body, length(fragmentData), 46)
        set(body, fragmentData, 48)
        outputs.push(encodeM3Object({ messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1, body }))
      } finally {
        clear(body)
      }
    }
    return outputs
  } finally {
    clear(digest)
  }
}

function clearResponseEntry(entry) {
  clear(entry.retry)
  clear(entry.sourceEndpoint)
  clear(entry.queryNonce)
  clear(entry.returnRoutabilityCookie)
  for (const datagram of entry.datagrams) clear(datagram)
  entry.datagrams.length = 0
}

function copies(values) {
  return values.map((value) => copy(value))
}

function cookieKey(cookie) {
  return b4a.toString(cookie, 'hex')
}

export class CapsResponder {
  constructor(options = {}) {
    let advertisement = null
    let identitySecretKey = null
    let routeEncryptionSecretKey = null
    let identity = null
    let endpoint = null
    let decoded = null
    let routePublicKey = null
    let active = null
    let transferred = false
    try {
      const now = get(options, 'now')
      advertisement = copy(get(options, 'advertisement'))
      identitySecretKey = copy(get(options, 'identitySecretKey'), 64)
      routeEncryptionSecretKey = copy(get(options, 'routeEncryptionSecretKey'), 32)
      const selectOption = get(options, 'selectAdvertisements')
      const cryptoOption = get(options, 'crypto')
      const setTimerOption = get(options, 'setTimeout')
      const clearTimerOption = get(options, 'clearTimeout')
      const maximumOption = get(options, 'maxReplayEntries')
      const selectAdvertisements = selectOption === undefined ? () => [advertisement] : selectOption
      const crypto = cryptoOption === undefined ? cryptoSuite : cryptoOption
      const setTimer = setTimerOption === undefined ? globalThis.setTimeout : setTimerOption
      const clearTimer = clearTimerOption === undefined ? globalThis.clearTimeout : clearTimerOption
      const maxReplayEntries = maximumOption === undefined ? MAX_CAPS_REPLAY_ENTRIES : maximumOption
      if (
        typeof now !== 'function' ||
        typeof selectAdvertisements !== 'function' ||
        typeof get(crypto, 'randomBytes') !== 'function' ||
        typeof get(crypto, 'keyAgreement') !== 'function' ||
        typeof get(crypto, 'sign') !== 'function' ||
        typeof get(crypto, 'hash') !== 'function' ||
        typeof setTimer !== 'function' ||
        typeof clearTimer !== 'function' ||
        !Number.isSafeInteger(maxReplayEntries) ||
        maxReplayEntries < 1 ||
        maxReplayEntries > MAX_CAPS_REPLAY_ENTRIES
      ) {
        incompatible()
      }
      const current = now()
      if (!uint64(current)) incompatible()
      decoded = decodeRelayCapabilityAdvertisement(advertisement, { now: current })
      if (!equal(subarray(identitySecretKey, 32, 64), decoded.relayIdentity)) authentication()
      routePublicKey = b4a.allocUnsafeSlow(32)
      sodium.crypto_scalarmult_base(routePublicKey, routeEncryptionSecretKey)
      if (!equal(routePublicKey, decoded.routeEncryptionPublicKey)) authentication()
      identity = copy(decoded.relayIdentity, 32)
      endpoint = copy(decoded.reachableEndpoint, 19)
      active = createActiveChallengeResponderAuthority({
        now,
        crypto,
        setTimeout: setTimer,
        clearTimeout: clearTimer,
        maxBindings: maxReplayEntries
      })

      this._now = now
      this._selectAdvertisements = selectAdvertisements
      this._crypto = crypto
      this._advertisement = advertisement
      this._identity = identity
      this._endpoint = endpoint
      this._identitySecretKey = identitySecretKey
      this._routeEncryptionSecretKey = routeEncryptionSecretKey
      this._maxReplayEntries = maxReplayEntries
      this._responses = new Map()
      this._pendingResponses = new Map()
      this._generation = 0
      this._destroyed = false
      this._active = active
      transferred = true
    } finally {
      clear(routePublicKey)
      if (!transferred) {
        try {
          active?.destroy()
        } catch {}
        clear(advertisement)
        clear(identitySecretKey)
        clear(routeEncryptionSecretKey)
        clear(identity)
        clear(endpoint)
      }
    }
  }

  _assertLive() {
    if (this._destroyed) throw PrivateRouteError.ERR_DESTROYED()
  }

  _assertGeneration(generation) {
    if (this._destroyed || this._generation !== generation) {
      throw PrivateRouteError.ERR_DESTROYED()
    }
  }

  _expire(now) {
    for (const [key, entry] of this._responses) {
      if (entry.expiresAtMs > now) continue
      this._responses.delete(key)
      clearResponseEntry(entry)
    }
  }

  _select(query, now) {
    const selectionQuery = Object.freeze({
      requestedCapabilityMask: query.requestedCapabilityMask,
      randomTarget: copy(query.randomTarget, 32),
      queryNonce: copy(query.queryNonce, 32),
      maximumResults: query.maximumResults,
      now
    })
    let selected
    try {
      selected = this._selectAdvertisements(selectionQuery)
      if (!Array.isArray(selected)) incompatible()
      if (selected.length < 1 || selected.length > query.maximumResults) incompatible()
      const advertisements = []
      const identities = new Set()
      const digests = new Set()
      let selfCount = 0
      try {
        for (const encodedValue of selected) {
          let encoded = null
          let retained = false
          try {
            encoded = copy(encodedValue)
            const decoded = decodeRelayCapabilityAdvertisement(encoded, { now })
            if (
              (decoded.capabilityMask & query.requestedCapabilityMask) !==
              query.requestedCapabilityMask
            ) {
              incompatible()
            }
            const digest = digestRelayCapabilityAdvertisement(encoded, { now })
            const identityKey = b4a.toString(decoded.relayIdentity, 'hex')
            const digestKey = b4a.toString(digest, 'hex')
            clear(digest)
            if (identities.has(identityKey) || digests.has(digestKey)) incompatible()
            identities.add(identityKey)
            digests.add(digestKey)
            const isSelf =
              equal(decoded.relayIdentity, this._identity) &&
              equal(decoded.reachableEndpoint, this._endpoint)
            if (isSelf) {
              if (!equal(encoded, this._advertisement)) incompatible()
              selfCount++
            }
            advertisements.push({ decoded, encoded })
            retained = true
          } finally {
            if (!retained) clear(encoded)
          }
        }
        if (selfCount !== 1) incompatible()
        advertisements.sort((left, right) =>
          xorCompare(left.decoded, right.decoded, query.randomTarget)
        )
        return advertisements
      } catch (err) {
        for (const advertisement of advertisements) clear(advertisement.encoded)
        throw err
      }
    } finally {
      clear(selectionQuery.randomTarget)
      clear(selectionQuery.queryNonce)
    }
  }

  _respondToCapsRetry(datagram, sourceEndpoint, query, now, generation) {
    const key = cookieKey(query.returnRoutabilityCookie)
    const existing = this._responses.get(key)
    if (existing) {
      if (equal(existing.retry, datagram) && equal(existing.sourceEndpoint, sourceEndpoint)) {
        return copies(existing.datagrams)
      }
      return []
    }
    if (this._pendingResponses.has(key)) return []
    if (this._responses.size + this._pendingResponses.size >= this._maxReplayEntries) return []

    const reservation = Object.freeze({})
    this._pendingResponses.set(key, reservation)
    let advertisements = null
    let body = null
    let input = null
    let generatedSignature = null
    let signature = null
    let response = null
    let datagrams = null
    let entry = null
    let installed = false
    try {
      const binding = this._active.admitCapsRetry({
        ...queryAuthorityValue(query, sourceEndpoint),
        advertisement: this._advertisement
      })
      this._assertGeneration(generation)
      advertisements = this._select(query, now)
      this._assertGeneration(generation)
      body = responseBody(this._identity, query, advertisements, now)
      input = signatureInput(CAPS_RESPONSE_DOMAIN, M3_MESSAGE_ID.CAPS_RESPONSE_V1, body)
      generatedSignature = this._crypto.sign(input, this._identitySecretKey)
      this._assertGeneration(generation)
      signature = copy(generatedSignature, 64)
      this._assertGeneration(generation)
      if (!cryptoSuite.verify(input, signature, this._identity)) authentication()
      response = encodeM3Object({
        messageId: M3_MESSAGE_ID.CAPS_RESPONSE_V1,
        body,
        authSuffix: signature
      })
      datagrams = fragmentsFor(response, this._crypto)
      this._assertGeneration(generation)
      entry = {
        binding,
        retry: copy(datagram, 118),
        sourceEndpoint: copy(sourceEndpoint, 19),
        queryNonce: copy(query.queryNonce, 32),
        cookieExpiresAtMs: query.cookieExpiresAtMs,
        returnRoutabilityCookie: copy(query.returnRoutabilityCookie, 32),
        expiresAtMs: query.cookieExpiresAtMs,
        datagrams: copies(datagrams)
      }
      this._assertGeneration(generation)
      if (this._pendingResponses.get(key) !== reservation) incompatible()
      const replaced = this._responses.get(key)
      if (replaced) {
        if (equal(replaced.retry, datagram) && equal(replaced.sourceEndpoint, sourceEndpoint)) {
          return copies(replaced.datagrams)
        }
        return []
      }
      this._responses.set(key, entry)
      installed = true
      return copies(datagrams)
    } finally {
      if (this._pendingResponses.get(key) === reservation) this._pendingResponses.delete(key)
      if (!installed && entry) {
        if (this._responses.get(key) === entry) this._responses.delete(key)
        clearResponseEntry(entry)
      }
      if (advertisements) {
        for (const advertisement of advertisements) clear(advertisement.encoded)
      }
      clear(body)
      clear(input)
      clear(generatedSignature)
      clear(signature)
      clear(response)
      if (datagrams) for (const fragment of datagrams) clear(fragment)
    }
  }

  _respondToActiveChallenge(datagram, sourceEndpoint, now, generation) {
    const object = decodeM3Object(datagram)
    if (object.messageId !== M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1 || length(datagram) !== 184) {
      return []
    }
    const cookie = subarray(object.body, 144, 176)
    const entry = this._responses.get(cookieKey(cookie))
    if (
      !entry ||
      entry.expiresAtMs <= now ||
      !equal(entry.sourceEndpoint, sourceEndpoint) ||
      !equal(entry.queryNonce, subarray(object.body, 104, 136)) ||
      entry.cookieExpiresAtMs !== readUint64(object.body, 136) ||
      !equal(entry.returnRoutabilityCookie, cookie)
    ) {
      return []
    }
    let response = null
    let output = null
    let transferred = false
    try {
      response = this._active.respond(entry.binding, datagram, {
        sourceEndpoint,
        advertisement: this._advertisement,
        identitySecretKey: this._identitySecretKey,
        routeEncryptionSecretKey: this._routeEncryptionSecretKey
      })
      this._assertGeneration(generation)
      output = copy(response, 344)
      this._assertGeneration(generation)
      transferred = true
      return [output]
    } finally {
      clear(response)
      if (!transferred) clear(output)
    }
  }

  receive(datagram, observedSourceEndpoint) {
    this._assertLive()
    const generation = this._generation
    let input = null
    let sourceEndpoint = null
    let query = null
    try {
      const inputBytes = length(datagram)
      if (inputBytes < 8 || inputBytes > DIRECT_DATAGRAM_BYTES) return []
      input = copy(datagram)
      sourceEndpoint = decodeCanonicalEndpoint(observedSourceEndpoint)
      const now = this._now()
      this._assertGeneration(generation)
      if (!uint64(now)) return []
      this._expire(now)

      let object
      try {
        object = decodeM3Object(input)
      } catch {
        return []
      }
      if (object.messageId === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1) {
        return this._respondToActiveChallenge(input, sourceEndpoint, now, generation)
      }
      if (object.messageId !== M3_MESSAGE_ID.CAPS_QUERY_V1) return []
      query = parseQuery(input)
      if (query.cookiePhase === 0) {
        let cookie = null
        let challenge = null
        let transferred = false
        try {
          cookie = this._active.issueCookie(queryAuthorityValue(query, sourceEndpoint))
          this._assertGeneration(generation)
          challenge = challengeFor(query, cookie)
          this._assertGeneration(generation)
          transferred = true
          return [challenge]
        } finally {
          if (cookie) clear(cookie.returnRoutabilityCookie)
          if (!transferred) clear(challenge)
        }
      }
      if (query.cookieExpiresAtMs <= now || query.cookieExpiresAtMs > now + CAPS_COOKIE_LIFETIME) {
        return []
      }
      return this._respondToCapsRetry(input, sourceEndpoint, query, now, generation)
    } catch (err) {
      if (this._destroyed || this._generation !== generation) {
        throw PrivateRouteError.ERR_DESTROYED()
      }
      if (err instanceof PrivateRouteError && err.code === 'ERR_DESTROYED') throw err
      return []
    } finally {
      clear(input)
      clear(sourceEndpoint)
      clearQuery(query)
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._generation++
    if (this._active) this._active.destroy()
    for (const entry of this._responses.values()) clearResponseEntry(entry)
    this._responses.clear()
    this._pendingResponses.clear()
    clear(this._advertisement)
    clear(this._identity)
    clear(this._endpoint)
    clear(this._identitySecretKey)
    clear(this._routeEncryptionSecretKey)
    this._selectAdvertisements = null
    this._crypto = null
    this._active = null
  }
}
