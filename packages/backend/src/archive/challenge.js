import b4a from 'b4a'

import { encodeCanonical, hashCanonical, toHex } from '../publisher/canonical.js'
import { createSignedEnvelope, verifySignedEnvelope } from '../records/signed-envelope.js'

export const ARCHIVE_CHALLENGE_RESPONSE_RECORD_TYPE = 'peartube.archive.challenge-response.v1'

function hex32(value, name) {
  return toHex(value, 32, name)
}

function int(value, name, min = 0) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < min) throw new Error(`${name} must be safe integer`)
  return next
}

function normalizeRange(range = {}) {
  const start = int(range.start, 'range.start')
  const end = int(range.end, 'range.end', 1)
  if (end <= start) throw new Error('invalid challenge range')
  return { start, end }
}

export function createArchiveChallenge(input = {}) {
  const pledgeId = hex32(input.pledgeEnvelope?.recordId, 'pledgeId')
  if (!pledgeId) throw new Error('pledgeEnvelope is required')
  const range = normalizeRange(input.range)
  const coreKey = hex32(input.coreKey, 'coreKey')
  const auditorEntropy = b4a.from(input.auditorEntropy || [])
  if (auditorEntropy.byteLength < 32) throw new Error('auditorEntropy must be at least 32 bytes')
  const auditorPublicKey = hex32(input.auditorPublicKey, 'auditorPublicKey')
  const challengeNonce = b4a.toString(hashCanonical('peartube.archive.challenge.nonce.v1', { pledgeId, coreKey, range, auditorEntropy: b4a.toString(auditorEntropy, 'hex'), auditorPublicKey }), 'hex')
  return { version: 1, pledgeId, coreKey, range, auditorPublicKey, challengeNonce, deadline: int(input.deadline, 'deadline', 1) }
}

export function createArchiveChallengeResponse(input = {}) {
  const challenge = input.challenge
  const body = {
    version: 1,
    pledgeId: input.pledgeEnvelope?.recordId ? hex32(input.pledgeEnvelope.recordId, 'pledgeId') : String(challenge?.pledgeId || ''),
    challengeNonce: String(challenge?.challengeNonce || ''),
    coreKey: hex32(challenge?.coreKey, 'coreKey'),
    range: normalizeRange(challenge?.range),
    proof: String(input.proof || ''),
    transportPeerId: hex32(input.transportPeerId, 'transportPeerId'),
    deadline: int(challenge?.deadline, 'deadline', 1),
    issuedAt: int(input.issuedAt || 0, 'issuedAt'),
  }
  const envelope = createSignedEnvelope({ recordType: ARCHIVE_CHALLENGE_RESPONSE_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: body.deadline })
  return { responseId: envelope.recordId, body, envelope }
}

export async function verifyArchiveChallengeResponse(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  let pledgeBody
  try { pledgeBody = JSON.parse(b4a.toString(options.pledgeEnvelope.body)) } catch { return false }
  const verified = await verifySignedEnvelope(envelope, { recordType: ARCHIVE_CHALLENGE_RESPONSE_RECORD_TYPE, now: options.now, allowedSigners: [b4a.from(pledgeBody.archivistId, 'hex')] })
  if (!verified) return false
  const challenge = options.challenge
  if (!challenge) return false
  if (body.pledgeId !== hex32(options.pledgeEnvelope?.recordId, 'pledgeId')) return false
  if (body.challengeNonce !== challenge.challengeNonce) return false
  if (body.coreKey !== challenge.coreKey) return false
  if (body.range.start !== challenge.range.start || body.range.end !== challenge.range.end) return false
  if (body.deadline !== challenge.deadline) return false
  if (options.now != null && options.now > challenge.deadline) return false
  if (body.transportPeerId !== hex32(options.transportPeerId, 'transportPeerId')) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== pledgeBody.archivistId) return false
  return { responseId: envelope.recordId, body, envelope }
}
