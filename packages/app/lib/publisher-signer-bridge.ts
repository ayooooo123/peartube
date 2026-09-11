import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { hashPublisherBytes } from './publisher-mobile-crypto'
import type { PublisherRootRecordType } from '../src/shared/rpc-types'
import {
  decodeUnsignedMultiSignedEnvelope,
  decodeUnsignedSignedEnvelope,
  encodeUnsignedMultiSignedEnvelope,
  encodeUnsignedSignedEnvelope,
  multiSignedRecordSignaturePreimage,
  signedRecordSignaturePreimage,
} from '@peartube/backend/records'

ed25519.hashes.sha512 = sha512

const ROOT_RECORD_TYPES = new Set([
  'publisher.namespace',
  'publisher.writer-admission',
  'publisher.writer-revocation',
  'publisher.root-transition',
])
const ROOT_INTENT_FIELDS = Object.freeze({
  publisherId: true,
  recordType: true,
  body: true,
  displaySummaryJson: true,
  intentExpiresAt: true,
  issuedAt: true,
  expiresAt: true,
  expiresInMs: true,
})
const ROOT_TRANSITION_RECORD_TYPE = 'publisher.root-transition'
const RECORD_ID_BYTES = 32
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const MAX_INTENT_TTL_MS = 5 * 60_000

type SignerError = Error & { code: string }

type ProtocolSignRequest =
  | { recordType: PublisherRootRecordType; transitionId: Uint8Array }
  | { recordType: PublisherRootRecordType; recordId: Uint8Array }

type PublisherVaultLike = {
  getPublicKey(input: { publisherId: string }): Promise<Uint8Array | null | undefined>
  signProtocolRecord(input: {
    publisherId: string
    recordType: string
    recordId?: Uint8Array
    transitionId?: Uint8Array
  }): Promise<{ signerPublicKey?: Uint8Array; signature?: Uint8Array } | null | undefined>
}

type BeginUserIntentRequest = {
  publisherId?: string
  recordType?: string
  body?: Uint8Array
  displaySummaryJson?: string | null
  intentExpiresAt?: number
  issuedAt?: number
  expiresAt?: number
  expiresInMs?: number
}

type PreparedRecordLike = {
  intentId?: string
  success?: boolean
  publisherId?: string
  recordType?: string
  displaySummaryJson?: string | null
  intentExpiresAt?: number
  signerPublicKey?: Uint8Array
  unsignedBytes?: Uint8Array
  candidateRecordId?: Uint8Array
  bodyLength?: number
  issuedAt?: number
}

type IntentState = {
  intentId: string
  publisherId: string
  recordType: PublisherRootRecordType
  body: Uint8Array
  displaySummaryJson: string | null
  intentExpiresAt: number
  signerPublicKey: Uint8Array
}

type DecodedUnsigned = {
  recordType: string
  canonicalBody: Uint8Array
  bodyLength: number
  signedAt: number
  expiresAt?: number | null
  signerKey?: Uint8Array
}

type SignerBridgeOptions = {
  // Call-site vault facades may expose a narrower public surface; runtime checks gate methods.
  vault?: Partial<PublisherVaultLike> | null
  now?: () => number
  hash?: (value: Uint8Array) => Uint8Array
  randomBytes?: (length: number) => Uint8Array
  runtime?: string
}

function signerError(code: string): SignerError {
  const error = new Error(`Publisher signer error: ${code}`) as SignerError
  error.code = code
  return error
}

function bytes(value: unknown, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.byteLength !== length)) {
    throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
  }
  return value
}

export function constantTimeEqual(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function assertRootRecordType(recordType: unknown): asserts recordType is PublisherRootRecordType {
  if (typeof recordType !== 'string' || !ROOT_RECORD_TYPES.has(recordType)) {
    throw signerError('PUBLISHER_SIGNER_RECORD_TYPE_FORBIDDEN')
  }
}

export function publisherRootSignaturePreimage(request: {
  recordType?: string
  recordId?: Uint8Array
  transitionId?: Uint8Array
} = {}): Uint8Array {
  assertRootRecordType(request.recordType)
  const transition = request.recordType === ROOT_TRANSITION_RECORD_TYPE
  const expectedKeys = transition ? ['recordType', 'transitionId'] : ['recordId', 'recordType']
  const keys = Object.keys(request).sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
  }
  return transition
    ? multiSignedRecordSignaturePreimage({
      recordType: request.recordType,
      transitionId: bytes(request.transitionId, RECORD_ID_BYTES),
    })
    : signedRecordSignaturePreimage({
      recordType: request.recordType,
      recordId: bytes(request.recordId, RECORD_ID_BYTES),
    })
}

function randomIntentId(randomBytes: (length: number) => Uint8Array): string {
  return Array.from(randomBytes(16), (value) => value.toString(16).padStart(2, '0')).join('')
}

function decodeCanonicalUnsigned(recordType: string, unsignedBytes: Uint8Array): DecodedUnsigned {
  try {
    const transition = recordType === ROOT_TRANSITION_RECORD_TYPE
    const decoded = (transition
      ? decodeUnsignedMultiSignedEnvelope(unsignedBytes)
      : decodeUnsignedSignedEnvelope(unsignedBytes)) as DecodedUnsigned
    const reencoded = transition
      ? encodeUnsignedMultiSignedEnvelope(decoded)
      : encodeUnsignedSignedEnvelope(decoded)
    if (!constantTimeEqual(reencoded, unsignedBytes) || decoded.recordType !== recordType) {
      throw signerError('PUBLISHER_SIGNER_MISMATCH')
    }
    if (!transition && decoded.expiresAt != null) {
      throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
    }
    return decoded
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code) {
      throw error
    }
    throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
  }
}

function clearIntent(intent: IntentState): void {
  intent.body.fill(0)
  intent.signerPublicKey.fill(0)
}

function verifyPreparedMatchesIntent(prepared: PreparedRecordLike, intent: IntentState, intentId: string): void {
  if (
    prepared.intentId !== intentId ||
    !prepared.success ||
    prepared.publisherId !== intent.publisherId ||
    prepared.recordType !== intent.recordType ||
    prepared.displaySummaryJson !== intent.displaySummaryJson ||
    prepared.intentExpiresAt !== intent.intentExpiresAt ||
    !constantTimeEqual(prepared.signerPublicKey, intent.signerPublicKey)
  ) {
    throw signerError('PUBLISHER_SIGNER_MISMATCH')
  }
}

function verifyCanonicalDecodedMatches(
  decoded: DecodedUnsigned,
  intent: IntentState,
  prepared: PreparedRecordLike,
): void {
  if (
    !constantTimeEqual(decoded.canonicalBody, intent.body) ||
    decoded.bodyLength !== prepared.bodyLength ||
    decoded.signedAt !== prepared.issuedAt ||
    (intent.recordType !== ROOT_TRANSITION_RECORD_TYPE && !constantTimeEqual(decoded.signerKey, intent.signerPublicKey))
  ) {
    throw signerError('PUBLISHER_SIGNER_MISMATCH')
  }
}

async function signAndVerifyProtocolRecord(
  signProtocolRecord: PublisherVaultLike['signProtocolRecord'],
  intent: IntentState,
  protocolRequest: ProtocolSignRequest,
) {
  let signed: { signerPublicKey?: Uint8Array; signature?: Uint8Array } | null | undefined
  try {
    signed = await signProtocolRecord({ publisherId: intent.publisherId, ...protocolRequest })
  } catch {
    throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
  }

  let signerPublicKey: Uint8Array
  let signature: Uint8Array
  try {
    signerPublicKey = bytes(signed?.signerPublicKey, PUBLIC_KEY_BYTES)
    signature = bytes(signed?.signature, SIGNATURE_BYTES)
  } catch {
    throw signerError('PUBLISHER_SIGNER_SIGNATURE_SUBSTITUTION')
  }

  if (!constantTimeEqual(signerPublicKey, intent.signerPublicKey)) {
    throw signerError('PUBLISHER_SIGNER_SIGNATURE_SUBSTITUTION')
  }

  const preimage = publisherRootSignaturePreimage(protocolRequest)
  const valid = ed25519.verify(signature, preimage, signerPublicKey)
  preimage.fill(0)
  if (!valid) throw signerError('PUBLISHER_SIGNER_SIGNATURE_SUBSTITUTION')

  return { signerPublicKey, signature }
}

export function createPublisherSignerBridge(options: SignerBridgeOptions = {}) {
  const vault = options.vault
  if (!vault?.getPublicKey || !vault?.signProtocolRecord) throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
  // Narrow the checked optional methods once, bound to the vault receiver, so class vaults keep their `this`.
  const getPublicKey = vault.getPublicKey.bind(vault)
  const signProtocolRecord = vault.signProtocolRecord.bind(vault)
  const intents = new Map<string, IntentState>()
  const now = options.now || (() => Date.now())
  const hash = options.hash || hashPublisherBytes
  const randomBytes = options.randomBytes || ((length: number) => {
    const output = new Uint8Array(length)
    if (!globalThis.crypto?.getRandomValues) throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
    globalThis.crypto.getRandomValues(output)
    return output
  })

  return {
    async beginUserIntent(request: BeginUserIntentRequest = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          Object.keys(request).some(field => !Object.hasOwn(ROOT_INTENT_FIELDS, field)) ||
          !request.publisherId) {
        throw signerError('PUBLISHER_SIGNER_INVALID_INTENT')
      }
      assertRootRecordType(request.recordType)
      const currentTime = now()
      if (!Number.isSafeInteger(request.intentExpiresAt) || request.intentExpiresAt! <= currentTime || request.intentExpiresAt! > currentTime + MAX_INTENT_TTL_MS) {
        throw signerError('PUBLISHER_SIGNER_INVALID_INTENT')
      }
      const body = bytes(request.body)
      let signerPublicKey: Uint8Array
      try {
        signerPublicKey = bytes(
          await getPublicKey({ publisherId: request.publisherId }),
          PUBLIC_KEY_BYTES,
        )
      } catch {
        throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
      }
      const intentId = randomIntentId(randomBytes)
      if (intents.has(intentId)) throw signerError('PUBLISHER_SIGNER_REPLAY')
      intents.set(intentId, {
        intentId,
        publisherId: request.publisherId,
        recordType: request.recordType,
        body: Uint8Array.from(body),
        displaySummaryJson: request.displaySummaryJson ?? null,
        intentExpiresAt: request.intentExpiresAt!,
        signerPublicKey: signerPublicKey.slice(),
      })
      return { intentId, signerPublicKey: signerPublicKey.slice() }
    },

    async signPreparedRecord(intentId: string, prepared: PreparedRecordLike = {}) {
      const intent = intents.get(intentId)
      if (!intent) throw signerError('PUBLISHER_SIGNER_UNKNOWN_INTENT')
      try {
        if (now() >= intent.intentExpiresAt) throw signerError('PUBLISHER_SIGNER_EXPIRED')
        verifyPreparedMatchesIntent(prepared, intent, intentId)

        const unsignedBytes = bytes(prepared.unsignedBytes)
        const candidateRecordId = bytes(prepared.candidateRecordId, RECORD_ID_BYTES)
        const recomputedId = hash(unsignedBytes)
        if (!constantTimeEqual(recomputedId, candidateRecordId)) throw signerError('PUBLISHER_SIGNER_MISMATCH')

        const decoded = decodeCanonicalUnsigned(intent.recordType, unsignedBytes)
        verifyCanonicalDecodedMatches(decoded, intent, prepared)

        const protocolRequest: ProtocolSignRequest = intent.recordType === ROOT_TRANSITION_RECORD_TYPE
          ? { recordType: intent.recordType, transitionId: candidateRecordId }
          : { recordType: intent.recordType, recordId: candidateRecordId }

        const { signerPublicKey, signature } = await signAndVerifyProtocolRecord(signProtocolRecord, intent, protocolRequest)

        return {
          intentId,
          publisherId: intent.publisherId,
          recordType: intent.recordType,
          unsignedBytes: unsignedBytes.slice(),
          candidateRecordId: candidateRecordId.slice(),
          displaySummaryJson: intent.displaySummaryJson,
          signer: signerPublicKey.slice(),
          signerPublicKey: signerPublicKey.slice(),
          signature: signature.slice(),
        }
      } finally {
        intents.delete(intentId)
        clearIntent(intent)
      }
    },

    completeIntent(intentId: string) {
      const intent = intents.get(intentId)
      intents.delete(intentId)
      if (intent) clearIntent(intent)
    },

    cancelIntent(intentId: string) {
      const intent = intents.get(intentId)
      intents.delete(intentId)
      if (intent) clearIntent(intent)
    },
  }
}
