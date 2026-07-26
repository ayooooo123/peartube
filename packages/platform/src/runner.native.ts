/* eslint-disable no-empty */
import { createProtocolClient, PROTOCOL_EVENTS } from '@peartube/host'

import { createJsonFrameParser, encodeJsonFrame } from './ipc-json-framing.js'
import type { HostProtocolVersion, PlatformLifecycleEvent, PlatformRunner } from './rpc.shared'
import { launchNativeWorklet } from './native-worklet-launch.js'

type WorkletInstance = {
  start(id: string, source: string, args?: string[]): void
  start(path: string, args?: string[]): void
  terminate(): void
  IPC: any
}

type NativeRunnerDependencies = {
  WorkletCtor: new () => WorkletInstance
  backendSource?: string
  backendPath?: string
  workletId?: string
  shutdownTimeoutMs?: number
  resolveLaunchArgs?(options: {
    platform: 'mobile' | 'desktop'
    storagePath: string
    entrypoint: string
    args?: string[]
    protocolVersion: HostProtocolVersion
  }): string[]
  createProtocolClientImpl?: typeof createProtocolClient
}

export type LegacyPublisherRootMigrationRequest = {
  version: 1
  identityPublicKey: Uint8Array
  secretKey: Uint8Array
  challenge: Uint8Array
}

export type LegacyPublisherRootMigrationAcknowledgement = {
  version: 1
  durable: true
  publicKey: Uint8Array | string
  challengeSignature: Uint8Array | string
}

export type LegacyPublisherRootPreflightSummary = {
  status: 'complete' | 'pending' | 'no-legacy-roots' | 'unavailable'
  scanned: number
  migrated: number
  remaining: number
  errorCode?: string
}

export type LegacyPublisherRootMigrationCallback = (
  request: LegacyPublisherRootMigrationRequest,
) => Promise<LegacyPublisherRootMigrationAcknowledgement>

type NativeLegacyPublisherRootPreflightOptions = {
  WorkletCtor: new () => WorkletInstance
  backendSource?: string
  backendPath?: string
  workletId?: string
  storagePath: string
  timeoutMs?: number
  migrateLegacyPublisherRoot: LegacyPublisherRootMigrationCallback
}

const LEGACY_ROOT_PREFLIGHT_ENTRYPOINT = 'legacy-publisher-root-preflight'
const LEGACY_ROOT_PREFLIGHT_WORKLET_ID = '/peartube-legacy-publisher-root-preflight.bundle'
const LEGACY_ROOT_MAX_FRAME_BYTES = 8192
const LEGACY_ROOT_MAX_REQUESTS = 64
const LEGACY_ROOT_DEFAULT_TIMEOUT_MS = 30000
const LEGACY_ROOT_CHALLENGE_BYTES = 108
const LEGACY_ROOT_SUMMARY_STATUS: Record<LegacyPublisherRootPreflightSummary['status'], true> = {
  complete: true,
  pending: true,
  'no-legacy-roots': true,
  unavailable: true,
}
const LEGACY_ROOT_ERROR_CODE: Record<string, true> = {
  STORAGE_LOCKED: true,
  STORAGE_UNAVAILABLE: true,
  MIGRATION_UNAVAILABLE: true,
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLegacyRootSummaryStatus(value: unknown): value is LegacyPublisherRootPreflightSummary['status'] {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LEGACY_ROOT_SUMMARY_STATUS, value)
}


function unavailableLegacyRootSummary(): LegacyPublisherRootPreflightSummary {
  return {
    status: 'unavailable',
    scanned: 0,
    migrated: 0,
    remaining: 0,
    errorCode: 'MIGRATION_TRANSPORT_UNAVAILABLE',
  }
}

function boundedLegacyRootCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
    : 0
}

function projectLegacyRootSummary(value: unknown): LegacyPublisherRootPreflightSummary {
  if (!isUnknownRecord(value) || !isLegacyRootSummaryStatus(value.status)) {
    return unavailableLegacyRootSummary()
  }

  const summary: LegacyPublisherRootPreflightSummary = {
    status: value.status,
    scanned: boundedLegacyRootCount(value.scanned),
    migrated: boundedLegacyRootCount(value.migrated),
    remaining: boundedLegacyRootCount(value.remaining),
  }
  if (
    value.status === 'unavailable' &&
    typeof value.errorCode === 'string' &&
    LEGACY_ROOT_ERROR_CODE[value.errorCode] === true
  ) {
    summary.errorCode = value.errorCode
  }
  return summary
}


function fixedHexToBytes(value: unknown, byteLength: number): Uint8Array | null {
  if (typeof value !== 'string' ||
      value.length !== byteLength * 2 ||
      !/^[0-9a-f]+$/i.test(value)) return null

  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function fixedBytesToHex(value: unknown, byteLength: number): string | null {
  if (typeof value === 'string') {
    return value.length === byteLength * 2 && /^[0-9a-f]+$/i.test(value)
      ? value.toLowerCase()
      : null
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) return null

  let hex = ''
  for (const byte of value) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function decodeLegacyRootFrameChunk(
  chunk: unknown,
): { text: string; byteLength: number } | null {
  if (typeof chunk === 'string') {
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk.charCodeAt(index) > 0x7f) return null
    }
    return { text: chunk, byteLength: chunk.length }
  }

  let bytes: Uint8Array
  if (chunk instanceof Uint8Array) {
    bytes = chunk
  } else if (chunk instanceof ArrayBuffer) {
    bytes = new Uint8Array(chunk)
  } else {
    return null
  }
  if (bytes.byteLength > LEGACY_ROOT_MAX_FRAME_BYTES) return null

  let text = ''
  for (const byte of bytes) {
    if (byte > 0x7f) return null
    text += String.fromCharCode(byte)
  }
  return { text, byteLength: bytes.byteLength }
}


/**
 * Launch the migration-only Bare worklet and bridge its single-purpose
 * challenge protocol to the native shell vault. This transport is deliberately
 * separate from the long-lived HRPC bridge.
 */
export async function runNativeLegacyPublisherRootPreflight(
  options: NativeLegacyPublisherRootPreflightOptions,
): Promise<LegacyPublisherRootPreflightSummary> {
  const worklet = new options.WorkletCtor()
  const ipc = worklet.IPC
  const parser = createJsonFrameParser()
  let pendingFrameBytes = 0
  let pendingRequest = false
  let requestCount = 0
  let settled = false
  let cleanup = () => {}

  try {
    return await new Promise<LegacyPublisherRootPreflightSummary>((resolve) => {
      const finish = (summary: LegacyPublisherRootPreflightSummary) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(summary)
      }
      const timer = setTimeout(
        () => finish(unavailableLegacyRootSummary()),
        options.timeoutMs ?? LEGACY_ROOT_DEFAULT_TIMEOUT_MS,
      )

      const sendAcknowledgement = (message: Record<string, unknown>) => {
        if (settled) return
        const encoded = encodeJsonFrame(message)
        if (encoded.length > LEGACY_ROOT_MAX_FRAME_BYTES) {
          finish(unavailableLegacyRootSummary())
          return
        }
        try {
          ipc.write(Buffer.from(encoded))
        } catch {
          finish(unavailableLegacyRootSummary())
        }
      }

      const rejectRequest = (id: number) => {
        sendAcknowledgement({
          type: 'legacy-publisher-root-migration-ack',
          id,
          ok: false,
          errorCode: 'MIGRATION_REQUEST_REJECTED',
        })
      }

      const handleMigrationRequest = async (message: Record<string, unknown>) => {
        const id = typeof message.id === 'number' &&
          Number.isSafeInteger(message.id) &&
          message.id > 0
          ? message.id
          : 0

        if (id === 0 || pendingRequest || requestCount >= LEGACY_ROOT_MAX_REQUESTS) {
          rejectRequest(id)
          return
        }

        const publicKey = fixedHexToBytes(message.identityPublicKey, 32)
        const secretKey = fixedHexToBytes(message.secretKey, 64)
        const challenge = fixedHexToBytes(message.challenge, LEGACY_ROOT_CHALLENGE_BYTES)
        message.secretKey = ''
        message.challenge = ''
        if (message.version !== 1 || !publicKey || !secretKey || !challenge) {
          secretKey?.fill(0)
          challenge?.fill(0)
          rejectRequest(id)
          return
        }

        pendingRequest = true
        requestCount += 1
        try {
          const acknowledgement = await options.migrateLegacyPublisherRoot({
            version: 1,
            identityPublicKey: publicKey,
            secretKey,
            challenge,
          })
          const acknowledgedPublicKey = fixedBytesToHex(acknowledgement?.publicKey, 32)
          const challengeSignature = fixedBytesToHex(acknowledgement?.challengeSignature, 64)
          if (
            acknowledgement?.version !== 1 ||
            acknowledgement?.durable !== true ||
            !acknowledgedPublicKey ||
            !challengeSignature
          ) {
            rejectRequest(id)
            return
          }
          sendAcknowledgement({
            type: 'legacy-publisher-root-migration-ack',
            id,
            ok: true,
            version: 1,
            durable: true,
            publicKey: acknowledgedPublicKey,
            challengeSignature,
          })
        } catch {
          rejectRequest(id)
        } finally {
          secretKey.fill(0)
          challenge.fill(0)
          pendingRequest = false
        }
      }

      const onData = (chunk: unknown) => {
        const decoded = decodeLegacyRootFrameChunk(chunk)
        if (!decoded) {
          finish(unavailableLegacyRootSummary())
          return
        }
        pendingFrameBytes += decoded.byteLength
        if (pendingFrameBytes > LEGACY_ROOT_MAX_FRAME_BYTES) {
          finish(unavailableLegacyRootSummary())
          return
        }

        let messages
        try {
          messages = parser.push(decoded.text)
        } catch {
          finish(unavailableLegacyRootSummary())
          return
        }
        if (messages.length > 0) pendingFrameBytes = 0

        for (const message of messages) {
          if (message?.type === 'legacy-publisher-root-migration-request') {
            void handleMigrationRequest(message)
          } else if (message?.type === 'legacy-publisher-root-preflight-result') {
            finish(projectLegacyRootSummary(message.summary))
          }
        }
      }
      const onClose = () => finish(unavailableLegacyRootSummary())

      cleanup = () => {
        clearTimeout(timer)
        try { ipc.removeListener?.('data', onData) } catch {}
        try { ipc.removeListener?.('close', onClose) } catch {}
        try { ipc.removeListener?.('end', onClose) } catch {}
      }

      try {
        ipc.on?.('data', onData)
        ipc.on?.('close', onClose)
        ipc.on?.('end', onClose)
        launchNativeWorklet(worklet, {
          backendPath: options.backendPath ?? '',
          backendSource: options.backendSource ?? '',
          workletId: options.workletId ?? LEGACY_ROOT_PREFLIGHT_WORKLET_ID,
          launchArgs: [options.storagePath, LEGACY_ROOT_PREFLIGHT_ENTRYPOINT],
        })
      } catch {
        finish(unavailableLegacyRootSummary())
      }
    })
  } finally {
    cleanup()
    try { worklet.terminate() } catch {}
  }
}

function createLifecycleController() {
  const listeners = new Set<(event: PlatformLifecycleEvent) => void>()

  return {
    emit(event: PlatformLifecycleEvent) {
      for (const listener of listeners) listener(event)
    },
    on(listener: (event: PlatformLifecycleEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function sendShutdownSignalViaIpc(worklet: WorkletInstance, timeoutMs: number) {
  const ipc = worklet?.IPC
  if (!ipc?.write) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    const parser = createJsonFrameParser()

    function onData(chunk: any) {
      for (const message of parser.push(chunk)) {
        if (message?.type === 'shutdown-complete') {
          cleanup()
          resolve()
          return
        }
      }
    }

    function onClose() {
      cleanup()
      resolve()
    }

    function cleanup() {
      clearTimeout(timer)
      try { ipc.removeListener?.('data', onData) } catch {}
      try { ipc.removeListener?.('close', onClose) } catch {}
    }

    try {
      ipc.on?.('data', onData)
      ipc.on?.('close', onClose)
      ipc.write(Buffer.from(encodeJsonFrame({ type: 'shutdown' })))
    } catch {
      cleanup()
      resolve()
    }
  })
}

export function createNativeRunner(dependencies: NativeRunnerDependencies): PlatformRunner {
  const createClient = dependencies.createProtocolClientImpl ?? createProtocolClient

  return {
    async start(options) {
      const lifecycle = createLifecycleController()
      const worklet = new dependencies.WorkletCtor()
      const stream = worklet.IPC
      const client = createClient({ stream })

      const readyPromise = client.ready()

      client.events.on(PROTOCOL_EVENTS.HOST_READY, (data: any) => {
        lifecycle.emit({ type: 'host.ready', data })
      })

      client.events.on(PROTOCOL_EVENTS.HOST_ERROR, (data: any) => {
        lifecycle.emit({ type: 'host.error', ...data })
      })

      client.events.on(PROTOCOL_EVENTS.TRANSPORT_CLOSED, (data: any) => {
        lifecycle.emit({ type: 'transport.closed', reason: data?.reason })
      })

      const launchArgs = dependencies.resolveLaunchArgs
        ? dependencies.resolveLaunchArgs(options)
        : [options.storagePath, options.entrypoint, ...(options.args ?? [])]

      launchNativeWorklet(worklet, {
        backendPath: dependencies.backendPath ?? '',
        backendSource: dependencies.backendSource ?? '',
        workletId: dependencies.workletId ?? options.entrypoint,
        launchArgs,
      })

      let terminated = false

      return {
        stream,
        client,
        publisherSigner: options.publisherSigner ?? undefined,
        waitUntilReady() {
          return readyPromise
        },
        async terminate() {
          if (terminated) return
          terminated = true
          await sendShutdownSignalViaIpc(worklet, dependencies.shutdownTimeoutMs ?? 4000)
          worklet.terminate()
        },
        onLifecycle(listener) {
          return lifecycle.on(listener)
        }
      }
    }
  }
}
