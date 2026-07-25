import b4a from 'b4a'

import { encodeCanonical, hashCanonical, toHex } from '../publisher/canonical.js'
import { createApplicationEnvelope, verifyApplicationEnvelope } from '../records/application-envelope.js'
import { verifyArchivePledge } from './pledge.js'

export const ARCHIVE_CHALLENGE_RECORD_TYPE = 'peartube.archive.challenge.v1'
export const ARCHIVE_CHALLENGE_RESPONSE_RECORD_TYPE = 'peartube.archive.challenge-response.v1'

const MAX_HYPERCORE_PROOF_BYTES = 320 * 1024
const CHALLENGE_FIELDS = new Set(['version', 'pledgeId', 'coreKey', 'range', 'auditorPublicKey', 'challengeNonce', 'deadline'])
const RESPONSE_FIELDS = new Set(['version', 'pledgeId', 'challengeNonce', 'coreKey', 'range', 'proof', 'transportPeerId', 'deadline', 'issuedAt'])

function hex32(value, name) {
  return toHex(value, 32, name)
}

function int(value, name, min = 0) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < min) throw new Error(`${name} must be safe integer`)
  return next
}

function exactFields(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.size || Object.keys(value).some(field => !fields.has(field))) {
    throw new Error(`${name} fields are invalid`)
  }
}

function normalizeRange(range = {}) {
  exactFields(range, new Set(['start', 'end']), 'challenge range')
  const start = int(range.start, 'range.start')
  const end = int(range.end, 'range.end', 1)
  if (end - start !== 1) throw new Error('archive challenge must select exactly one block')
  return { start, end }
}

function normalizeChallengeBody(challenge = {}) {
  exactFields(challenge, CHALLENGE_FIELDS, 'archive challenge')
  return {
    version: int(challenge.version, 'version', 1),
    pledgeId: hex32(challenge.pledgeId, 'pledgeId'),
    coreKey: hex32(challenge.coreKey, 'coreKey'),
    range: normalizeRange(challenge.range),
    auditorPublicKey: hex32(challenge.auditorPublicKey, 'auditorPublicKey'),
    challengeNonce: hex32(challenge.challengeNonce, 'challengeNonce'),
    deadline: int(challenge.deadline, 'deadline', 1),
  }
}

function normalizeResponseBody(response = {}) {
  exactFields(response, RESPONSE_FIELDS, 'archive challenge response')
  return {
    version: int(response.version, 'version', 1),
    pledgeId: hex32(response.pledgeId, 'pledgeId'),
    challengeNonce: hex32(response.challengeNonce, 'challengeNonce'),
    coreKey: hex32(response.coreKey, 'coreKey'),
    range: normalizeRange(response.range),
    proof: hex32(response.proof, 'proof'),
    transportPeerId: hex32(response.transportPeerId, 'transportPeerId'),
    deadline: int(response.deadline, 'deadline', 1),
    issuedAt: int(response.issuedAt, 'issuedAt'),
  }
}

function pledgeAuthorizesChallenge(pledgeBody, challenge) {
  return Array.isArray(pledgeBody?.ranges) && pledgeBody.ranges.some(range =>
    range.coreKey === challenge.coreKey &&
    challenge.range.start >= range.start &&
    challenge.range.end <= range.end
  ) && Number.isSafeInteger(pledgeBody.retentionUntil) &&
    challenge.deadline <= pledgeBody.retentionUntil
}

export function createArchiveChallenge(input = {}) {
  const pledgeId = hex32(input.pledgeEnvelope?.recordId, 'pledgeId')
  const range = normalizeRange(input.range)
  const coreKey = hex32(input.coreKey, 'coreKey')

  const auditorEntropy = b4a.from(input.auditorEntropy || [])
  if (auditorEntropy.byteLength < 32) throw new Error('auditorEntropy must be at least 32 bytes')
  const auditorPublicKey = hex32(input.auditorPublicKey, 'auditorPublicKey')
  let pledgeBody
  try { pledgeBody = JSON.parse(b4a.toString(input.pledgeEnvelope.body)) } catch { throw new Error('pledgeEnvelope body is invalid') }
  if (!pledgeAuthorizesChallenge(pledgeBody, { coreKey, range, deadline: input.deadline })) {
    throw new Error('archive challenge is outside the pledged core range or retention')
  }
  const challengeNonce = b4a.toString(hashCanonical('peartube.archive.challenge.nonce.v1', {
    pledgeId,
    coreKey,
    range,
    auditorEntropy: b4a.toString(auditorEntropy, 'hex'),
    auditorPublicKey,
  }), 'hex')
  return { version: 1, pledgeId, coreKey, range, auditorPublicKey, challengeNonce, deadline: int(input.deadline, 'deadline', 1) }
}

export function createArchiveChallengeEnvelope(input = {}) {
  const body = normalizeChallengeBody(input.challenge)
  const envelope = createApplicationEnvelope({
    recordType: ARCHIVE_CHALLENGE_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: input.keyPair,
    nonce: b4a.from(body.challengeNonce, 'hex'),
    issuedAt: input.issuedAt,
    expiresAt: body.deadline,
  })
  return { challengeId: envelope.recordId, body, envelope }
}

export async function verifyArchiveChallengeEnvelope(envelope, options = {}) {
  let body
  try { body = normalizeChallengeBody(JSON.parse(b4a.toString(envelope.body))) } catch { return false }
  const verified = await verifyApplicationEnvelope(envelope, {
    recordType: ARCHIVE_CHALLENGE_RECORD_TYPE,
    now: options.now,
    requireNonce: true,
    allowedSigners: [b4a.from(body.auditorPublicKey, 'hex')],
  })
  if (!verified || !b4a.equals(b4a.from(envelope.nonce || []), b4a.from(body.challengeNonce, 'hex'))) return false
  if (Number(envelope.expiresAt) !== body.deadline || (options.now != null && options.now > body.deadline)) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== body.auditorPublicKey) return false
  if (options.replayCache instanceof Set) {
    const replayKey = `${signer}:${body.challengeNonce}`
    if (options.replayCache.has(replayKey)) return false
    options.replayCache.add(replayKey)
  }
  return body
}

export function createArchivePossessionProof(input = {}) {
  const challenge = normalizeChallengeBody(input.challenge)
  const proofBytes = b4a.from(input.proofBytes || [])
  if (proofBytes.byteLength === 0 || proofBytes.byteLength > MAX_HYPERCORE_PROOF_BYTES) {
    throw new Error('Hypercore possession proof exceeds bounded size')
  }
  return b4a.toString(hashCanonical('peartube.archive.possession-proof.v1', {
    pledgeId: challenge.pledgeId,
    challengeNonce: challenge.challengeNonce,
    coreKey: challenge.coreKey,
    range: challenge.range,
    hypercoreProof: b4a.toString(proofBytes, 'hex'),
  }), 'hex')
}

export function createArchiveChallengeResponse(input = {}) {
  const challenge = normalizeChallengeBody(input.challenge)
  const body = normalizeResponseBody({
    version: 1,
    pledgeId: input.pledgeEnvelope?.recordId ? hex32(input.pledgeEnvelope.recordId, 'pledgeId') : challenge.pledgeId,
    challengeNonce: challenge.challengeNonce,
    coreKey: challenge.coreKey,
    range: challenge.range,
    proof: input.proof,
    transportPeerId: input.transportPeerId,
    deadline: challenge.deadline,
    issuedAt: input.issuedAt || 0,
  })
  const envelope = createApplicationEnvelope({
    recordType: ARCHIVE_CHALLENGE_RESPONSE_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: input.keyPair,
    nonce: b4a.from(body.challengeNonce, 'hex'),
    issuedAt: input.issuedAt,
    expiresAt: body.deadline,
  })
  return { responseId: envelope.recordId, body, envelope }
}

export async function verifyArchiveChallengeResponse(envelope, options = {}) {
  let body
  let pledge
  try {
    body = normalizeResponseBody(JSON.parse(b4a.toString(envelope.body)))
    pledge = await verifyArchivePledge(options.pledgeEnvelope, { now: options.now })
  } catch {
    return false
  }
  if (!pledge) return false
  const pledgeBody = pledge.body
  const verified = await verifyApplicationEnvelope(envelope, {
    recordType: ARCHIVE_CHALLENGE_RESPONSE_RECORD_TYPE,
    now: options.now,
    requireNonce: true,
    allowedSigners: [b4a.from(pledgeBody.archivistId, 'hex')],
  })
  if (!verified) return false
  const challenge = options.challenge
  if (!challenge) return false
  if (challenge.pledgeId !== pledge.pledgeId) return false
  if (body.pledgeId !== pledge.pledgeId) return false
  if (body.challengeNonce !== challenge.challengeNonce || body.coreKey !== challenge.coreKey) return false
  if (body.range.start !== challenge.range.start || body.range.end !== challenge.range.end) return false
  if (body.deadline !== challenge.deadline || (options.now != null && options.now > challenge.deadline)) return false
  if (body.transportPeerId !== hex32(options.transportPeerId, 'transportPeerId')) return false
  if (!pledgeAuthorizesChallenge(pledgeBody, challenge)) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== pledgeBody.archivistId) return false
  if (!b4a.equals(b4a.from(envelope.nonce || []), b4a.from(body.challengeNonce, 'hex'))) return false
  if (!(options.replayCache instanceof Set) || typeof options.verifyProof !== 'function') return false
  const replayKey = `${signer}:${body.challengeNonce}`
  if (options.replayCache.has(replayKey)) return false
  try {
    const proofBytes = b4a.from(options.proofBytes || [])
    const expectedProof = createArchivePossessionProof({ challenge, proofBytes })
    if (!b4a.equals(b4a.from(body.proof, 'hex'), b4a.from(expectedProof, 'hex'))) return false
    if (!await options.verifyProof(proofBytes, challenge)) return false
  } catch {
    return false
  }
  options.replayCache.add(replayKey)
  return { responseId: envelope.recordId, body, envelope }
}
