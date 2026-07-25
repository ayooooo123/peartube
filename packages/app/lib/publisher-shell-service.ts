import {
  createPublisherNamespaceDescriptor,
  decodePublisherNamespaceDescriptor,
  decodePublisherOperationBody,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
} from '@peartube/backend/publisher'

import type {
  PublisherLifecycleRequestHandlers,
  PublisherPreparedRecord,
  PublisherRootRecordType,
  PublisherSignedRecord,
} from '../src/shared/rpc-types'

const PUBLISHER_ID_PATTERN = /^[0-9a-f]{64}$/
const INTENT_ID_PATTERN = /^[0-9a-f]{32}$/
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/
const WRITER_CAPABILITIES = Object.freeze(['claim', 'publish'] as const)
const WRITER_EXPIRY = Number.MAX_SAFE_INTEGER

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

type RootIntent = {
  publisherId: string
  recordType: PublisherRootRecordType
  body: Uint8Array
  displaySummaryJson: string
  intentExpiresAt: number
  issuedAt: number
  expiresInMs: number
}

export type PublisherSignerLike = {
  beginUserIntent(request: RootIntent): Promise<{
    intentId: string
    signerPublicKey: Uint8Array
  }>
  signPreparedRecord(intentId: string, prepared: PrivilegedPreparedRecord): Promise<PrivilegedSignedRecord>
  completeIntent(intentId: string): void | Promise<void>
  cancelIntent(intentId: string): void | Promise<void>
}

export type PublisherRootVaultLike = {
  getOrCreateRoot(): Promise<{
    publisherId: string
    publicKey: string | Uint8Array
  }>
}

type ProvisionedCatalog = {
  success: boolean
  publisherId: string
  catalogBootstrapKey: Uint8Array
  localWriterKey: Uint8Array
  localSignerKey: Uint8Array
  writable: boolean
  namespaceInitialized: boolean
  admitted: boolean
  errorCode?: string | null
  error?: string | null
}

type PublisherShellSummary = Readonly<Record<string, string | number | readonly string[]>>

type PublisherShellWorkflowDependencies = {
  shell: PublisherRootVaultLike
  signer: PublisherSignerLike
  confirmRootOperation(summary: PublisherShellSummary): Promise<boolean>
  publisherRpc: {
    provisionPublisherCatalog(request: {
      publisherId: string
      genesisRootKey: Uint8Array
    }): Promise<ProvisionedCatalog>
    preparePublisherRootOperation(request: RootIntent & {
      intentId: string
      signerPublicKey: Uint8Array
    }): Promise<PrivilegedPreparedRecord>
    submitPublisherRootOperation(request: PrivilegedSignedRecord): Promise<{
      intentId: string
      success: boolean
      complete: boolean
      publisherId: string
      recordType: PublisherRootRecordType
      recordId: Uint8Array
      signer: Uint8Array
      reason?: string | null
    }>
  }
  now?: () => number
  randomBytes?: (length: number) => Uint8Array
  intentTtlMs?: number
}

type DesktopPublisherLifecycleDependencies = {
  publisherShell: {
    ensureLocalPublisher(): Promise<{
      status: 'ready'
      publisherId: string
      catalogBootstrapKey?: Uint8Array
      writable: true
      admitted: true
    }>
  }
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

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
  }
  return value as number
}

function normalizedBytes(value: unknown, maximum: number, exactLength?: number): Uint8Array {
  let output: Uint8Array
  if (value instanceof Uint8Array) output = value
  else if (Array.isArray(value)) {
    output = new Uint8Array(value.length)
    for (let index = 0; index < value.length; index++) {
      const byte = value[index]
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
      }
      output[index] = byte
    }
  } else {
    throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
  }
  if (output.byteLength > maximum || (exactLength !== undefined && output.byteLength !== exactLength)) {
    throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
  }
  return output.slice()
}

function normalizedPublicKey(value: unknown): Uint8Array {
  if (value instanceof Uint8Array && value.byteLength === 32) return value.slice()
  if (typeof value !== 'string' || !HEX_PUBLIC_KEY_PATTERN.test(value)) {
    throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
  }
  const output = new Uint8Array(32)
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return output
}

function equalBytes(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function summaryJson(summary: PublisherShellSummary): string {
  const value = JSON.stringify(summary)
  if (value.length > MAX_PUBLISHER_SUMMARY_CHARS) throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
  return value
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
    success: value.success === true,
    publisherId: requiredString(value.publisherId, PUBLISHER_ID_PATTERN),
    recordType: requiredRootRecordType(value.recordType),
    unsignedBytes: normalizedBytes(value.unsignedBytes, MAX_PUBLISHER_UNSIGNED_BYTES),
    candidateRecordId: normalizedBytes(value.candidateRecordId, 32, 32),
    signerPublicKey: normalizedBytes(value.signerPublicKey, 32, 32),
    intentExpiresAt: safeInteger(value.intentExpiresAt),
    bodyLength: safeInteger(value.bodyLength),
    issuedAt: safeInteger(value.issuedAt),
    expiresAt: safeInteger(value.expiresAt),
    displaySummaryJson: typeof value.displaySummaryJson === 'string' ? value.displaySummaryJson : null,
    error: typeof value.error === 'string' ? value.error : null,
  }
}

function requiredRootRecordType(value: unknown): PublisherRootRecordType {
  if (value !== 'publisher.namespace' && value !== 'publisher.writer-admission' &&
      value !== 'publisher.writer-revocation' && value !== 'publisher.root-transition') {
    throw shellError('PUBLISHER_SHELL_INVALID_RESPONSE')
  }
  return value
}

function parseProvisionedCatalog(input: unknown, publisherId: string): ProvisionedCatalog {
  const value = record(input)
  exactKeys(value, [
    'success',
    'publisherId',
    'catalogBootstrapKey',
    'localWriterKey',
    'localSignerKey',
    'writable',
    'namespaceInitialized',
    'admitted',
    'errorCode',
    'error',
  ])
  if (value.success !== true || value.publisherId !== publisherId || value.writable !== true) {
    throw shellError('PUBLISHER_SHELL_PROVISION_FAILED')
  }
  return {
    success: true,
    publisherId,
    catalogBootstrapKey: normalizedBytes(value.catalogBootstrapKey, 32, 32),
    localWriterKey: normalizedBytes(value.localWriterKey, 32, 32),
    localSignerKey: normalizedBytes(value.localSignerKey, 32, 32),
    writable: true,
    namespaceInitialized: value.namespaceInitialized === true,
    admitted: value.admitted === true,
  }
}

async function privileged<T>(code: string, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if ((error as Error & { code?: string })?.code === 'PUBLISHER_SHELL_CONFIRMATION_DECLINED') throw error
    throw shellError(code)
  }
}

export function createPublisherShellService(dependencies: PublisherShellWorkflowDependencies) {
  const now = dependencies.now ?? (() => Date.now())
  const randomBytes = dependencies.randomBytes ?? ((length: number) => {
    const output = new Uint8Array(length)
    if (!globalThis.crypto?.getRandomValues) throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
    globalThis.crypto.getRandomValues(output)
    return output
  })
  const intentTtlMs = dependencies.intentTtlMs ?? 2 * 60_000
  if (!Number.isSafeInteger(intentTtlMs) || intentTtlMs < 1 || intentTtlMs > 5 * 60_000) {
    throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
  }
  let inFlight: Promise<{
    status: 'ready'
    publisherId: string
    catalogBootstrapKey: Uint8Array
    writable: true
    admitted: true
  }> | null = null

  async function provision(publisherId: string, genesisRootKey: Uint8Array): Promise<ProvisionedCatalog> {
    const response = await dependencies.publisherRpc.provisionPublisherCatalog({ publisherId, genesisRootKey })
    return parseProvisionedCatalog(response, publisherId)
  }

  async function authorizeExactRootOperation({
    publisherId,
    recordType,
    body,
    summary,
  }: {
    publisherId: string
    recordType: PublisherRootRecordType
    body: Uint8Array
    summary: PublisherShellSummary
  }): Promise<void> {
    if (body.byteLength > MAX_PUBLISHER_BODY_BYTES) throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
    if (await dependencies.confirmRootOperation(summary) !== true) {
      throw shellError('PUBLISHER_SHELL_CONFIRMATION_DECLINED')
    }
    const currentTime = safeInteger(now())
    if (currentTime > Number.MAX_SAFE_INTEGER - intentTtlMs) {
      throw shellError('PUBLISHER_SHELL_INVALID_CONFIGURATION')
    }
    const request: RootIntent = {
      publisherId,
      recordType,
      body: body.slice(),
      displaySummaryJson: summaryJson(summary),
      issuedAt: currentTime,
      expiresInMs: intentTtlMs,
      intentExpiresAt: currentTime + intentTtlMs,
    }
    let intentId: string | null = null
    try {
      const intent = await dependencies.signer.beginUserIntent(request)
      intentId = requiredString(intent.intentId, INTENT_ID_PATTERN)
      const signerPublicKey = normalizedBytes(intent.signerPublicKey, 32, 32)
      const prepared = parsePreparedRecord(await dependencies.publisherRpc.preparePublisherRootOperation({
        ...request,
        intentId,
        signerPublicKey,
      }))
      if (prepared.intentId !== intentId || prepared.publisherId !== publisherId ||
          prepared.recordType !== recordType || prepared.success !== true) {
        throw shellError('PUBLISHER_SHELL_PREPARE_FAILED')
      }
      const signed = await dependencies.signer.signPreparedRecord(intentId, prepared)
      const submitted = await dependencies.publisherRpc.submitPublisherRootOperation(signed)
      if (submitted?.success !== true || submitted.complete !== true ||
          submitted.intentId !== intentId || submitted.publisherId !== publisherId ||
          submitted.recordType !== recordType ||
          !equalBytes(submitted.recordId, signed.candidateRecordId) ||
          !equalBytes(submitted.signer, signed.signer)) {
        throw shellError('PUBLISHER_SHELL_SUBMIT_FAILED')
      }
      await dependencies.signer.completeIntent(intentId)
      intentId = null
    } catch (error) {
      if (intentId) {
        try { await dependencies.signer.cancelIntent(intentId) } catch {}
      }
      throw error
    } finally {
      body.fill(0)
    }
  }

  async function ensureLocalPublisher() {
    const root = await privileged('PUBLISHER_SHELL_ROOT_FAILED', () => dependencies.shell.getOrCreateRoot())
    const publisherId = requiredString(root.publisherId, PUBLISHER_ID_PATTERN)
    const genesisRootKey = normalizedPublicKey(root.publicKey)
    let catalog = await privileged('PUBLISHER_SHELL_PROVISION_FAILED', () => provision(publisherId, genesisRootKey))

    if (!catalog.namespaceInitialized) {
      const body = await privileged('PUBLISHER_SHELL_NAMESPACE_FAILED', () => (
        encodePublisherNamespaceDescriptor(createPublisherNamespaceDescriptor({
          genesisRootKey,
          catalogBootstrapKey: catalog.catalogBootstrapKey,
        }))
      ))
      const descriptor = decodePublisherNamespaceDescriptor(body)
      const summary = Object.freeze({
        action: 'create-publisher-namespace',
        publisherId,
        catalogBootstrapKey: hex(descriptor.catalogBootstrapKey),
      })
      await privileged('PUBLISHER_SHELL_AUTHORIZE_FAILED', () => authorizeExactRootOperation({
        publisherId,
        recordType: 'publisher.namespace',
        body,
        summary,
      }))
      catalog = await privileged('PUBLISHER_SHELL_PROVISION_FAILED', () => provision(publisherId, genesisRootKey))
    }

    if (!catalog.namespaceInitialized) throw shellError('PUBLISHER_SHELL_NAMESPACE_FAILED')
    if (!catalog.admitted) {
      const body = await privileged('PUBLISHER_SHELL_ADMISSION_FAILED', () => encodePublisherOperationBody(
        'publisher.writer-admission',
        {
          writerKey: catalog.localWriterKey,
          signerKey: catalog.localSignerKey,
          capabilities: [...WRITER_CAPABILITIES],
          firstAcceptedSequence: 1,
          expiresAt: WRITER_EXPIRY,
          admissionNonce: normalizedBytes(randomBytes(16), 16, 16),
        },
      ))
      const admission = decodePublisherOperationBody('publisher.writer-admission', body)
      const summary = Object.freeze({
        action: 'admit-local-publisher-device',
        publisherId,
        writerKey: hex(admission.writerKey),
        signerKey: hex(admission.signerKey),
        capabilities: Object.freeze([...admission.capabilities]),
        expiresAt: admission.expiresAt,
      })
      await privileged('PUBLISHER_SHELL_ADMISSION_FAILED', () => authorizeExactRootOperation({
        publisherId,
        recordType: 'publisher.writer-admission',
        body,
        summary,
      }))
      catalog = await privileged('PUBLISHER_SHELL_PROVISION_FAILED', () => provision(publisherId, genesisRootKey))
    }

    if (!catalog.writable || !catalog.admitted) throw shellError('PUBLISHER_SHELL_NOT_READY')
    return {
      status: 'ready' as const,
      publisherId,
      catalogBootstrapKey: catalog.catalogBootstrapKey.slice(),
      writable: true as const,
      admitted: true as const,
    }
  }

  return {
    ensureLocalPublisher() {
      if (inFlight) return inFlight
      inFlight = ensureLocalPublisher().finally(() => { inFlight = null })
      return inFlight
    },
  }
}

export function createDesktopPublisherLifecycleHandlers(
  dependencies: DesktopPublisherLifecycleDependencies,
): PublisherLifecycleRequestHandlers {
  return {
    async publisherEnsureLocalCatalog(input) {
      const value = record(input)
      exactKeys(value, ['action'])
      if (value.action !== 'ensure-local-publisher') {
        throw shellError('PUBLISHER_SHELL_INVALID_REQUEST')
      }
      const result = await dependencies.publisherShell.ensureLocalPublisher()
      return {
        status: result.status,
        publisherId: requiredString(result.publisherId, PUBLISHER_ID_PATTERN),
        catalogBootstrapKey: Array.from(normalizedBytes(result.catalogBootstrapKey, 32, 32)),
        writable: result.writable,
        admitted: result.admitted,
      }
    },
  }
}

export type { PrivilegedPreparedRecord, PrivilegedSignedRecord, PublisherShellSummary }
