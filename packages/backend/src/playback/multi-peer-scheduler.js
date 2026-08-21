import b4a from 'b4a'

import { normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import {
  MAX_ASSET_BLOCKS_PER_REQUEST,
  MAX_ASSET_RANGE_BITS_PER_RANGE,
  MAX_ASSET_RANGE_PAGE_RANGES,
} from '../network/frame.js'

const DEFAULT_MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024
const MAX_INVENTORY_PAGES_PER_PEER = 16
const MAX_TRACKED_PEERS = 64
const MAX_ACTIVE_TRANSPORT_RUNS = 16
const INVALID_PROOF_CODES = new Set(['INVALID_PROOF', 'QUARANTINED', 'ASSET_INVALID_PROOF', 'ASSET_QUARANTINED'])
function abortError(message = 'playback range request aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function unavailable(errorCode) {
  return { status: 'unavailable', errorCode, originAttempted: false }
}

function blockByteLength(coreRef, index) {
  return index === coreRef.length - 1
    ? coreRef.byteLength - (index * coreRef.blockSize)
    : coreRef.blockSize
}

function normalizePeerIds(input) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.map(value => String(value)).filter(Boolean))].sort().slice(0, MAX_TRACKED_PEERS)
}

function pageClaimsBlock(page, blockIndex) {
  for (const range of page?.ranges || []) {
    const start = Number(range?.startBlock)
    const bitCount = Number(range?.bitCount)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(bitCount) || bitCount < 1) continue
    const bit = blockIndex - start
    if (bit < 0 || bit >= bitCount || !b4a.isBuffer(range.presentBitfield)) continue
    if ((range.presentBitfield[bit >> 3] & (1 << (bit & 7))) !== 0) return true
  }
  return false
}

function coalesceAssignments(assignments) {
  const runs = []
  for (const assignment of assignments) {
    const previous = runs[runs.length - 1]
    if (previous && previous.peerId === assignment.peerId && previous.endBlock === assignment.index &&
        previous.endBlock - previous.startBlock < MAX_ASSET_BLOCKS_PER_REQUEST) {
      previous.endBlock++
      previous.reservations.push(assignment.reservation)
      previous.bytes += assignment.bytes
      continue
    }
    runs.push({
      peerId: assignment.peerId,
      startBlock: assignment.index,
      endBlock: assignment.index + 1,
      bytes: assignment.bytes,
      reservations: [assignment.reservation],
    })
  }
  return runs
}

export function createMultiPeerScheduler(options = {}) {
  const coreRef = normalizeAssetCoreRefV2(options.coreRef, 'coreRef')
  const session = options.session
  let sessionCoreRef
  try {
    sessionCoreRef = normalizeAssetCoreRefV2(session?.coreRef, 'session.coreRef')
  } catch {
    throw new Error('scheduler asset session identity does not match coreRef')
  }
  const identityFields = ['kind', 'key', 'treeHash', 'length', 'byteLength', 'blockSize', 'assetId']
  if (!session || session.assetId !== coreRef.assetId ||
      identityFields.some(field => sessionCoreRef[field] !== coreRef[field])) {
    throw new Error('scheduler asset session identity does not match coreRef')
  }
  const transport = options.transport
  for (const method of ['getActiveAssetPeerIds', 'listPeerAssetRanges', 'hasVerifiedAssetBlock', 'readVerifiedAssetBlock', 'requestAssetBlocks']) {
    if (typeof transport?.[method] !== 'function') throw new Error(`scheduler transport.${method} is required`)
  }
  const maxInFlightBytes = Number.isSafeInteger(options.maxInFlightBytes) && options.maxInFlightBytes > 0
    ? options.maxInFlightBytes
    : DEFAULT_MAX_IN_FLIGHT_BYTES
  const now = typeof options.now === 'function' ? options.now : Date.now
  const peers = new Map()
  const activePrefetch = new Set()
  let inFlightBytes = 0
  let peerRequests = 0
  let prefetchGeneration = 0
  const requestedRunCap = Number(options.maxActiveTransportRuns)
  const maxActiveTransportRuns = Number.isSafeInteger(requestedRunCap) && requestedRunCap > 0
    ? Math.min(requestedRunCap, MAX_ACTIVE_TRANSPORT_RUNS)
    : MAX_ACTIVE_TRANSPORT_RUNS
  const runSlotWaiters = []
  let activeTransportRuns = 0

  function drainRunSlots() {
    while (activeTransportRuns < maxActiveTransportRuns && runSlotWaiters.length > 0) {
      const waiter = runSlotWaiters.shift()
      if (waiter.cancelled) continue
      waiter.cleanup()
      waiter.resolve(createRunSlotLease())
    }
  }

  function createRunSlotLease() {
    activeTransportRuns++
    let released = false
    return () => {
      if (released) return
      released = true
      activeTransportRuns--
      drainRunSlots()
    }
  }

  function acquireRunSlot(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || abortError())
    if (activeTransportRuns < maxActiveTransportRuns) {
      return Promise.resolve(createRunSlotLease())
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        cancelled: false,
        cleanup: null,
      }
      const onAbort = () => {
        if (waiter.cancelled) return
        waiter.cancelled = true
        const index = runSlotWaiters.indexOf(waiter)
        if (index !== -1) runSlotWaiters.splice(index, 1)
        waiter.cleanup()
        reject(signal.reason || abortError())
      }
      waiter.cleanup = () => signal?.removeEventListener?.('abort', onAbort)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      runSlotWaiters.push(waiter)
      if (signal?.aborted) onAbort()
    })
  }

  function pruneInactivePeers(activePeerIds) {
    const active = new Set(activePeerIds)
    for (const [peerId, state] of peers) {
      if (!active.has(peerId) && state.inFlightBytes === 0) peers.delete(peerId)
    }
  }
  function peerState(peerId) {
    let state = peers.get(peerId)
    if (!state) {
      if (peers.size >= MAX_TRACKED_PEERS) return null
      state = {
        peerId,
        rttMs: 0,
        throughputBytesPerSecond: 1,
        inFlightBytes: 0,
        failures: 0,
        invalidProofFailures: 0,
        cooldownUntil: 0,
      }
      peers.set(peerId, state)
    }
    return state
  }

  function reserve(peerId, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || inFlightBytes + bytes > maxInFlightBytes) return null
    const state = peerState(peerId)
    if (!state) return null
    const reservation = { peerId, bytes, released: false }
    inFlightBytes += bytes
    state.inFlightBytes += bytes
    return reservation
  }

  function release(reservation) {
    if (!reservation || reservation.released) return
    reservation.released = true
    inFlightBytes -= reservation.bytes
    const state = peers.get(reservation.peerId)
    if (state) state.inFlightBytes -= reservation.bytes
  }

  function releaseReservations(reservations) {
    for (const reservation of Array.isArray(reservations) ? reservations : [reservations]) release(reservation)
  }

  function comparePeers(leftId, rightId) {
    const left = peerState(leftId)
    const right = peerState(rightId)
    if (!left || !right) return left ? -1 : right ? 1 : String(leftId).localeCompare(String(rightId))
    if (left.failures !== right.failures) return left.failures - right.failures
    const leftLoad = left.rttMs + (left.inFlightBytes / Math.max(left.throughputBytesPerSecond, 1)) * 1000
    const rightLoad = right.rttMs + (right.inFlightBytes / Math.max(right.throughputBytesPerSecond, 1)) * 1000
    return leftLoad - rightLoad || left.peerId.localeCompare(right.peerId)
  }

  function validateRequest(input) {
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

  async function inventoryForPeer(peerId, request, signal) {
    const claimed = new Set()
    let cursorBlock = request.startBlock
    let pages = 0
    while (cursorBlock < request.endBlock && pages < MAX_INVENTORY_PAGES_PER_PEER) {
      if (signal.aborted) throw signal.reason || abortError()
      const page = await transport.listPeerAssetRanges({
        assetId: coreRef.assetId,
        peerId,
        cursor: String(cursorBlock),
        limit: MAX_ASSET_RANGE_PAGE_RANGES,
        signal,
      })
      const windowEnd = Math.min(request.endBlock, cursorBlock + MAX_ASSET_RANGE_BITS_PER_RANGE)
      for (let index = cursorBlock; index < windowEnd; index++) {
        if (pageClaimsBlock(page, index)) claimed.add(index)
      }
      cursorBlock += MAX_ASSET_RANGE_BITS_PER_RANGE
      pages++
    }
    return claimed
  }

  function eligiblePeersForRun(run, inventories, excluded, attempted) {
    const current = now()
    return [...inventories.keys()].filter(peerId => {
      if (excluded.has(peerId) || attempted.has(peerId)) return false
      const state = peerState(peerId)
      if (!state || state.cooldownUntil > current) return false
      const coverage = inventories.get(peerId)
      for (let index = run.startBlock; index < run.endBlock; index++) {
        if (!coverage?.has(index)) return false
      }
      return true
    }).sort(comparePeers)
  }

  function recordFailure(peerId, error, requestDeadline, excluded) {
    const id = String(error?.peerId || peerId)
    const state = peerState(id)
    if (!state) return
    state.failures = Math.min(Number.MAX_SAFE_INTEGER, state.failures + 1)
    if (INVALID_PROOF_CODES.has(error?.code)) {
      state.invalidProofFailures = Math.min(Number.MAX_SAFE_INTEGER, state.invalidProofFailures + 1)
      state.cooldownUntil = Math.max(state.cooldownUntil, requestDeadline)
      excluded.add(id)
    }
  }

  async function executeAttempt(run, peerId, reservations, controller, rootSignal, inheritedRunSlot = null) {
    const forwardAbort = () => controller.abort(rootSignal.reason || abortError())
    if (rootSignal.aborted) forwardAbort()
    else rootSignal.addEventListener('abort', forwardAbort, { once: true })
    let releaseRunSlot = inheritedRunSlot
    let startedAt = null
    try {
      if (!releaseRunSlot) releaseRunSlot = await acquireRunSlot(controller.signal)
      if (controller.signal.aborted) throw controller.signal.reason || abortError()
      startedAt = now()
      peerRequests++
      const result = await transport.requestAssetBlocks({
        assetId: coreRef.assetId,
        startBlock: run.startBlock,
        endBlock: run.endBlock,
        peerIds: [peerId],
        signal: controller.signal,
      })
      const verified = new Set(result?.verifiedBlockIndexes || [])
      for (let index = run.startBlock; index < run.endBlock; index++) {
        if (!verified.has(index) || !await transport.hasVerifiedAssetBlock({ assetId: coreRef.assetId, blockIndex: index, signal: rootSignal })) {
          const error = new Error('selected peer did not produce every verified block')
          error.code = 'NO_VERIFIED_SOURCE'
          error.peerId = peerId
          throw error
        }
      }
      const elapsed = Math.max(1, now() - startedAt)
      const state = peerState(peerId)
      if (state) {
        state.rttMs = elapsed
        state.throughputBytesPerSecond = Math.max(1, Math.floor((run.bytes * 1000) / elapsed))
      }
      return { ok: true, peerId, releaseRunSlot }
    } catch (error) {
      return { ok: false, peerId, error, releaseRunSlot }
    } finally {
      rootSignal.removeEventListener?.('abort', forwardAbort)
      releaseReservations(reservations)
    }
  }

  async function fetchRun(run, context) {
    const { inventories, excluded, request, requestDeadline, rootSignal } = context
    const attempted = new Set()
    const active = new Map()
    let hedgeTimer = null
    let hedgeEvent = null
    let lastFailedPeerId = null

    const start = (peerId, reservations, inheritedRunSlot = null) => {
      attempted.add(peerId)
      const controller = new AbortController()
      let promise
      promise = executeAttempt(
        run,
        peerId,
        reservations,
        controller,
        rootSignal,
        inheritedRunSlot,
      ).then(outcome => ({ ...outcome, promise }))
      active.set(promise, { peerId, controller })
    }

    start(run.peerId, run.reservations)
    if (request.priority === 'playhead') {
      const delay = Math.max(0, Math.floor(request.deadlineMs / 3) - (now() - context.startedAt))
      hedgeEvent = new Promise(resolve => { hedgeTimer = setTimeout(() => resolve({ hedge: true }), delay) })
    }

    try {
      while (active.size > 0) {
        if (rootSignal.aborted) throw rootSignal.reason || abortError()
        const outcome = await Promise.race(hedgeEvent ? [...active.keys(), hedgeEvent] : [...active.keys()])
        if (outcome?.hedge) {
          hedgeEvent = null
          const candidate = eligiblePeersForRun(run, inventories, excluded, attempted)[0]
          if (!candidate) continue
          const reservation = reserve(candidate, run.bytes)
          if (!reservation) {
            for (const attempt of active.values()) attempt.controller.abort(abortError('playback hedge exceeded budget'))
            return unavailable('BUDGET_EXHAUSTED')
          }
          start(candidate, reservation)
          continue
        }

        active.delete(outcome.promise)
        if (outcome.ok) {
          outcome.releaseRunSlot?.()
          for (const attempt of active.values()) attempt.controller.abort(abortError('hedged playback request completed elsewhere'))
          return { status: 'ok', peerId: outcome.peerId }
        }
        lastFailedPeerId = outcome.peerId
        recordFailure(outcome.peerId, outcome.error, requestDeadline, excluded)
        if (rootSignal.aborted) {
          outcome.releaseRunSlot?.()
          throw rootSignal.reason || outcome.error
        }
        if (active.size > 0) {
          outcome.releaseRunSlot?.()
          continue
        }
        const candidate = eligiblePeersForRun(run, inventories, excluded, attempted)[0]
        if (!candidate) {
          outcome.releaseRunSlot?.()
          return { ...unavailable('NO_VERIFIED_SOURCE'), peerId: lastFailedPeerId }
        }
        const reservation = reserve(candidate, run.bytes)
        if (!reservation) {
          outcome.releaseRunSlot?.()
          return unavailable('BUDGET_EXHAUSTED')
        }
        start(candidate, reservation, outcome.releaseRunSlot)
      }
      return { ...unavailable('NO_VERIFIED_SOURCE'), peerId: lastFailedPeerId }
    } finally {
      clearTimeout(hedgeTimer)
      for (const [promise, attempt] of active) {
        attempt.controller.abort(abortError('playback run cancelled'))
        promise.then(outcome => outcome.releaseRunSlot?.(), () => {})
      }
    }
  }

  async function executeRuns(runs, context) {
    const wave = new AbortController()
    const forwardAbort = () => wave.abort(context.rootSignal.reason || abortError())
    if (context.rootSignal.aborted) forwardAbort()
    else context.rootSignal.addEventListener('abort', forwardAbort, { once: true })
    const pending = new Map()
    for (const run of runs) {
      let promise
      promise = fetchRun(run, { ...context, rootSignal: wave.signal }).then(
        outcome => ({ outcome, promise }),
        error => ({ error, promise }),
      )
      pending.set(promise, run)
    }
    const settleCancelledSiblings = async () => {
      if (pending.size === 0) return
      let timer
      const yielded = new Promise(resolve => { timer = setTimeout(resolve, 0) })
      await Promise.race([Promise.all([...pending.keys()]), yielded])
      clearTimeout(timer)
    }
    const peerIds = []
    try {
      while (pending.size > 0) {
        const completed = await Promise.race(pending.keys())
        pending.delete(completed.promise)
        if (completed.error) {
          if (context.rootSignal.aborted) throw context.rootSignal.reason || completed.error
          completed.outcome = unavailable('NO_VERIFIED_SOURCE')
        }
        if (completed.outcome.status !== 'ok') {
          wave.abort(abortError('terminal playback run cancelled its siblings'))
          for (const run of runs) releaseReservations(run.reservations)
          await settleCancelledSiblings()
          return { failed: completed.outcome, peerIds }
        }
        if (completed.outcome.peerId) peerIds.push(completed.outcome.peerId)
      }
      return { failed: null, peerIds }
    } finally {
      context.rootSignal.removeEventListener?.('abort', forwardAbort)
      if (pending.size > 0) wave.abort(abortError('playback run group completed'))
    }
  }

  async function materialize(request, signal) {
    const bytes = b4a.allocUnsafe(request.byteEnd - request.byteStart)
    let targetOffset = 0
    for (let index = request.startBlock; index < request.endBlock; index++) {
      if (signal.aborted) throw signal.reason || abortError()
      const block = await transport.readVerifiedAssetBlock({ assetId: coreRef.assetId, blockIndex: index, signal })
      const blockStartByte = index * coreRef.blockSize
      const sourceStart = Math.max(0, request.byteStart - blockStartByte)
      const sourceEnd = Math.min(block.byteLength, request.byteEnd - blockStartByte)
      if (sourceEnd <= sourceStart) continue
      b4a.copy(block, bytes, targetOffset, sourceStart, sourceEnd)
      targetOffset += sourceEnd - sourceStart
    }
    if (targetOffset !== bytes.byteLength) throw new Error('verified playback bytes did not fill the requested range')
    return bytes
  }

  /**
   * Serve one range from local Hypercore bytes or an authenticated peer.
   * There is no third branch: no origin, no CDN, no HTTP fallback. When no
   * peer can prove the range, that is the answer.
   */
  async function requestRange(input = {}) {
    const request = validateRequest(input)
    if (input.signal?.aborted) throw abortError()
    if (request.materialize && request.byteEnd - request.byteStart > maxInFlightBytes) return unavailable('BUDGET_EXHAUSTED')

    const startedAt = now()
    const requestDeadline = startedAt + request.deadlineMs
    const root = new AbortController()
    let abortKind = null
    const callerAbort = () => { abortKind = 'caller'; root.abort(abortError()) }
    input.signal?.addEventListener?.('abort', callerAbort, { once: true })
    const deadlineTimer = setTimeout(() => {
      abortKind = 'deadline'
      const error = new Error('playback range deadline exceeded')
      error.code = 'DEADLINE_EXCEEDED'
      root.abort(error)
    }, request.deadlineMs)

    const trackedPrefetch = request.priority === 'prefetch'
      ? { generation: prefetchGeneration, start: request.byteStart, end: request.byteEnd, controller: root }
      : null
    if (trackedPrefetch) activePrefetch.add(trackedPrefetch)

    try {
      const missing = []
      for (let index = request.startBlock; index < request.endBlock; index++) {
        if (root.signal.aborted) throw root.signal.reason
        if (!await transport.hasVerifiedAssetBlock({ assetId: coreRef.assetId, blockIndex: index, signal: root.signal })) missing.push(index)
      }
      if (missing.length === 0) {
        return {
          status: 'ok',
          ...(request.materialize ? { bytes: await materialize(request, root.signal) } : {}),
          verified: true,
          peerIds: [],
          originAttempted: false,
        }
      }

      let remaining = missing
      let transportBytes = 0
      for (const index of remaining) transportBytes += blockByteLength(coreRef, index)
      if (transportBytes > maxInFlightBytes) return unavailable('BUDGET_EXHAUSTED')

      const excluded = new Set()
      const contributingPeerIds = new Set()
      while (remaining.length > 0) {
        const activePeerIds = normalizePeerIds(await transport.getActiveAssetPeerIds({
          assetId: coreRef.assetId,
          signal: root.signal,
        }))
        pruneInactivePeers(activePeerIds)
        if (activePeerIds.length === 0) return unavailable('NO_VERIFIED_SOURCE')
        const inventories = new Map()
        await Promise.all(activePeerIds.map(async peerId => {
          peerState(peerId)
          try {
            inventories.set(peerId, await inventoryForPeer(peerId, request, root.signal))
          } catch (error) {
            if (root.signal.aborted) throw error
            recordFailure(peerId, error, requestDeadline, excluded)
            inventories.set(peerId, new Set())
          }
        }))

        const assignments = []
        for (const index of remaining) {
          const candidates = activePeerIds.filter(peerId => {
            const state = peerState(peerId)
            return state && !excluded.has(peerId) &&
              state.cooldownUntil <= now() && inventories.get(peerId)?.has(index)
          }).sort(comparePeers)
          if (candidates.length === 0) {
            for (const assignment of assignments) release(assignment.reservation)
            return unavailable('NO_VERIFIED_SOURCE')
          }
          const bytes = blockByteLength(coreRef, index)
          const reservation = reserve(candidates[0], bytes)
          if (!reservation) {
            for (const assignment of assignments) release(assignment.reservation)
            return unavailable('BUDGET_EXHAUSTED')
          }
          assignments.push({ index, peerId: candidates[0], bytes, reservation })
        }

        const runs = coalesceAssignments(assignments)
        const wave = await executeRuns(runs, {
          inventories,
          excluded,
          request,
          requestDeadline,
          rootSignal: root.signal,
          startedAt,
        })
        for (const peerId of wave.peerIds) contributingPeerIds.add(peerId)

        const nextRemaining = []
        for (const index of remaining) {
          if (!await transport.hasVerifiedAssetBlock({
            assetId: coreRef.assetId,
            blockIndex: index,
            signal: root.signal,
          })) nextRemaining.push(index)
        }
        const madeProgress = nextRemaining.length < remaining.length
        if (madeProgress && wave.failed?.peerId) contributingPeerIds.add(wave.failed.peerId)
        if (nextRemaining.length === 0) break
        if (!madeProgress) return wave.failed || unavailable('NO_VERIFIED_SOURCE')
        remaining = nextRemaining
      }
      const peerIds = [...contributingPeerIds].sort()
      return {
        status: 'ok',
        ...(request.materialize ? { bytes: await materialize(request, root.signal) } : {}),
        verified: true,
        peerIds,
        originAttempted: false,
      }
    } catch (error) {
      if (abortKind === 'caller' ||
          (trackedPrefetch && trackedPrefetch.generation !== prefetchGeneration) ||
          input.signal?.aborted) throw abortError()
      if (abortKind === 'deadline' || error?.code === 'DEADLINE_EXCEEDED') return unavailable('DEADLINE_EXCEEDED')
      if (error?.name === 'AbortError') throw error
      return unavailable(now() >= requestDeadline ? 'DEADLINE_EXCEEDED' : 'NO_VERIFIED_SOURCE')
    } finally {
      clearTimeout(deadlineTimer)
      input.signal?.removeEventListener?.('abort', callerAbort)
      if (trackedPrefetch) activePrefetch.delete(trackedPrefetch)
    }
  }

  function seek({ byteStart } = {}) {
    if (!Number.isSafeInteger(byteStart) || byteStart < 0 || byteStart > coreRef.byteLength) throw new Error('seek byteStart is invalid')
    prefetchGeneration++
    for (const request of [...activePrefetch]) {
      if (byteStart >= request.start && byteStart < request.end) {
        request.generation = prefetchGeneration
        continue
      }
      request.controller.abort(abortError('stale playback prefetch cancelled by seek'))
    }
  }

  function metrics() {
    return {
      peerRequests,
      inFlightBytes,
      activeTransportRuns,
      waitingTransportRuns: runSlotWaiters.length,
      peers: [...peers.values()].map(state => ({ ...state })).sort((left, right) => left.peerId.localeCompare(right.peerId)),
    }
  }

  return { coreRef, requestRange, seek, metrics }
}
