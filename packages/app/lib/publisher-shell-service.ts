import {
  createPublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
} from '@peartube/backend/publisher'

import type {
  PublisherBeginIntentParams,
  PublisherBeginIntentResponse,
  PublisherCreateRootResponse,
  PublisherPreparedRecord,
  PublisherRootRecordType,
  PublisherSignedRecord,
  PublisherSignerRequestHandlers,
} from '../src/shared/rpc-types'

const PUBLISHER_ID_PATTERN = /^[0-9a-f]{64}$/
const INTENT_ID_PATTERN = /^[0-9a-f]{32}$/
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/
const ROOT_RECORD_TYPES: Record<PublisherRootRecordType, true> = {
  'publisher.namespace': true,
  'publisher.writer-admission': true,
  'publisher.writer-revocation': true,
  'publisher.root-transition': true,
}

export const MAX_PUBLISHER_BODY_BYTES = 256 * 1024
export const MAX_PUBLISHER_UNSIGNED_BYTES = 1024 * 1024
export const MAX_PUBLISHER_SUMMARY_CHARS = 16 * 1024

type PrivilegedPreparedRecord = Omit<
  PublisherPreparedRecord,
  'unsignedBytes' | 'candidateRecordId' | 'signerPublicKey'
> & {
  unsignedBytes: Uint8Array
  candidateRecordId: Uint8Array
  signerPublicKey: Uint8Array
}

type PrivilegedSignedRecord = {
  intentId: string
  publisherId: string
  recordType: PublisherRootRecordType
  unsignedBytes: Uint8Array
  candidateRecordId: Uint8Array
  displaySummaryJson?: string | null
  signer: Uint8Array
  signerPublicKey: Uint8Array
  signature: Uint8Array
  allowedSigners?: Uint8Array[] | null
}

export type PublisherSignerLike = {
  beginUserIntent(request: Omit<PublisherBeginIntentParams, 'body'> & { body: Uint8Array }): Promise<{
    intentId: string
    signerPublicKey: Uint8Array
  }>
  signPreparedRecord(intentId: string, prepared: PrivilegedPreparedRecord): Promise<PrivilegedSignedRecord>
  completeIntent(intentId: string): void | Promise<void>
  cancelIntent(intentId: string): void | Promise<void>
}

export type PublisherRootVaultLike = {
  createRoot(input?: Record<string, never>): Promise<{
    publisherId: string
    publicKey: string | Uint8Array
  }>
}
type PublisherShellRoot = {
  publisherId: string
  publicKey: string | Uint8Array
}

type PublisherShellWorkflowDependencies = {
  shell: {
    createRoot(): Promise<PublisherShellRoot>
  }
  publisherRpc: {
    provisionPublisherCatalog(request: {
      publisherId: string
      genesisRootKey: Uint8Array
    }): Promise<{
      success: boolean
      publisherId: string
      catalogBootstrapKey: Uint8Array
      errorCode?: string | null
      error?: string | null
    }>
    authorizePublisherRootOperation(request: {
      publisherId: string
      recordType: 'publisher.namespace'
      body: Uint8Array
      displaySummaryJson: string | null
      intentExpiresAt: number
      userInitiated: true
    }): Promise<{ success: boolean } & Record<string, unknown>>
  }
  now?: () => number
  intentTtlMs?: number
}


type DesktopPublisherHandlerDependencies = {
  signer: PublisherSignerLike
  vault: PublisherRootVaultLike
}

function shellError(code: string): Error {
  const error = new Error(code)
  ;(error as Error & { code?: string }).code = code
  return error
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
}

function requiredString(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
  return value
}

function boundedNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || value.length > MAX_PUBLISHER_SUMMARY_CHARS) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
  return value
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
  return value as number
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  return value
}

function rootRecordType(value: unknown): PublisherRootRecordType {
  if (typeof value !== 'string' || !Object.hasOwn(ROOT_RECORD_TYPES, value)) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
  return value as PublisherRootRecordType
}

function jsonBytes(value: unknown, maximum: number, exactLength?: number): Uint8Array {
  if (!Array.isArray(value) || value.length > maximum || (exactLength !== undefined && value.length !== exactLength)) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
  const output = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index++) {
    const byte = value[index]
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
    }
    output[index] = byte
  }
  return output
}

function publicBytes(value: unknown, maximum: number, exactLength?: number): number[] {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum || (exactLength !== undefined && value.byteLength !== exactLength)) {
    throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
  }
  return Array.from(value)
}

function normalizedPublicKey(value: unknown): Uint8Array {
  if (value instanceof Uint8Array && value.byteLength === 32) return value
  if (typeof value !== 'string' || !HEX_PUBLIC_KEY_PATTERN.test(value)) {
    throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
  }
  const output = new Uint8Array(32)
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return output
}

function publicKeyBytes(value: unknown): number[] {
  return Array.from(normalizedPublicKey(value))
}

async function privileged<T>(code: string, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action()
  } catch {
    throw shellError(code)
  }
}

function parseIntentRequest(input: unknown): Omit<PublisherBeginIntentParams, 'body'> & { body: Uint8Array } {
  const value = record(input)
  exactKeys(value, [
    'publisherId',
    'recordType',
    'body',
    'displaySummaryJson',
    'intentExpiresAt',
    'issuedAt',
    'expiresAt',
    'expiresInMs',
    'userInitiated',
  ])
  if (value.userInitiated !== true) throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  return {
    publisherId: requiredString(value.publisherId, PUBLISHER_ID_PATTERN),
    recordType: rootRecordType(value.recordType),
    body: jsonBytes(value.body, MAX_PUBLISHER_BODY_BYTES),
    displaySummaryJson: boundedNullableString(value.displaySummaryJson),
    intentExpiresAt: safeInteger(value.intentExpiresAt),
    issuedAt: value.issuedAt == null ? value.issuedAt as null | undefined : safeInteger(value.issuedAt),
    expiresAt: value.expiresAt == null ? value.expiresAt as null | undefined : safeInteger(value.expiresAt),
    expiresInMs: value.expiresInMs == null ? value.expiresInMs as null | undefined : safeInteger(value.expiresInMs),
    userInitiated: true,
  }
}

function parsePreparedRecord(input: unknown): PrivilegedPreparedRecord {
  const value = record(input)
  exactKeys(value, [
    'intentId',
    'success',
    'publisherId',
    'recordType',
    'unsignedBytes',
    'candidateRecordId',
    'signerPublicKey',
    'intentExpiresAt',
    'bodyLength',
    'issuedAt',
    'expiresAt',
    'displaySummaryJson',
    'error',
  ])
  return {
    intentId: requiredString(value.intentId, INTENT_ID_PATTERN),
    success: boolean(value.success),
    publisherId: requiredString(value.publisherId, PUBLISHER_ID_PATTERN),
    recordType: rootRecordType(value.recordType),
    unsignedBytes: jsonBytes(value.unsignedBytes, MAX_PUBLISHER_UNSIGNED_BYTES),
    candidateRecordId: jsonBytes(value.candidateRecordId, 32, 32),
    signerPublicKey: jsonBytes(value.signerPublicKey, 32, 32),
    intentExpiresAt: safeInteger(value.intentExpiresAt),
    bodyLength: safeInteger(value.bodyLength),
    issuedAt: safeInteger(value.issuedAt),
    expiresAt: safeInteger(value.expiresAt),
    displaySummaryJson: boundedNullableString(value.displaySummaryJson),
    error: boundedNullableString(value.error),
  }
}

function serializeSignedRecord(value: PrivilegedSignedRecord): PublisherSignedRecord {
  const output: PublisherSignedRecord = {
    intentId: requiredString(value.intentId, INTENT_ID_PATTERN),
    publisherId: requiredString(value.publisherId, PUBLISHER_ID_PATTERN),
    recordType: rootRecordType(value.recordType),
    unsignedBytes: publicBytes(value.unsignedBytes, MAX_PUBLISHER_UNSIGNED_BYTES),
    candidateRecordId: publicBytes(value.candidateRecordId, 32, 32),
    displaySummaryJson: boundedNullableString(value.displaySummaryJson),
    signer: publicBytes(value.signer, 32, 32),
    signerPublicKey: publicBytes(value.signerPublicKey, 32, 32),
    signature: publicBytes(value.signature, 64, 64),
  }
  if (value.allowedSigners !== undefined) {
    if (value.allowedSigners !== null && !Array.isArray(value.allowedSigners)) {
      throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
    }
    output.allowedSigners = value.allowedSigners?.map((entry) => publicBytes(entry, 32, 32)) ?? null
  }
  return output
}

export function createDesktopPublisherRpcHandlers(
  dependencies: DesktopPublisherHandlerDependencies,
): PublisherSignerRequestHandlers {
  const { signer, vault } = dependencies

  return {
    async publisherCreateRoot(input): Promise<PublisherCreateRootResponse> {
      const value = record(input)
      exactKeys(value, [])
      const created = await privileged('PUBLISHER_SHELL_CREATE_FAILED', () => vault.createRoot({}))
      return {
        publisherId: requiredString(created.publisherId, PUBLISHER_ID_PATTERN),
        publicKey: publicKeyBytes(created.publicKey),
      }
    },

    async publisherBeginUserIntent(input): Promise<PublisherBeginIntentResponse> {
      const request = parseIntentRequest(input)
      const intent = await privileged('PUBLISHER_SHELL_BEGIN_FAILED', () => signer.beginUserIntent(request))
      return {
        intentId: requiredString(intent.intentId, INTENT_ID_PATTERN),
        signerPublicKey: publicBytes(intent.signerPublicKey, 32, 32),
      }
    },

    async publisherSignPreparedRecord(input): Promise<PublisherSignedRecord> {
      let intentId: string | null = null
      try {
        const value = record(input)
        exactKeys(value, ['intentId', 'prepared'])
        intentId = requiredString(value.intentId, INTENT_ID_PATTERN)
        const prepared = parsePreparedRecord(value.prepared)
        if (prepared.intentId !== intentId) throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
        const signed = await signer.signPreparedRecord(intentId, prepared)
        return serializeSignedRecord(signed)
      } catch {
        if (intentId) {
          try { await signer.cancelIntent(intentId) } catch {}
        }
        throw shellError('PUBLISHER_SHELL_SIGN_FAILED')
      }
    },

    async publisherCompleteIntent(input): Promise<{ ok: true }> {
      const value = record(input)
      exactKeys(value, ['intentId'])
      const intentId = requiredString(value.intentId, INTENT_ID_PATTERN)
      await privileged('PUBLISHER_SHELL_COMPLETE_FAILED', () => signer.completeIntent(intentId))
      return { ok: true }
    },

    async publisherCancelIntent(input): Promise<{ ok: true }> {
      const value = record(input)
      exactKeys(value, ['intentId'])
      const intentId = requiredString(value.intentId, INTENT_ID_PATTERN)
      await privileged('PUBLISHER_SHELL_CANCEL_FAILED', () => signer.cancelIntent(intentId))
      return { ok: true }
    },
  }
}

export function createPublisherShellService(dependencies: PublisherShellWorkflowDependencies) {
  const now = dependencies.now ?? (() => Date.now())
  const intentTtlMs = dependencies.intentTtlMs ?? 2 * 60_000
  if (!Number.isSafeInteger(intentTtlMs) || intentTtlMs < 1 || intentTtlMs > 5 * 60_000) {
    throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
  }

  return {
    async createPublisherNamespace(
      input: { displaySummaryJson?: string | null } = {},
    ) {
      const value = record(input)
      exactKeys(value, ['displaySummaryJson'])
      const displaySummaryJson = boundedNullableString(value.displaySummaryJson) ?? null

      const created = await privileged(
        'PUBLISHER_SHELL_CREATE_FAILED',
        () => dependencies.shell.createRoot(),
      )
      const publisherId = requiredString(created.publisherId, PUBLISHER_ID_PATTERN)
      const genesisRootKey = normalizedPublicKey(created.publicKey)

      const provision = await privileged(
        'PUBLISHER_SHELL_PROVISION_FAILED',
        () => dependencies.publisherRpc.provisionPublisherCatalog({
          publisherId,
          genesisRootKey,
        }),
      )
      if (
        provision.success !== true ||
        provision.publisherId !== publisherId ||
        !(provision.catalogBootstrapKey instanceof Uint8Array) ||
        provision.catalogBootstrapKey.byteLength !== 32
      ) {
        throw shellError('PUBLISHER_SHELL_PROVISION_FAILED')
      }

      const body = await privileged('PUBLISHER_SHELL_NAMESPACE_FAILED', () => (
        encodePublisherNamespaceDescriptor(createPublisherNamespaceDescriptor({
          genesisRootKey,
          catalogBootstrapKey: provision.catalogBootstrapKey,
        }))
      ))
      const currentTime = now()
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
        throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
      }
      const intentExpiresAt = currentTime + intentTtlMs
      if (!Number.isSafeInteger(intentExpiresAt)) {
        throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
      }

      const authorization = await privileged(
        'PUBLISHER_SHELL_AUTHORIZE_FAILED',
        () => dependencies.publisherRpc.authorizePublisherRootOperation({
          publisherId,
          recordType: 'publisher.namespace',
          body,
          displaySummaryJson,
          intentExpiresAt,
          userInitiated: true,
        }),
      )
      if (authorization.success !== true) {
        throw shellError('PUBLISHER_SHELL_AUTHORIZE_FAILED')
      }

      return {
        root: { publisherId, publicKey: genesisRootKey },
        provision,
        authorization,
      }
    },
  }
}
