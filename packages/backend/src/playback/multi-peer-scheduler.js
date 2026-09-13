import b4a from 'b4a'

import { normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import { createAbortController } from '../abort-controller.js'

const DEFAULT_MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024

function abortError(message = 'playback range request aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function unavailable(errorCode) {
  return { status: 'unavailable', errorCode, originAttempted: false }
}

function validateSession(coreRef, session) {
  let sessionCoreRef
  try {
    sessionCoreRef = normalizeAssetCoreRefV2(session?.coreRef, 'session.coreRef')
  } catch {
    throw new Error('scheduler asset session identity does not match coreRef')
  }
  const identityFields = ['kind', 'key', 'treeHash', 'length', 'byteLength', 'blockSize', 'assetId']
  if (!session?.core || session.assetId !== coreRef.assetId ||
      identityFields.some(field => sessionCoreRef[field] !== coreRef[field])) {
    throw new Error('scheduler asset session identity does not match coreRef')
  }
}

function validateRequest(input, coreRef, session) {
  if (input.assetId !== coreRef.assetId || session.assetId !== coreRef.assetId) {
    throw new Error('playback assetId does not match scheduler identity')
  }
  const byteStart = Number(input.byteStart)
  const byteEnd = Number(input.byteEnd)
  if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) ||
      byteStart < 0 || byteEnd <= byteStart || byteEnd > coreRef.byteLength) {
    throw new Error('invalid half-open playback byte range')
  }
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0 || input.deadlineMs > 0x7fffffff) {
    throw new Error('deadlineMs must be a positive bounded duration')
  }
  const priority = input.priority ?? 'playhead'
  if (priority !== 'playhead' && priority !== 'prefetch') throw new Error('playback priority is invalid')
  return {
    byteStart,
    byteEnd,
    startBlock: Math.floor(byteStart / coreRef.blockSize),
    endBlock: Math.ceil(byteEnd / coreRef.blockSize),
    deadlineMs: input.deadlineMs,
    priority,
    materialize: input.materialize !== false,
  }
}

function peerIds(core) {
  const ids = new Set()
  for (const peer of core.peers || []) {
    const key = peer?.remotePublicKey
    if ((b4a.isBuffer(key) || key instanceof Uint8Array) && key.byteLength === 32) {
      ids.add(b4a.toString(key, 'hex'))
    }
  }
  return [...ids].sort()
}

function waitForPeer(core, timeoutMs, signal) {
  if ((core.peers?.length || 0) > 0) return Promise.resolve(true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const finish = found => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      core.off?.('peer-add', onPeer)
      signal.removeEventListener?.('abort', onAbort)
      resolve(found)
    }
    const onPeer = () => finish(true)
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    core.on?.('peer-add', onPeer)
    signal.addEventListener?.('abort', onAbort, { once: true })
    if ((core.peers?.length || 0) > 0) finish(true)
  })
}

async function materialize(core, coreRef, request, signal) {
  const blocks = []
  for (let index = request.startBlock; index < request.endBlock; index++) {
    if (signal?.aborted) throw signal.reason || abortError()
    blocks.push(await core.get(index))
  }
  const bytes = blocks.length === 1 ? blocks[0] : b4a.concat(blocks)
  const offset = request.byteStart - request.startBlock * coreRef.blockSize
  return bytes.subarray(offset, offset + request.byteEnd - request.byteStart)
}
async function fetchVerifiedRange ({ core, coreRef, request, signal, peerWaitMs, setRange }) {
  await core.ready()
  if (!await core.has(request.startBlock, request.endBlock)) {
    if (!await waitForPeer(core, Math.min(peerWaitMs, request.deadlineMs), signal)) {
      return unavailable('NO_VERIFIED_SOURCE')
    }
    const range = core.download({
      start: request.startBlock,
      end: request.endBlock,
      linear: request.priority === 'playhead',
    })
    setRange(range)
    await range.done()
  }
  if (signal.aborted) throw signal.reason
  if (!await core.has(request.startBlock, request.endBlock)) return unavailable('NO_VERIFIED_SOURCE')
  return {
    status: 'ok',
    ...(request.materialize ? { bytes: await materialize(core, coreRef, request, signal) } : {}),
    verified: true,
    peerIds: peerIds(core),
    originAttempted: false,
  }
}
function mapRequestFailure (error, abortKind, callerSignal) {
  if (abortKind === 'caller' || callerSignal?.aborted || error?.name === 'AbortError') throw abortError()
  if (abortKind === 'deadline' || error?.code === 'DEADLINE_EXCEEDED') return unavailable('DEADLINE_EXCEEDED')
  return unavailable('NO_VERIFIED_SOURCE')
}



/**
 * Thin playback adapter over Hypercore's native sparse replication.
 *
 * Peer selection, range scheduling, retries and Merkle-proof verification are
 * Hypercore responsibilities. PearTube only validates the signed asset
 * identity, bounds the requested bytes, and materializes the verified range.
 */
export function createMultiPeerScheduler(options = {}) {
  const coreRef = normalizeAssetCoreRefV2(options.coreRef, 'coreRef')
  const session = options.session
  validateSession(coreRef, session)
  const core = session.core
  const maxInFlightBytes = Number.isSafeInteger(options.maxInFlightBytes) && options.maxInFlightBytes > 0
    ? options.maxInFlightBytes
    : DEFAULT_MAX_IN_FLIGHT_BYTES
  const peerWaitMs = Number.isSafeInteger(options.peerWaitMs) && options.peerWaitMs > 0
    ? Math.min(options.peerWaitMs, 30_000)
    : 3_000
  const active = new Set()
  let inFlightBytes = 0

  async function requestRange(input = {}) {
    const request = validateRequest(input, coreRef, session)
    const requestBytes = request.byteEnd - request.byteStart
    if (request.materialize && (requestBytes > maxInFlightBytes || inFlightBytes + requestBytes > maxInFlightBytes)) {
      return unavailable('BUDGET_EXHAUSTED')
    }
    if (input.signal?.aborted) throw abortError()

    let range = null
    let timeout = null
    let abortKind = null
    const controller = createAbortController()
    const cancellation = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason || abortError()), { once: true })
    })
    const cancel = kind => {
      if (abortKind) return
      abortKind = kind
      range?.destroy?.()
      controller.abort(kind === 'deadline'
        ? Object.assign(new Error('playback range deadline exceeded'), { code: 'DEADLINE_EXCEEDED' })
        : abortError())
    }
    const onAbort = () => cancel('caller')
    const tracked = { request, cancel }
    active.add(tracked)
    if (request.materialize) inFlightBytes += requestBytes
    input.signal?.addEventListener?.('abort', onAbort, { once: true })
    timeout = setTimeout(() => cancel('deadline'), request.deadlineMs)

    try {
      const operation = fetchVerifiedRange({
        core,
        coreRef,
        request,
        signal: controller.signal,
        peerWaitMs,
        setRange(value) { range = value },
      })
      return await Promise.race([operation, cancellation])
    } catch (error) {
      return mapRequestFailure(error, abortKind, input.signal)
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener?.('abort', onAbort)
      active.delete(tracked)
      if (request.materialize) inFlightBytes -= requestBytes
    }
  }

  function seek({ byteStart } = {}) {
    if (!Number.isSafeInteger(byteStart) || byteStart < 0 || byteStart > coreRef.byteLength) {
      throw new Error('seek byteStart is invalid')
    }
    for (const tracked of [...active]) {
      if (tracked.request.priority !== 'prefetch') continue
      if (byteStart >= tracked.request.byteStart && byteStart < tracked.request.byteEnd) continue
      tracked.cancel('seek')
    }
  }

  function metrics() {
    return {
      inFlightBytes,
      activeDownloads: active.size,
      peers: peerIds(core).map(peerId => ({ peerId })),
    }
  }

  return { coreRef, requestRange, seek, metrics }
}
