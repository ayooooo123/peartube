import b4a from 'b4a'

import {
  MAX_VERIFIED_BLOCK_BYTES,
  VERIFIED_BLOCK_CHUNK_BYTES,
  createVerifiedBlockProof,
} from './block-protocol.js'

function expectedBlockBytes (coreRef, index) {
  if (index < coreRef.length - 1) return coreRef.blockSize
  return coreRef.byteLength - ((coreRef.length - 1) * coreRef.blockSize)
}

function exactCoreState (core, coreRef) {
  return core.length === coreRef.length && core.byteLength === coreRef.byteLength
}

function emptyCoreState (core) {
  return core.length === 0 && core.byteLength === 0
}

function assertActive (isActive, message) {
  if (typeof isActive === 'function' && !isActive()) throw new Error(message)
}

function assertIdentity ({ handle, resourceId, start, end, index }) {
  if (!handle || handle.closed) throw new Error('verified block handle is closed')
  if (String(resourceId) !== handle.source.resourceId) throw new Error('verified block resource does not match its transfer')
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < handle.allowedRange.start || end > handle.allowedRange.end || end <= start) {
    throw new Error('verified block range does not match its transfer')
  }
  if (!Number.isSafeInteger(index) || index < start || index >= end) {
    throw new Error('verified block index is outside the authorized range')
  }
}

function receivePart (transfer, part, kind, limit) {
  if (!transfer || transfer.closed) return { status: 'ignored' }
  if (transfer.policyActive && !transfer.policyActive()) {
    transfer.close('policy-changed')
    return { status: 'ignored' }
  }
  if (!Number.isSafeInteger(part?.totalBytes) || part.totalBytes < 1 || part.totalBytes > limit ||
      !Number.isSafeInteger(part.offset) || part.offset < 0 ||
      !b4a.isBuffer(part.chunk) || part.chunk.byteLength < 1 || part.chunk.byteLength > VERIFIED_BLOCK_CHUNK_BYTES ||
      part.offset + part.chunk.byteLength > part.totalBytes) {
    throw new Error(`verified ${kind} response is not contiguous`)
  }
  let assembly = transfer[kind]
  if (!assembly) {
    if (part.offset !== 0) throw new Error(`verified ${kind} response is not contiguous`)
    assembly = {
      buffer: b4a.allocUnsafe(part.totalBytes),
      receivedBytes: 0,
      totalBytes: part.totalBytes,
    }
    transfer[kind] = assembly
  }
  if (assembly.totalBytes !== part.totalBytes || assembly.receivedBytes !== part.offset) {
    throw new Error(`verified ${kind} response is not contiguous`)
  }
  b4a.copy(part.chunk, assembly.buffer, part.offset)
  assembly.receivedBytes += part.chunk.byteLength
  return { status: assembly.receivedBytes === assembly.totalBytes ? 'complete' : 'accepted', assembly }
}

function createExactCoreSource (options) {
  const coreRef = options.coreRef
  const descriptor = options.descriptor
  const store = options.store?.get ? options.store : null
  const injected = options.core != null
  let core = options.core || null
  let ownsCore = options.ownsCore === true
  let readyPromise = null
  let readyHandle = null
  let quarantinePromise = null
  let permanentlyPoisoned = false
  let closed = false
  let closePromise = null
  let verificationQueue = Promise.resolve()
  const quarantines = new WeakMap()

  function openExactCore () {
    if (!store) throw new Error('asset session core is poisoned')
    const opened = store.get({ key: descriptor.key, manifest: descriptor.hypercoreManifest, writable: false })
    ownsCore = true
    return opened
  }

  if (!core) core = openExactCore()

  async function quarantine (cause, context = null, handle = core) {
    if (!handle || typeof handle !== 'object') return
    const existing = quarantines.get(handle)
    if (existing) return existing
    if (core === handle) {
      core = null
      readyPromise = null
      readyHandle = null
      if (injected) permanentlyPoisoned = true
    }
    const operation = (async () => {
      let closeError = null
      try { await handle.close?.() } catch (error) { closeError = error }
      let callbackError = null
      try { await options.onQuarantine?.({ cause, context, core: handle, permanent: injected }) } catch (error) { callbackError = error }
      if (callbackError || closeError) {
        throw new AggregateError([closeError, callbackError].filter(Boolean), 'asset core quarantine failed')
      }
    })()
    quarantines.set(handle, operation)
    quarantinePromise = operation
    try { await operation } finally {
      if (quarantinePromise === operation) quarantinePromise = null
    }
  }

  async function ready () {
    if (closed) throw new Error('asset session is closed')
    if (permanentlyPoisoned) throw new Error('asset session core is poisoned')
    if (quarantinePromise) await quarantinePromise
    if (closed) throw new Error('asset session is closed')
    if (permanentlyPoisoned) throw new Error('asset session core is poisoned')
    if (!core) core = openExactCore()
    const handle = core
    if (!readyPromise) {
      readyPromise = Promise.resolve(handle.ready?.()).then(() => {
        if (!handle.key || !b4a.equals(b4a.from(handle.key), descriptor.key)) {
          throw new Error('opened asset core key does not match the reconstructed static manifest')
        }
        readyHandle = handle
        return handle
      })
    }
    try { return await readyPromise } catch (error) {
      await quarantine(error, null, handle)
      throw error
    }
  }

  function validateProofMetadata ({ index, proof, byteLength, peerId = null, transferId = null } = {}) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coreRef.length) {
      throw new Error('asset block index exceeds the verified descriptor length')
    }
    const expectedBytes = expectedBlockBytes(coreRef, index)
    if (byteLength !== expectedBytes) throw new Error('asset block value length does not match the verified descriptor')
    if (!proof || typeof proof !== 'object' || !proof.block || proof.block.index !== index || proof.block.value !== null) {
      throw new Error('asset block proof metadata is invalid')
    }
    const handle = core
    if (!handle || readyHandle !== handle) throw new Error('asset session core is not ready')
    if (emptyCoreState(handle)) {
      if (!proof.upgrade || proof.upgrade.start !== 0 || proof.upgrade.length !== coreRef.length) {
        throw new Error('fresh asset core requires an exact descriptor-length upgrade proof')
      }
    } else if (!exactCoreState(handle, coreRef)) {
      const cause = new Error('asset core state conflicts with the verified descriptor')
      return quarantine(cause, { peerId, transferId }, handle).then(
        () => { throw cause },
        error => { throw error },
      )
    } else if (proof.upgrade && (proof.upgrade.length !== coreRef.length || proof.upgrade.start !== 0)) {
      throw new Error('asset block proof length does not match the verified descriptor')
    }
    return expectedBytes
  }

  async function listRanges ({ cursor = null, limit, isActive, list } = {}) {
    assertActive(isActive, 'asset inventory scan was cancelled')
    const handle = await ready()
    assertActive(isActive, 'asset inventory scan was cancelled')
    if (closed) throw new Error('asset session is closed')
    if (!exactCoreState(handle, coreRef)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantine(error, null, handle)
      throw error
    }
    return list({ core: handle, cursor, limit, isActive })
  }

  async function has (index, { isActive } = {}) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coreRef.length) throw new Error('asset block index exceeds the verified descriptor length')
    assertActive(isActive, 'asset block request is closed')
    const handle = await ready()
    assertActive(isActive, 'asset block request is closed')
    if (emptyCoreState(handle)) return false
    if (!exactCoreState(handle, coreRef)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantine(error, null, handle)
      throw error
    }
    let present
    let value = null
    try {
      present = await handle.has(index)
      if (!present && typeof handle.get === 'function') value = await handle.get(index, { wait: false })
    } catch (cause) {
      await quarantine(cause, null, handle)
      throw cause
    }
    assertActive(isActive, 'asset block request is closed')
    if (present === true) return true
    if (value == null) return false
    if (!b4a.isBuffer(value) || value.byteLength !== expectedBlockBytes(coreRef, index)) {
      const error = new Error('verified asset block does not match the descriptor')
      await quarantine(error, null, handle)
      throw error
    }
    return true
  }

  async function read (index, { isActive } = {}) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coreRef.length) throw new Error('asset block index exceeds the verified descriptor length')
    assertActive(isActive, 'asset block read is closed')
    const handle = await ready()
    assertActive(isActive, 'asset block read is closed')
    if (!exactCoreState(handle, coreRef)) {
      if (emptyCoreState(handle)) throw new Error('verified asset block is unavailable')
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantine(error, null, handle)
      throw error
    }
    let value
    try { value = await handle.get(index, { wait: false }) } catch (cause) {
      await quarantine(cause, null, handle)
      throw cause
    }
    if (value == null) throw new Error('verified asset block is unavailable')
    assertActive(isActive, 'asset block read is closed')
    if (!b4a.isBuffer(value) || value.byteLength !== expectedBlockBytes(coreRef, index)) {
      const error = new Error('verified asset block does not match the descriptor')
      await quarantine(error, null, handle)
      throw error
    }
    if (!exactCoreState(handle, coreRef)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantine(error, null, handle)
      throw error
    }
    return value
  }

  async function proof (index) {
    const handle = await ready()
    return handle.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: coreRef.length } })
  }

  async function applyOnce ({ index, proof, value, peerId = null, transferId = null, isActive } = {}) {
    assertActive(isActive, 'asset block request is closed')
    const handle = await ready()
    if (closed) throw new Error('asset session is closed')
    assertActive(isActive, 'asset block request is closed')
    if (!exactCoreState(handle, coreRef) && !emptyCoreState(handle)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantine(error, { peerId, transferId }, handle)
      throw error
    }
    await validateProofMetadata({ index, proof, byteLength: b4a.isBuffer(value) ? value.byteLength : null, peerId, transferId })
    assertActive(isActive, 'asset block request is closed')
    let applied
    try { applied = await handle.applyProof({ ...proof, block: { ...proof.block, value } }) } catch (cause) {
      await quarantine(cause, { peerId, transferId }, handle)
      throw new Error('asset block proof verification failed', { cause })
    }
    if (applied !== true) {
      const cause = new Error('core.applyProof rejected the asset block')
      await quarantine(cause, { peerId, transferId }, handle)
      throw new Error('asset block proof verification failed', { cause })
    }
    try {
      if (!exactCoreState(handle, coreRef)) throw new Error('asset core state conflicts with the verified descriptor')
      if (!await handle.has(index)) throw new Error('verified asset block was not committed')
    } catch (cause) {
      await quarantine(cause, { peerId, transferId }, handle)
      throw new Error('asset block proof verification failed', { cause })
    }
    if (closed) throw new Error('asset session is closed')
    assertActive(isActive, 'asset block request is closed')
    return { index }
  }

  function apply (input = {}) {
    const operation = verificationQueue.then(() => applyOnce(input))
    verificationQueue = operation.catch(() => {})
    return operation
  }

  async function close () {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      await verificationQueue
      if (quarantinePromise) await quarantinePromise
      const handle = core
      core = null
      readyPromise = null
      readyHandle = null
      if (handle && ownsCore) await handle.close?.()
    })()
    return closePromise
  }

  return {
    resourceId: String(options.resourceId),
    coreRef,
    descriptor,
    manifest: descriptor.hypercoreManifest,
    get core () { return core },
    get poisoned () { return permanentlyPoisoned },
    ready,
    validateProofMetadata,
    listRanges,
    has,
    read,
    proof,
    apply,
    quarantine,
    close,
  }
}

export function createVerifiedBlockEngine (options = {}) {
  const handles = new Set()
  const schedule = options.setTimeout || setTimeout
  const unschedule = options.clearTimeout || clearTimeout
  let closed = false

  function createSource (sourceOptions = {}) {
    if (closed) throw new Error('verified block engine is closed')
    return createExactCoreSource(sourceOptions)
  }

  function attach ({ scope = null, source, allowedRange, policyEpoch = () => 0, mayServe = () => true } = {}) {
    if (closed) throw new Error('verified block engine is closed')
    if (!source || typeof source.resourceId !== 'string') throw new Error('verified block source is required')
    const sourceLength = source.coreRef?.length ?? source.length
    if (!Number.isSafeInteger(allowedRange?.start) || !Number.isSafeInteger(allowedRange?.end) ||
        !Number.isSafeInteger(sourceLength) || allowedRange.start < 0 ||
        allowedRange.end <= allowedRange.start || allowedRange.end > sourceLength) {
      throw new Error('verified block allowed range is invalid')
    }
    const handle = { scope, source, allowedRange: { ...allowedRange }, policyEpoch, mayServe, transfers: new Set(), closed: false }
    handles.add(handle)
    return handle
  }

  function createTransfer ({ handle, resourceId, start, end, index, peerId = null, transferId = null, timeoutMs = null, signal = null, onTimeout = null, onCancel = null } = {}) {
    assertIdentity({ handle, resourceId, start, end, index })
    const epoch = typeof handle.policyEpoch === 'function' ? handle.policyEpoch() : handle.policyEpoch
    const transfer = {
      handle, resourceId: String(resourceId), start, end, index, peerId, transferId,
      proof: null, block: null, closed: false, reason: null, timer: null,
      policyActive: () => !handle.closed && (typeof handle.policyEpoch === 'function' ? handle.policyEpoch() : handle.policyEpoch) === epoch,
      close (reason = 'cancelled') {
        if (this.closed) return false
        this.closed = true
        this.reason = reason
        if (this.timer) unschedule(this.timer)
        this.timer = null
        signal?.removeEventListener?.('abort', this.onAbort)
        handle.transfers.delete(this)
        return true
      },
      onAbort: null,
    }
    transfer.onAbort = () => {
      if (transfer.close('cancelled')) onCancel?.(transfer)
    }
    if (timeoutMs !== null) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('verified block timeout is invalid')
      transfer.timer = schedule(() => {
        if (transfer.close('timeout')) onTimeout?.(transfer)
      }, timeoutMs)
      transfer.timer?.unref?.()
    }
    handle.transfers.add(transfer)
    signal?.addEventListener?.('abort', transfer.onAbort, { once: true })
    if (signal?.aborted) transfer.onAbort()
    return transfer
  }

  function receiveProofPart ({ handle, transfer, part } = {}) {
    if (!transfer || transfer.closed) return { status: 'ignored' }
    assertIdentity({ handle, resourceId: part?.resourceId, start: part?.start, end: part?.end, index: part?.index })
    if (transfer.handle !== handle || transfer.resourceId !== String(part.resourceId) || transfer.start !== part.start || transfer.end !== part.end || transfer.index !== part.index) {
      throw new Error('verified proof part does not match its transfer')
    }
    return receivePart(transfer, part, 'proof', options.maxProofBytes || 32 * 1024)
  }

  function receiveBlockPart ({ handle, transfer, part } = {}) {
    if (!transfer || transfer.closed) return { status: 'ignored' }
    assertIdentity({ handle, resourceId: part?.resourceId, start: part?.start, end: part?.end, index: part?.index })
    if (transfer.handle !== handle || transfer.resourceId !== String(part.resourceId) || transfer.start !== part.start || transfer.end !== part.end || transfer.index !== part.index) {
      throw new Error('verified block part does not match its transfer')
    }
    return receivePart(transfer, part, 'block', MAX_VERIFIED_BLOCK_BYTES)
  }

  async function finish ({ handle, request = null, transfer, proof } = {}) {
    if (!transfer || transfer.closed) return { status: 'ignored' }
    if (transfer.handle !== handle || !transfer.policyActive()) {
      transfer.close('policy-changed')
      return { status: 'ignored' }
    }
    if (!transfer.proof || transfer.proof.receivedBytes !== transfer.proof.totalBytes ||
        (transfer.expectedBlockBytes !== 0 &&
          (!transfer.block || transfer.block.receivedBytes !== transfer.block.totalBytes))) {
      throw new Error('verified block transfer is incomplete')
    }
    const value = transfer.expectedBlockBytes === 0 ? b4a.alloc(0) : transfer.block.buffer
    await handle.source.apply({
      index: transfer.index,
      proof,
      value,
      peerId: transfer.peerId,
      transferId: transfer.transferId,
      isActive: () => !transfer.closed && transfer.policyActive() && (!request || request.closed !== true),
    })
    if (!transfer.close('complete')) return { status: 'ignored' }
    return { status: 'complete', index: transfer.index }
  }

  async function serve ({ handle, peerId = null, request, sendProofPart, sendBlockPart, sendError = null, isActive = () => true, encodeProof, reserve = options.admission } = {}) {
    assertIdentity({ handle, resourceId: request?.resourceId, start: request?.start, end: request?.end, index: request?.index })
    const epoch = typeof handle.policyEpoch === 'function' ? handle.policyEpoch() : handle.policyEpoch
    const active = () => !closed && !handle.closed && isActive() && handle.mayServe() &&
      (typeof handle.policyEpoch === 'function' ? handle.policyEpoch() : handle.policyEpoch) === epoch
    if (!active() || !await handle.source.has(request.index, { isActive: active })) {
      await sendError?.()
      return { status: 'unavailable' }
    }
    const proof = await createVerifiedBlockProof(handle.source, request.index)
    const value = b4a.from(proof?.block?.value || [])
    if (!active()) {
      await sendError?.()
      return { status: 'unavailable' }
    }
    if (proof?.block?.index !== request.index || value.byteLength !== expectedBlockBytes(handle.source.coreRef, request.index)) {
      throw new Error('local asset block does not match the verified descriptor')
    }
    const proofBytes = encodeProof({ index: request.index, proof, value })
    const reservation = reserve ? await reserve({ handle, peerId, request, bytes: value.byteLength }) : null
    if (reserve && !reservation) {
      await sendError?.()
      return { status: 'unavailable' }
    }
    try {
      for (let offset = 0; offset < proofBytes.byteLength; offset += VERIFIED_BLOCK_CHUNK_BYTES) {
        if (!active()) return { status: 'cancelled' }
        const chunk = proofBytes.subarray(offset, Math.min(proofBytes.byteLength, offset + VERIFIED_BLOCK_CHUNK_BYTES))
        if (!await sendProofPart({ offset, totalBytes: proofBytes.byteLength, chunk })) return { status: 'cancelled' }
      }
      for (let offset = 0; offset < value.byteLength; offset += VERIFIED_BLOCK_CHUNK_BYTES) {
        if (!active()) return { status: 'cancelled' }
        const chunk = value.subarray(offset, Math.min(value.byteLength, offset + VERIFIED_BLOCK_CHUNK_BYTES))
        if (!await sendBlockPart({ offset, totalBytes: value.byteLength, chunk })) return { status: 'cancelled' }
      }
      reservation?.commit?.()
      return { status: 'sent', bytes: value.byteLength }
    } finally {
      reservation?.release?.()
    }
  }

  function detach (handle) {
    if (!handle || handle.closed) return false
    handle.closed = true
    for (const transfer of [...handle.transfers]) transfer.close('detached')
    handles.delete(handle)
    return true
  }

  async function close () {
    if (closed) return
    closed = true
    for (const handle of [...handles]) detach(handle)
  }

  return { createSource, attach, detach, createTransfer, serve, receiveProofPart, receiveBlockPart, finish, close }
}
