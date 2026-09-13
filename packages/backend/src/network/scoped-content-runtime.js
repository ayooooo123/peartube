import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import {
  MAX_VERIFIED_BLOCK_BYTES, MAX_VERIFIED_PROOF_BYTES, VERIFIED_BLOCK_CHUNK_BYTES,
  createVerifiedBlockProof, decodeVerifiedBlockChunk, decodeVerifiedBlockProof,
  encodeVerifiedBlockChunk, encodeVerifiedBlockProof,
} from './block-protocol.js'
import { deriveArchiveDiscoveryTopic, deriveArchiveTopic } from './topics.js'
import { verifyArchivePledge } from '../archive/pledge.js'
import { isArtworkRendition, normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import { deriveStaticAssetTopic, ASSET_BLOCK_SIZE } from '../assets/static-core.js'
import { createAssetSession } from '../assets/asset-session.js'
import { decodeApplicationEnvelope, encodeApplicationEnvelope } from '../records/application-envelope.js'
import { assessAvailability as assessAvailabilityFn } from '../assets/availability.js'

const MAX_ARCHIVE_BLOCK_BYTES = MAX_VERIFIED_BLOCK_BYTES
const MAX_ARCHIVE_PROOF_BYTES = MAX_VERIFIED_PROOF_BYTES
const MAX_ARCHIVE_CHALLENGE_PROOF_BYTES = 320 * 1024
const ARCHIVE_BLOCK_CHUNK_BYTES = VERIFIED_BLOCK_CHUNK_BYTES
const ARCHIVE_TRANSFER_TIMEOUT_MS = 10_000
const ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES = 48 * 1024
const MAX_ARCHIVE_CHALLENGE_TRANSFERS = 16
const ARCHIVE_CHALLENGE_TRANSFER_TIMEOUT_MS = 10_000
const ARCHIVE_DISCOVERY_ENVELOPE_TYPES = new Set(['archive-request', 'archive-pledge', 'archive-challenge'])
const ARCHIVE_DISCOVERY_TYPES = new Set([...ARCHIVE_DISCOVERY_ENVELOPE_TYPES, 'archive-challenge-proof'])
const ARCHIVE_PROGRESS_CURSOR_BYTES = 32
const ARCHIVE_PROGRESS_CURSOR_PATTERN = /^[0-9a-f]{64}$/

function fail (message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function assetAuthorizationId (renditionId, ownerId) {
  return `${renditionId}\0${ownerId}`
}

function mergeRangeList (left = [], right = []) {
  const byCore = new Map()
  for (const r of [...left, ...right]) {
    if (!Number.isSafeInteger(r?.start) || !Number.isSafeInteger(r?.end) || r.end <= r.start) continue
    const key = r.coreKey ? String(r.coreKey).toLowerCase() : ''
    if (!byCore.has(key)) byCore.set(key, [])
    byCore.get(key).push(r)
  }
  const mergedAll = []
  for (const [key, list] of byCore) {
    list.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged = [{ ...(key ? { coreKey: key } : {}), start: list[0].start, end: list[0].end }]
    for (let i = 1; i < list.length; i++) {
      const prev = merged[merged.length - 1]
      const cur = list[i]
      if (cur.start <= prev.end) {
        if (cur.end > prev.end) prev.end = cur.end
      } else {
        merged.push({ ...(key ? { coreKey: key } : {}), start: cur.start, end: cur.end })
      }
    }
    mergedAll.push(...merged)
  }
  return mergedAll
}

function sampleUniformCandidateBlock (totalCandidateBlocks) {
  if (!Number.isSafeInteger(totalCandidateBlocks) || totalCandidateBlocks <= 0) return 0
  if (totalCandidateBlocks === 1) return 0
  const n = BigInt(totalCandidateBlocks)
  const twoPow53 = 1n << 53n
  const limit = (twoPow53 / n) * n
  // Rejection sampling with a real exit path: retry until a value below the
  // largest multiple of n fits in the 53-bit draw. `for (;;)` keeps the loop
  // unbounded without a constant test condition.
  for (;;) {
    const buf = b4a.from(crypto.randomBytes(7))
    const val = (BigInt(buf[0] & 0x1f) << 48n) |
      (BigInt(buf[1]) << 40n) |
      (BigInt(buf[2]) << 32n) |
      (BigInt(buf[3]) << 24n) |
      (BigInt(buf[4]) << 16n) |
      (BigInt(buf[5]) << 8n) |
      BigInt(buf[6])
    if (val < limit) {
      return Number(val % n)
    }
  }
}

function newArchiveProgressToken () {
  const bytes = b4a.from(crypto.randomBytes(ARCHIVE_PROGRESS_CURSOR_BYTES))
  if (bytes.byteLength !== ARCHIVE_PROGRESS_CURSOR_BYTES) fail('archive progress cursor entropy is invalid')
  return b4a.toString(bytes, 'hex')
}

function compareArchiveResourceText (left, right) {
  const a = String(left)
  const b = String(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function compareArchiveResources (left, right) {
  return compareArchiveResourceText(left.archiveId, right.archiveId) ||
    compareArchiveResourceText(left.coreKey, right.coreKey) ||
    left.range.start - right.range.start ||
    left.range.end - right.range.end
}

function archiveResourceOrder (resources) {
  const material = resources.map(resource => [
    resource.archiveId,
    resource.coreKey,
    resource.range.start,
    resource.range.end,
  ])
  return b4a.toString(crypto.hash(b4a.from(JSON.stringify(material))), 'hex')
}

function validArchiveCursorShape (cursor) {
  return cursor != null &&
    typeof cursor.token === 'string' && ARCHIVE_PROGRESS_CURSOR_PATTERN.test(cursor.token) &&
    typeof cursor.generation === 'string' && ARCHIVE_PROGRESS_CURSOR_PATTERN.test(cursor.generation) &&
    typeof cursor.archiveId === 'string' &&
    typeof cursor.coreKey === 'string' &&
    typeof cursor.resourceId === 'string' &&
    Number.isSafeInteger(cursor.rangeStart) &&
    Number.isSafeInteger(cursor.rangeEnd) &&
    cursor.rangeEnd > cursor.rangeStart &&
    Number.isSafeInteger(cursor.rangeIndex) && cursor.rangeIndex >= 0 &&
    Number.isSafeInteger(cursor.blockIndex) &&
    cursor.blockIndex >= cursor.rangeStart && cursor.blockIndex <= cursor.rangeEnd &&
    typeof cursor.resourceOrder === 'string' &&
    ARCHIVE_PROGRESS_CURSOR_PATTERN.test(cursor.resourceOrder)
}

function sameArchiveCursor (left, right) {
  if (left == null && right == null) return true
  if (left == null || right == null) return false
  return validArchiveCursorShape(left) &&
    validArchiveCursorShape(right) &&
    left.token === right.token &&
    left.generation === right.generation &&
    left.archiveId === right.archiveId &&
    left.coreKey === right.coreKey &&
    left.resourceId === right.resourceId &&
    left.rangeStart === right.rangeStart &&
    left.rangeEnd === right.rangeEnd &&
    left.rangeIndex === right.rangeIndex &&
    left.blockIndex === right.blockIndex &&
    left.resourceOrder === right.resourceOrder
}

function cursorForArchiveResource (cursor, resource, rangeIndex, resourceOrder) {
  return {
    ...cursor,
    archiveId: resource.archiveId,
    coreKey: resource.coreKey,
    resourceId: resource.resourceId,
    rangeStart: resource.range.start,
    rangeEnd: resource.range.end,
    rangeIndex,
    resourceOrder,
  }
}

function issueArchiveProgressCursor (sweep, resource, rangeIndex, blockIndex, resourceOrder) {
  if (typeof sweep.generation !== 'string' || !ARCHIVE_PROGRESS_CURSOR_PATTERN.test(sweep.generation)) {
    sweep.generation = newArchiveProgressToken()
  }
  const cursor = {
    token: newArchiveProgressToken(),
    generation: sweep.generation,
    archiveId: resource.archiveId,
    coreKey: resource.coreKey,
    resourceId: resource.resourceId,
    rangeStart: resource.range.start,
    rangeEnd: resource.range.end,
    rangeIndex,
    blockIndex,
    resourceOrder,
  }
  sweep.expectedCursor = cursor
  return cursor.token
}

function resetOffloadSweep (sweep) {
  sweep.activeGeneration = 0
  sweep.passId = (Number(sweep.passId) || 0) + 1
  sweep.expectedCursor = null
  sweep.generation = newArchiveProgressToken()
  sweep.accumulatedResidentBlocks = 0
  sweep.accumulatedRemoteBlocks = 0
  sweep.accumulatedResidentBytes = 0
  sweep.accumulatedRemoteBytes = 0
  sweep.accumulatedAssessedBlocks = 0
  sweep.coveredThrough = null
  sweep.verifiedRanges = []
}

function createArchiveProgressSweep () {
  return {
    expectedCursor: null,
    generation: null,
  }
}

function resetArchiveProgressSweep (sweep) {
  sweep.expectedCursor = null
  sweep.generation = newArchiveProgressToken()
}

function emptyRetrievabilityPage () {
  return {
    residentBlocks: 0,
    remoteRetrievableBlocks: 0,
    residentBytes: 0,
    remoteRetrievableBytes: 0,
    assessedBlocks: 0,
    requestedBlocks: 0,
    residentRanges: [],
    remoteRetrievableRanges: [],
    unavailableRanges: [],
    truncated: false,
    aborted: false,
    nextCursor: null,
    isLocallyResident: false,
    isRetrievable: false,
    assessmentPending: false,
  }
}

function calculateInitialRequestedBlocks (ranges) {
  if (!Array.isArray(ranges)) return 0
  return ranges.reduce((sum, r) => sum + Math.max(0, (Number(r?.end) || 0) - (Number(r?.start) || 0)), 0)
}

function accumulateRetrievabilityPage (acc, page) {
  acc.assessedBlocks += Number(page.assessedBlocks) || 0
  acc.residentBlocks += Number(page.residentBlocks) || 0
  acc.remoteRetrievableBlocks += Number(page.remoteRetrievableBlocks) || 0
  acc.residentBytes += Number(page.residentBytes) || 0
  acc.remoteRetrievableBytes += Number(page.remoteRetrievableBytes) || 0
  if (Number.isSafeInteger(page.requestedBlocks) && page.requestedBlocks > 0) {
    acc.requestedBlocks = page.requestedBlocks
  }
  acc.residentRanges = mergeRangeList(acc.residentRanges, page.residentRanges || [])
  acc.remoteRetrievableRanges = mergeRangeList(acc.remoteRetrievableRanges, page.remoteRetrievableRanges || [])
  acc.unavailableRanges = mergeRangeList(acc.unavailableRanges, page.unavailableRanges || [])
}

function finalizeRetrievabilitySummary (acc) {
  acc.truncated = false
  acc.nextCursor = null
  acc.assessmentPending = false
  acc.aborted = false
  const covered = acc.requestedBlocks > 0 && acc.assessedBlocks === acc.requestedBlocks
  acc.isLocallyResident = covered && acc.residentBlocks === acc.requestedBlocks
  acc.isRetrievable = covered && (acc.residentBlocks + acc.remoteRetrievableBlocks) === acc.requestedBlocks
}


function markRetrievabilityAborted (acc, page = null) {
  acc.aborted = true
  acc.truncated = true
  acc.assessmentPending = true
  if (page) {
    acc.success = page.success
    acc.error = page.error
  }
}

function applyRetrievabilityPageOutcome (acc, page, followContinuations) {
  if (page.aborted === true) {
    acc.aborted = true
    acc.truncated = true
    acc.nextCursor = page.nextCursor || null
    acc.assessmentPending = true
    return { done: true, nextCursor: null }
  }
  if (page.truncated === true && page.nextCursor) {
    acc.truncated = true
    acc.nextCursor = page.nextCursor
    acc.assessmentPending = true
    return {
      done: followContinuations !== true,
      nextCursor: page.nextCursor,
    }
  }
  finalizeRetrievabilitySummary(acc)
  return { done: true, nextCursor: null }
}

async function collectRetrievabilityAssessment (assess, input = {}) {
  const {
    core = null,
    ranges = [],
    signal = null,
    maxBlocks = 2048,
    followContinuations = true,
    cursor = null,
  } = input
  if (typeof assess !== 'function') {
    const empty = emptyRetrievabilityPage()
    markRetrievabilityAborted(empty)
    return empty
  }

  let pageCursor = cursor
  const acc = emptyRetrievabilityPage()
  acc.requestedBlocks = calculateInitialRequestedBlocks(ranges)

  for (;;) {
    if (signal?.aborted) {
      markRetrievabilityAborted(acc)
      break
    }
    let page = null
    try {
      page = await assess({
        core,
        ranges,
        cursor: pageCursor,
        signal,
        maxBlocks,
      })
    } catch {
      page = null
    }
    if (!page || page.success === false) {
      markRetrievabilityAborted(acc, page)
      break
    }

    accumulateRetrievabilityPage(acc, page)
    const outcome = applyRetrievabilityPageOutcome(acc, page, followContinuations)
    if (outcome.done) break
    pageCursor = outcome.nextCursor
  }

  return acc
}


export function createScopedContentRuntime (context) {
  const {
    options, store, authorizePublication, authorizeConsumerWork, protocolMajor, networkId,
    assetTransferTimeoutMs, counters, renditions, archives, blockEngine,
    normalizeRetentionClass, reservePolicyUpload,
    findScope, joinScope, leaveScope, closeSession, sendScopedFrame,
    cleanupResource, stableScopeDiagnostic, safeRange, hex32, policy,
  } = context
  const blockOffload = options.blockOffload || null
  const availabilityEvidenceStore = options.availabilityEvidenceStore || null

  async function authorizedBlockProof (core, index) {
    return createVerifiedBlockProof({
      manifest: core.manifest,
      proof: blockIndex => core.proof({
        block: { index: blockIndex, nodes: 0 },
        upgrade: { start: 0, length: core.length },
      }),
    }, index)
  }

  function encodeBlockProof (index, proof, value) {
    return encodeVerifiedBlockProof({ index, proof, value })
  }

  function decodeBlockProof (payload, expectedIndex) {
    return decodeVerifiedBlockProof(payload, { index: expectedIndex })
  }

  function encodeBlockChunk (index, offset, value) {
    return encodeVerifiedBlockChunk({ index, offset, value })
  }

  const decodeBlockChunk = decodeVerifiedBlockChunk













  function archiveBlockKey (coreKey, index) {
    return `${coreKey}:${index}`
  }

  function archiveResourceFor (scope, coreKey, index) {
    return [...(scope.archiveResources?.values() || [])].find(resource =>
      resource.quarantined !== true &&
      resource.coreKey === coreKey &&
      Number.isSafeInteger(index) &&
      index >= resource.range.start &&
      index < resource.range.end
    ) || null
  }

  function encodeArchiveBlockRef (coreKey, index) {
    const payload = c.encode(c.any, { coreKey: hex32(coreKey, 'coreKey'), index })
    if (payload.byteLength > 256) fail('archive block reference exceeds bounded limit')
    return payload
  }

  function decodeArchiveBlockRef (payload) {
    if (!b4a.isBuffer(payload) || payload.byteLength > 256) fail('archive block reference is invalid')
    const value = c.decode(c.any, payload)
    const index = Number(value?.index)
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
      fail('archive block index is out of bounds')
    }
    return { coreKey: hex32(value?.coreKey, 'coreKey'), index }
  }

  function encodeArchiveProof (coreKey, index, proof, value) {
    const metadata = c.decode(c.any, encodeBlockProof(index, proof, value))
    metadata.coreKey = hex32(coreKey, 'coreKey')
    const payload = c.encode(c.any, metadata)
    if (payload.byteLength > MAX_ARCHIVE_PROOF_BYTES) fail('archive proof exceeds bounded limit')
    return payload
  }

  function decodeArchiveProof (payload, expected) {
    if (!b4a.isBuffer(payload) || payload.byteLength > MAX_ARCHIVE_PROOF_BYTES) fail('archive proof exceeds bounded limit')
    const metadata = c.decode(c.any, payload)
    if (hex32(metadata?.coreKey, 'coreKey') !== expected.coreKey) fail('archive proof core is invalid')
    const blockMetadata = { ...metadata }
    delete blockMetadata.coreKey
    return decodeBlockProof(c.encode(c.any, blockMetadata), expected.index)
  }

  function clearArchiveTimer (tracked) {
    if (!tracked?.archiveTimer) return
    clearTimeout(tracked.archiveTimer)
    tracked.archiveTimer = null
  }

  function queueArchiveRetry (scope, tracked, request) {
    if (!request) return
    const resource = archiveResourceFor(scope, request.coreKey, request.index)
    const key = archiveBlockKey(request.coreKey, request.index)
    scope.archivePending.delete(key)
    if (resource) {
      const failures = scope.archiveFailures.get(key) || new Set()
      failures.add(tracked.peerId)
      scope.archiveFailures.set(key, failures)
      scope.archiveRetries.set(key, request)
    }
    tracked.archiveTransfer?.close?.('archive-retry')
    tracked.archiveRequest = null
    tracked.archiveTransfer = null
    clearArchiveTimer(tracked)
  }

  async function nextArchiveBlock (scope, tracked) {
    for (const [key, request] of scope.archiveRetries) {
      if (scope.archivePending.has(key)) continue
      if (scope.archiveFailures.get(key)?.has(tracked.peerId)) return null
      scope.archiveRetries.delete(key)
      return request
    }
    for (const resource of scope.archiveResources?.values() || []) {
      while (resource.nextIndex < resource.range.end) {
        const index = resource.nextIndex++
        const key = archiveBlockKey(resource.coreKey, index)
        if (scope.archivePending.has(key)) continue
        if (await resource.core.has?.(index)) continue
        return { coreKey: resource.coreKey, index }
      }
    }
    return null
  }

  async function pumpArchiveSession (scope, tracked) {
    if (!policy.networkEnabled || scope.archiveDiscovery || scope.closed || tracked.closed || tracked.state !== 'active') return
    // Claim the pump synchronously so one peer never receives overlapping monotonic requests.
    if (tracked.archivePumping) {
      tracked.archivePumpQueued = true
      return
    }
    tracked.archivePumping = true
    try {
      do {
        tracked.archivePumpQueued = false
        if (tracked.archiveRequest || scope.closed || tracked.closed || tracked.state !== 'active') break
        const request = await nextArchiveBlock(scope, tracked)
        if (!request || scope.closed || tracked.closed) break
        tracked.archiveRequest = request
        scope.archivePending.add(archiveBlockKey(request.coreKey, request.index))
        if (!sendScopedFrame(tracked, 'archive', 'archive-block-request', encodeArchiveBlockRef(request.coreKey, request.index))) {
          queueArchiveRetry(scope, tracked, request)
          break
        }
        // Re-entrant answers clear the request before its timeout is armed.
        if (tracked.archiveRequest !== request) continue
        tracked.archiveTimer = setTimeout(() => {
          queueArchiveRetry(scope, tracked, request)
          void pumpArchiveSessions(scope)
        }, ARCHIVE_TRANSFER_TIMEOUT_MS)
      } while (tracked.archivePumpQueued)
    } finally {
      tracked.archivePumping = false
    }
  }

  function startArchivePumpWhenOpen (scope, tracked) {
    const opened = tracked.channel?.fullyOpened?.()
    void Promise.resolve(opened === undefined ? true : opened).then(ready => {
      if (ready !== false) return pumpArchiveSession(scope, tracked)
    }).catch(() => closeSession(scope, tracked.peerId, 'archive-channel-open-failed', tracked))
  }
  async function pumpArchiveSessions (scope) {
    if (!scope || scope.closed || scope.purpose !== 'archive') return
    await Promise.all([...scope.sessions.values()].map(tracked => pumpArchiveSession(scope, tracked)))
  }

  function validateArchiveBlockRequest (scope, tracked, request) {
    if (!policy.archiveAllowed) return null
    const resource = archiveResourceFor(scope, request.coreKey, request.index)
    const lastServed = tracked.archiveLastServed.get(resource?.resourceId) ?? -1
    if (tracked.archiveServing || !resource || request.index <= lastServed) {
      fail('archive block request is outside the authorized monotonic range')
    }
    return resource
  }

  async function prepareArchiveBlockUpload (resource, request, ceiling, servedBytes, policyEpoch) {
    if (!policy.archiveAllowed || !policy.uploadAllowed || !policy.networkEnabled || !await resource.core.has?.(request.index)) {
      return null
    }
    const proof = await authorizedBlockProof(resource.core, request.index)
    const value = b4a.from(proof?.block?.value || [])
    const reservation = policyEpoch === policy.epoch
      ? await reservePolicyUpload('archive-pin', value.byteLength)
      : null
    if (!reservation || policyEpoch !== policy.epoch ||
        proof?.block?.index !== request.index || value.byteLength > MAX_ARCHIVE_BLOCK_BYTES ||
        servedBytes + value.byteLength > ceiling) {
      reservation?.release()
      return null
    }
    return { proof, value, reservation }
  }

  function transmitArchiveBlockData (scope, tracked, resource, request, proof, value, reservation, policyEpoch) {
    const canBatch = typeof tracked.channel?.cork === 'function' && typeof tracked.channel?.uncork === 'function'
    if (canBatch) tracked.channel.cork()
    let sent = false
    try {
      sent = sendScopedFrame(tracked, 'archive', 'archive-block-proof', encodeArchiveProof(request.coreKey, request.index, proof, value))
      for (let offset = 0; sent && offset < value.byteLength; offset += ARCHIVE_BLOCK_CHUNK_BYTES) {
        if (!policy.archiveAllowed || policyEpoch !== policy.epoch || scope.closed || tracked.closed) {
          sent = false
          break
        }
        const chunk = value.subarray(offset, Math.min(value.byteLength, offset + ARCHIVE_BLOCK_CHUNK_BYTES))
        sent = sendScopedFrame(tracked, 'archive', 'archive-block-chunk', encodeBlockChunk(request.index, offset, chunk))
      }
      if (sent) {
        tracked.archiveServedBytes += value.byteLength
        tracked.archiveLastServed.set(resource.resourceId, request.index)
        reservation.commit()
      }
    } finally {
      reservation.release()
      if (canBatch) tracked.channel.uncork()
    }
  }

  async function sendArchiveBlock (scope, tracked, request) {
    const resource = validateArchiveBlockRequest(scope, tracked, request)
    if (!resource) {
      sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
      return
    }
    tracked.archiveServing = true
    const policyEpoch = policy.epoch
    try {
      const prepared = await prepareArchiveBlockUpload(
        resource,
        request,
        scope.archiveUploadCeilingBytes,
        tracked.archiveServedBytes,
        policyEpoch,
      )
      if (!prepared) {
        sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
        return
      }
      transmitArchiveBlockData(scope, tracked, resource, request, prepared.proof, prepared.value, prepared.reservation, policyEpoch)
    } finally {
      tracked.archiveServing = false
    }
  }

  async function finishArchiveTransfer (scope, tracked) {
    const request = tracked.archiveRequest
    const transfer = tracked.archiveTransfer
    const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
    if (!resource || !transfer) fail('archive block transfer is incomplete')
    const result = await blockEngine.finish({
      handle: resource.blockHandle,
      request,
      transfer,
      proof: transfer.proofMetadata.proof,
    })
    if (result.status === 'ignored') {
      queueArchiveRetry(scope, tracked, request)
      await pumpArchiveSessions(scope)
      return
    }
    const key = archiveBlockKey(request.coreKey, request.index)
    scope.archivePending.delete(key)
    scope.archiveRetries.delete(key)
    scope.archiveFailures.delete(key)
    tracked.archiveRequest = null
    tracked.archiveTransfer = null
    clearArchiveTimer(tracked)
    await pumpArchiveSession(scope, tracked)
  }
  function clearArchiveChallengeProofTransfer(scope, key) {
    const transfer = scope.archiveChallengeProofTransfers?.get(key)
    if (!transfer) return
    clearTimeout(transfer.timer)
    scope.archiveChallengeProofTransfers.delete(key)
  }

  function decodeArchiveChallengeProofPacket (payload) {
    const packet = c.decode(c.any, payload)
    const envelopeBytes = b4a.from(packet?.envelope || [])
    const chunk = b4a.from(packet?.chunk || [])
    const offset = Number(packet?.offset)
    const totalBytes = Number(packet?.totalBytes)
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES ||
        chunk.byteLength < 1 || chunk.byteLength > ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES ||
        offset + chunk.byteLength > totalBytes) {
      fail('archive challenge proof chunk is invalid')
    }
    const envelope = decodeApplicationEnvelope(envelopeBytes)
    return { envelope, chunk, offset, totalBytes }
  }

  function initializeArchiveChallengeTransfer (scope, key, envelope, totalBytes) {
    clearArchiveChallengeProofTransfer(scope, key)
    if (scope.archiveChallengeProofTransfers.size >= MAX_ARCHIVE_CHALLENGE_TRANSFERS) {
      fail('archive challenge proof transfer limit exceeded')
    }
    const transfer = {
      envelope,
      totalBytes,
      chunks: [],
      receivedBytes: 0,
      timer: setTimeout(() => clearArchiveChallengeProofTransfer(scope, key), ARCHIVE_CHALLENGE_TRANSFER_TIMEOUT_MS),
    }
    transfer.timer?.unref?.()
    scope.archiveChallengeProofTransfers.set(key, transfer)
    return transfer
  }

  async function receiveArchiveChallengeProofChunk(scope, tracked, payload) {
    const { envelope, chunk, offset, totalBytes } = decodeArchiveChallengeProofPacket(payload)
    const transferId = b4a.toString(envelope.recordId, 'hex')
    const key = `${tracked.peerId}:${transferId}`
    let transfer = scope.archiveChallengeProofTransfers.get(key)
    if (offset === 0) {
      transfer = initializeArchiveChallengeTransfer(scope, key, envelope, totalBytes)
    }
    if (!transfer || transfer.totalBytes !== totalBytes || transfer.receivedBytes !== offset ||
        !b4a.equals(transfer.envelope.recordId, envelope.recordId)) {
      clearArchiveChallengeProofTransfer(scope, key)
      fail('archive challenge proof chunks are not contiguous')
    }
    transfer.chunks.push(chunk)
    transfer.receivedBytes += chunk.byteLength
    if (transfer.receivedBytes !== transfer.totalBytes) return
    const proofBytes = b4a.concat(transfer.chunks, transfer.totalBytes)
    clearArchiveChallengeProofTransfer(scope, key)
    await Promise.allSettled([...scope.archiveChallengeProofListeners].map(listener =>
      listener({ envelope: transfer.envelope, proofBytes }, { peerId: tracked.peerId })))
  }


  async function handleArchiveDiscoveryFrame (scope, tracked, frame) {
    if (!ARCHIVE_DISCOVERY_TYPES.has(frame.type)) fail('frame type is not allowed for archive discovery')
    if (frame.type === 'archive-challenge-proof') {
      await receiveArchiveChallengeProofChunk(scope, tracked, frame.payload)
    } else {
      const envelope = decodeApplicationEnvelope(frame.payload)
      const listeners = frame.type === 'archive-request'
        ? scope.archiveRequestListeners
        : frame.type === 'archive-pledge'
          ? scope.archivePledgeListeners
          : scope.archiveChallengeListeners
      await Promise.allSettled([...listeners].map(listener => listener(envelope, { peerId: tracked.peerId })))
    }
    counters.acceptedFrames++
    return { status: 'accepted' }
  }

  async function handleArchiveBlockProofFrame (scope, tracked, payload) {
    const request = tracked.archiveRequest
    const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
    if (!resource || tracked.archiveTransfer) fail('unexpected archive proof')
    const metadata = decodeArchiveProof(payload, request)
    const canonicalResourceId = resource.blockHandle.source.resourceId
    const transfer = blockEngine.createTransfer({
      handle: resource.blockHandle,
      resourceId: canonicalResourceId,
      start: resource.range.start,
      end: resource.range.end,
      index: request.index,
      peerId: tracked.peerId,
      transferId: archiveBlockKey(request.coreKey, request.index),
    })
    const received = blockEngine.receiveProofPart({
      handle: resource.blockHandle,
      transfer,
      part: {
        resourceId: resource.blockHandle.source.resourceId,
        start: resource.range.start,
        end: resource.range.end,
        index: request.index,
        offset: 0,
        totalBytes: payload.byteLength,
        chunk: payload,
      },
    })
    if (received.status !== 'complete') fail('archive proof transfer is incomplete')
    transfer.proofMetadata = metadata
    transfer.expectedBlockBytes = metadata.byteLength
    tracked.archiveTransfer = transfer
    if (metadata.byteLength === 0) await finishArchiveTransfer(scope, tracked)
    return { status: 'accepted' }
  }

  async function handleArchiveBlockChunkFrame (scope, tracked, payload) {
    const request = tracked.archiveRequest
    const transfer = tracked.archiveTransfer
    const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
    if (!resource || !transfer) fail('unexpected archive block chunk')
    const chunk = decodeBlockChunk(payload)
    if (chunk.index !== request.index) fail('archive block chunk is out of sequence')
    const received = blockEngine.receiveBlockPart({
      handle: resource.blockHandle,
      transfer,
      part: {
        resourceId: resource.blockHandle.source.resourceId,
        start: resource.range.start,
        end: resource.range.end,
        index: request.index,
        offset: chunk.offset,
        totalBytes: transfer.expectedBlockBytes,
        chunk: chunk.value,
      },
    })
    if (received.status === 'complete') await finishArchiveTransfer(scope, tracked)
    return { status: 'accepted' }
  }

  async function handleArchiveFrame (scope, tracked, frame) {
    if (!tracked || tracked.closed || tracked.state !== 'active') fail('archive session is not active')
    if (scope.archiveDiscovery) return await handleArchiveDiscoveryFrame(scope, tracked, frame)
    switch (frame.type) {
      case 'probe':
        return { status: 'ok' }
      case 'archive-block-request':
        await sendArchiveBlock(scope, tracked, decodeArchiveBlockRef(frame.payload))
        return { status: 'sent' }
      case 'archive-block-proof':
        return await handleArchiveBlockProofFrame(scope, tracked, frame.payload)
      case 'archive-block-chunk':
        return await handleArchiveBlockChunkFrame(scope, tracked, frame.payload)
      case 'archive-block-unavailable': {
        const request = decodeArchiveBlockRef(frame.payload)
        if (!tracked.archiveRequest || request.coreKey !== tracked.archiveRequest.coreKey || request.index !== tracked.archiveRequest.index) {
          fail('unexpected unavailable archive block')
        }
        queueArchiveRetry(scope, tracked, request)
        await pumpArchiveSessions(scope)
        return { status: 'unavailable' }
      }
      default:
        fail('frame type is not allowed for archive purpose')
    }
  }

  // Artwork retention is best effort and must never fail the requested media.
  async function retainPublicationArtwork({ manifest, entityRef, publicationId }) {
    for (const candidate of manifest?.body?.renditions || []) {
      if (!isArtworkRendition(candidate) || candidate.blocked || candidate.superseded) continue
      if (renditions.has(String(candidate.renditionId))) continue
      try {
        await retainAuthorizedRendition({
          manifest,
          renditionId: candidate.renditionId,
          entityRef,
          publicationId,
        })
      } catch (error) {
        // A missing cover must remain visible in diagnostics.
        console.log('[ScopedNetwork] cover not retained:', String(candidate.renditionId).slice(0, 12), error?.message)
      }
    }
  }

  function isUploadOrArtworkProvenance (candidate, renditionId, coreKey) {
    return (candidate?.type === 'upload' || candidate?.type === 'artwork') &&
      candidate.renditionId === renditionId &&
      candidate.coreKey === coreKey &&
      Number.isSafeInteger(candidate.start) &&
      Number.isSafeInteger(candidate.end) &&
      candidate.start >= 0 &&
      candidate.end > candidate.start
  }

  function resolveAuthorizedRenditionIdentity (manifest, renditionId, requestedOwnerId) {
    const id = String(renditionId || '')
    const ownerId = String(requestedOwnerId || manifest?.publicationId || id)
    if (!ownerId) fail('retention owner is required')
    const rendition = (manifest?.body?.renditions || []).find(candidate => candidate.renditionId === id)
    if (!rendition || rendition.blocked || rendition.superseded) fail('rendition is not manifest-authorized')
    const coreRef = normalizeAssetCoreRefV2(rendition.core)
    const declaredLength = coreRef.length
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) fail('rendition core length is invalid')
    return { id, ownerId, rendition, coreRef, declaredLength, coreKey: coreRef.key }
  }

  function resolveAuthorizedRenditionRange (manifest, id, coreKey, declaredLength, start, end) {
    const uploadProvenance = (manifest?.body?.provenance || []).filter(candidate =>
      isUploadOrArtworkProvenance(candidate, id, coreKey)
    )
    const soleUpload = uploadProvenance.length === 1 ? uploadProvenance[0] : null
    const defaultStart = soleUpload ? soleUpload.start : 0
    const defaultEnd = soleUpload ? soleUpload.end : declaredLength
    const range = safeRange(
      start === 0 && end === null ? defaultStart : start,
      end === null ? defaultEnd : end,
    )
    if (range.end > declaredLength) fail('rendition range exceeds the manifest core length')
    return range
  }

  async function resolveAuthorizedRenditionTarget ({
    manifest,
    renditionId,
    requestedOwnerId,
    start,
    end,
    entityRef,
    publicationId,
    throwIfAborted,
  }) {
    if (policy.status !== 'active') fail('runtime is not active')
    const consumerVisible = await authorizeConsumerWork({
      operation: 'asset-retain',
      entityRef,
      publicationId: publicationId || manifest?.publicationId || null,
      renditionId,
    })
    throwIfAborted()
    if (!consumerVisible) fail('consumer media is not visible under local policy', 'CONSUMER_MEDIA_NOT_VISIBLE')

    const { id, ownerId, coreRef, declaredLength, coreKey } = resolveAuthorizedRenditionIdentity(
      manifest,
      renditionId,
      requestedOwnerId,
    )
    const range = resolveAuthorizedRenditionRange(manifest, id, coreKey, declaredLength, start, end)
    const verified = await authorizePublication({ manifest, renditionId: id, start: range.start, end: range.end })
    throwIfAborted()
    if (!verified) fail('publication manifest authorization failed')
    return { id, ownerId, coreRef, coreKey, range }
  }


  function attachRenditionToExistingEntry ({ existing, id, ownerId, coreRef, coreKey, range, retentionClass, manifest }) {
    if (existing.scope.coreKey !== coreKey ||
        range.start < existing.scope.range.start ||
        range.end > existing.scope.range.end) {
      fail('rendition is already retained with a different authorization')
    }
    const existingOwner = existing.owners.get(ownerId)
    if (existingOwner) {
      if (existingOwner.range.start !== range.start || existingOwner.range.end !== range.end) {
        fail('retention owner already has a different authorization range')
      }
      existing.scope.retentionClasses ??= new Set()
      existing.scope.retentionClasses.add(retentionClass)
      return { ...existing.result, ownerId, range: { ...range }, status: 'already-retained' }
    }
    const mode = `retained:${id}:${ownerId}`
    joinScope({
      purpose: 'asset',
      topic: existing.scope.topic,
      scopeId: coreRef.assetId,
      mode,
    })
    existing.scope.retentionClasses ??= new Set()
    existing.scope.retentionClasses.add(retentionClass)
    existing.scope.assetAuthorizations.set(
      assetAuthorizationId(id, ownerId),
      { manifest, renditionId: id, range: { ...range } },
    )
    existing.owners.set(ownerId, { mode, manifest, range: { ...range } })
    return { ...existing.result, ownerId, range: { ...range }, status: 'retained' }
  }

  async function createAndJoinAssetScope ({
    coreRef,
    coreKey,
    topic,
    mode,
    range,
    retentionClass,
    manifest,
    entityRef,
    publicationId,
    id,
    ownerId,
    throwIfAborted,
  }) {
    if (!store?.get) fail('corestore is unavailable')
    let assetSession = null
    let scope = null
    try {
      assetSession = createAssetSession({
        coreRef,
        store,
        startBlock: range.start,
        endBlock: range.end,
      })
      await assetSession.ready()
      throwIfAborted()
      ;({ scope } = joinScope({
        purpose: 'asset',
        topic,
        scopeId: coreRef.assetId,
        mode,
        assetId: coreRef.assetId,
        coreKey,
        range,
        assetSession,
        retentionClasses: new Set([retentionClass]),
        entityRef,
        publicationId: publicationId || manifest?.publicationId || null,
        assetAuthorizations: new Map([[
          assetAuthorizationId(id, ownerId),
          { manifest, renditionId: id, range: { ...range } },
        ]]),
      }))
      return scope
    } catch (error) {
      try { await assetSession?.close?.() } catch { /* best-effort failed-session close */ }
      throw error
    }
  }

  async function retainAuthorizedRendition ({
    manifest,
    renditionId,
    ownerId: requestedOwnerId,
    retentionClass: requestedRetentionClass,
    start = 0,
    end = null,
    entityRef = null,
    publicationId = null,
    retainArtwork = true,
    signal = null,
  } = {}) {
    const retentionClass = normalizeRetentionClass(requestedRetentionClass)
    const throwIfAborted = () => {
      if (signal?.aborted) fail('rendition retention aborted', 'ABORTED')
    }
    throwIfAborted()
    const target = await resolveAuthorizedRenditionTarget({
      manifest,
      renditionId,
      requestedOwnerId,
      start,
      end,
      entityRef,
      publicationId,
      throwIfAborted,
    })
    const { id, ownerId, coreRef, coreKey, range } = target

    const existing = renditions.get(id)
    if (existing) {
      return attachRenditionToExistingEntry({ existing, id, ownerId, coreRef, coreKey, range, retentionClass, manifest })
    }

    const topic = deriveStaticAssetTopic(coreRef.assetId)
    const sharedScope = findScope('asset', topic)
    if (sharedScope && (
      sharedScope.coreKey !== coreKey ||
      range.start < sharedScope.range.start ||
      range.end > sharedScope.range.end
    )) {
      fail('static asset is already retained with a different authorization range')
    }
    const mode = `retained:${id}:${ownerId}`
    let scope = sharedScope
    if (scope) {
      joinScope({ purpose: 'asset', topic, scopeId: coreRef.assetId, mode })
      scope.retentionClasses ??= new Set()
      scope.retentionClasses.add(retentionClass)
      scope.assetAuthorizations.set(
        assetAuthorizationId(id, ownerId),
        { manifest, renditionId: id, range: { ...range } },
      )
    } else {
      scope = await createAndJoinAssetScope({
        coreRef,
        coreKey,
        topic,
        mode,
        range,
        retentionClass,
        manifest,
        entityRef,
        publicationId,
        id,
        ownerId,
        throwIfAborted,
      })
    }
    const result = {
      status: 'retained',
      ownerId,
      renditionId: id,
      assetId: coreRef.assetId,
      coreKey,
      range: { ...range },
      topic: stableScopeDiagnostic(scope),
    }
    renditions.set(id, {
      scope,
      result,
      range: { ...range },
      owners: new Map([[ownerId, { mode, manifest, range: { ...range } }]]),
    })
    if (retainArtwork) await retainPublicationArtwork({ manifest, entityRef, publicationId })
    return result
  }

  function releaseUnretainedRendition (id, requestedOwnerId, assetId) {
    const scope = assetId ? findScope('asset', deriveStaticAssetTopic(assetId)) : null
    const remainingOwners = scope?.assetAuthorizations?.size || 0
    return {
      status: 'released',
      renditionId: id,
      ownerId: requestedOwnerId || null,
      assetId,
      released: false,
      remainingOwners,
      scopeQuiescent: remainingOwners === 0,
    }
  }

  function checkDependentOwnerRevocation (retained, id, requestedOwnerIds) {
    const requestedAuthorizationIds = new Set([...requestedOwnerIds].map(ownerId =>
      assetAuthorizationId(id, ownerId)))
    const remainingAuthorizations = [...(retained.scope.assetAuthorizations?.entries() || [])]
      .filter(([authorizationId]) => !requestedAuthorizationIds.has(authorizationId))
    const scopeRangeStillOwned = remainingAuthorizations.some(([, authorization]) =>
      authorization.range.start === retained.scope.range.start &&
      authorization.range.end === retained.scope.range.end)
    return remainingAuthorizations.length > 0 && !scopeRangeStillOwned
  }

  function purgeRenditionOwners (retained, id, requestedOwnerIds, revokeDependentOwners) {
    let released = false
    for (const [retainedId, value] of [...renditions]) {
      if (value.scope !== retained.scope) continue
      for (const [ownerId, owner] of [...value.owners]) {
        if (!revokeDependentOwners && (retainedId !== id || !requestedOwnerIds.has(ownerId))) continue
        value.owners.delete(ownerId)
        retained.scope.assetAuthorizations?.delete(assetAuthorizationId(retainedId, ownerId))
        retained.scope.modes.delete(owner.mode)
        if (retainedId === id && requestedOwnerIds.has(ownerId)) released = true
      }
      if (value.owners.size === 0) renditions.delete(retainedId)
    }
    return released
  }

  async function releaseAuthorizedRendition ({
    renditionId,
    ownerId: requestedOwnerId,
    assetId: requestedAssetId,
    preserveDependentOwners = false,
  } = {}) {
    const id = String(renditionId || '')
    const assetId = requestedAssetId === undefined
      ? null
      : hex32(requestedAssetId, 'assetId')
    const retained = renditions.get(id)
    if (!retained) return releaseUnretainedRendition(id, requestedOwnerId, assetId)
    if (assetId && retained.scope.assetId !== assetId) {
      fail('retained rendition asset identity mismatch')
    }
    const requestedOwnerIds = requestedOwnerId === undefined
      ? new Set(retained.owners.keys())
      : new Set([String(requestedOwnerId)])
    const revokeDependentOwners = checkDependentOwnerRevocation(retained, id, requestedOwnerIds)
    if (preserveDependentOwners && revokeDependentOwners) {
      return {
        status: 'retained',
        renditionId: id,
        ownerId: requestedOwnerId === undefined ? null : String(requestedOwnerId),
        assetId: retained.scope.assetId,
        released: false,
        blockedByDependentOwners: true,
        remainingOwners: retained.scope.assetAuthorizations.size,
        scopeQuiescent: false,
      }
    }
    const released = purgeRenditionOwners(retained, id, requestedOwnerIds, revokeDependentOwners)
    await leaveScope(retained.scope)
    const remainingOwners = retained.scope.assetAuthorizations?.size || 0
    return {
      status: 'released',
      renditionId: id,
      ownerId: requestedOwnerId === undefined ? null : String(requestedOwnerId),
      assetId: retained.scope.assetId,
      released,
      remainingOwners,
      scopeQuiescent: remainingOwners === 0,
    }
  }
  function activeAssetScope (assetId) {
    const id = hex32(assetId, 'assetId')
    const scope = findScope('asset', deriveStaticAssetTopic(id))
    if (!scope || scope.closed || scope.assetId !== id || !scope.assetSession) {
      fail('asset scope is not active')
    }
    return scope
  }




  function getActiveAssetSession ({ assetId } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    const scope = activeAssetScope(assetId)
    const session = scope.assetSession
    if (session.assetId !== scope.assetId ||
        session.coreRef?.assetId !== scope.assetId) {
      fail('active asset session identity mismatch')
    }
    return session
  }














  async function revalidateRetainedRenditions () {
    let released = 0
    for (const [renditionId, retained] of [...renditions]) {
      for (const [ownerId, owner] of [...retained.owners]) {
        const authorized = await authorizePublication({
          manifest: owner.manifest,
          renditionId,
          start: owner.range.start,
          end: owner.range.end,
        }).catch(() => false)
        const consumerVisible = authorized && await authorizeConsumerWork({
          operation: 'asset-revalidate',
          entityRef: retained.scope.entityRef,
          publicationId: retained.scope.publicationId || owner.manifest?.publicationId || null,
          renditionId,
        }).catch(() => false)
        if (consumerVisible) continue
        await releaseAuthorizedRendition({ renditionId, ownerId })
        released++
      }
    }
    return { released }
  }

  async function retainArchiveDiscovery ({ onRequest, onPledge, onChallenge, onChallengeProof, onPeer } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    for (const [name, listener] of Object.entries({ onRequest, onPledge, onChallenge, onChallengeProof })) {
      if (listener !== undefined && typeof listener !== 'function') fail(`${name} must be a function`)
    }
    const topic = deriveArchiveDiscoveryTopic({ protocolMajor, networkId })
    const { scope } = joinScope({
      purpose: 'archive-discovery',
      topic,
      scopeId: networkId,
      mode: 'discovery',
      archiveDiscovery: true,
      archiveRequestListeners: new Set(),
      archivePledgeListeners: new Set(),
      archiveChallengeListeners: new Set(),
      archiveChallengeProofListeners: new Set(),
      archiveChallengeProofTransfers: new Map(),
    })
    if (!scope.archiveDiscovery) fail('archive discovery topic collided with a custody scope')
    if (onRequest) scope.archiveRequestListeners.add(onRequest)
    if (onPledge) scope.archivePledgeListeners.add(onPledge)
    if (onChallenge) scope.archiveChallengeListeners.add(onChallenge)
    if (onChallengeProof) scope.archiveChallengeProofListeners.add(onChallengeProof)
    if (typeof onPeer === 'function') (scope.archivePeerListeners = scope.archivePeerListeners || new Set()).add(onPeer)
    return { status: 'retained', topic: stableScopeDiagnostic(scope) }
  }

  async function releaseArchiveDiscovery ({ onRequest, onPledge, onChallenge, onChallengeProof } = {}) {
    const topic = deriveArchiveDiscoveryTopic({ protocolMajor, networkId })
    const scope = findScope('archive-discovery', topic)
    if (!scope?.archiveDiscovery) return { status: 'released', released: false }
    if (onRequest) scope.archiveRequestListeners.delete(onRequest)
    if (onPledge) scope.archivePledgeListeners.delete(onPledge)
    if (onChallenge) scope.archiveChallengeListeners.delete(onChallenge)
    if (onChallengeProof) scope.archiveChallengeProofListeners.delete(onChallengeProof)
    if (scope.archiveRequestListeners.size > 0 || scope.archivePledgeListeners.size > 0 ||
        scope.archiveChallengeListeners.size > 0 || scope.archiveChallengeProofListeners.size > 0) {
      return { status: 'released', released: false }
    }
    return { status: 'released', released: await leaveScope(scope, 'discovery') }
  }

  async function publishArchiveEnvelope (type, value) {
    if (!ARCHIVE_DISCOVERY_ENVELOPE_TYPES.has(type)) fail('archive discovery frame type is invalid')
    const scope = findScope('archive-discovery', deriveArchiveDiscoveryTopic({ protocolMajor, networkId }))
    if (!scope?.archiveDiscovery) fail('archive discovery is disabled')
    const payload = encodeApplicationEnvelope(value)
    let delivered = 0
    for (const session of scope.sessions.values()) {
      if (sendScopedFrame(session, 'archive-discovery', type, payload)) delivered++
    }
    return { status: 'published', delivered }
  }

  async function publishArchiveRequest ({ request, envelope, entityRef = null, publicationId = null } = {}) {
    const consumerVisible = await authorizeConsumerWork({
      operation: 'archive-request',
      entityRef,
      publicationId: publicationId || request?.body?.publicationId || null,
    })
    if (!consumerVisible) fail('consumer media is not visible under local policy', 'CONSUMER_MEDIA_NOT_VISIBLE')
    return publishArchiveEnvelope('archive-request', envelope || request?.envelope || request)
  }

  async function publishArchivePledge ({ pledge, envelope } = {}) {
    if (!policy.archiveAllowed) fail('explicit archive consent is required')
    return publishArchiveEnvelope('archive-pledge', envelope || pledge?.envelope || pledge)
  }

  async function publishArchiveChallenge ({ challenge, envelope } = {}) {
    if (!policy.archiveAllowed) fail('explicit archive consent is required')
    return publishArchiveEnvelope('archive-challenge', envelope || challenge?.envelope || challenge)
  }

  async function publishArchiveChallengeProof ({ envelope, proofBytes } = {}) {
    if (!policy.archiveAllowed) fail('explicit archive consent is required')
    const scope = findScope('archive-discovery', deriveArchiveDiscoveryTopic({ protocolMajor, networkId }))
    if (!scope?.archiveDiscovery) fail('archive discovery is disabled')
    const proof = b4a.from(proofBytes || [])
    if (proof.byteLength === 0 || proof.byteLength > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES) {
      fail('archive challenge proof exceeds bounded limit')
    }
    const envelopeBytes = encodeApplicationEnvelope(envelope)
    let delivered = 0
    for (const session of scope.sessions.values()) {
      let complete = true
      const canBatch = typeof session.channel?.cork === 'function' && typeof session.channel?.uncork === 'function'
      if (canBatch) session.channel.cork()
      try {
        for (let offset = 0; offset < proof.byteLength; offset += ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES) {
          const chunk = proof.subarray(offset, Math.min(proof.byteLength, offset + ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES))
          const payload = c.encode(c.any, { envelope: envelopeBytes, offset, totalBytes: proof.byteLength, chunk })
          if (!sendScopedFrame(session, 'archive-discovery', 'archive-challenge-proof', payload)) {
            complete = false
            break
          }
        }
      } finally {
        if (canBatch) session.channel.uncork()
      }
      if (complete) delivered++
    }
    return { status: 'published', delivered }
  }

  function calculateExpectedPledgeTotalBlocks (expectedRanges) {
    let totalBlocks = 0
    for (const pRange of expectedRanges) {
      const start = Number(pRange?.start)
      const end = Number(pRange?.end)
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start) {
        totalBlocks += (end - start)
      }
    }
    return totalBlocks
  }

  function buildActiveArchiveResourceMap (archiveStore, archiveId) {
    const resourceMap = new Map()
    for (const retained of archiveStore.values()) {
      const res = retained.resource
      if (res.quarantined === true || res.archiveId !== archiveId) continue
      resourceMap.set(`${res.coreKey}:${res.range.start}:${res.range.end}`, res)
    }
    return resourceMap
  }

  function accumulateResourceProgress (res, acc) {
    const rangeTotal = res.range.end - res.range.start
    const vBlocks = res.verifiedBlockIndexes ? res.verifiedBlockIndexes.size : 0
    acc.verifiedBlocks += vBlocks
    acc.verifiedBytes += (res.verifiedTransferBytes || 0)
    if (Array.isArray(res.verifiedIntervals)) {
      const withCore = res.verifiedIntervals.map(i => ({
        coreKey: res.coreKey,
        start: i.start,
        end: i.end,
      }))
      acc.aggregatedRanges = mergeRangeList(acc.aggregatedRanges, withCore)
    }
    if (vBlocks !== rangeTotal || rangeTotal <= 0) {
      acc.allPledgedRangesComplete = false
    }
  }

  function aggregateCachedArchiveProgress (archiveId, expectedPledgeRanges = []) {
    const expectedRanges = Array.isArray(expectedPledgeRanges) && expectedPledgeRanges.length > 0
      ? expectedPledgeRanges
      : []
    let totalBlocks = calculateExpectedPledgeTotalBlocks(expectedRanges)
    const resourceMap = buildActiveArchiveResourceMap(archives, archiveId)

    const acc = {
      verifiedBlocks: 0,
      verifiedBytes: 0,
      aggregatedRanges: [],
      allPledgedRangesComplete: true,
    }

    if (expectedRanges.length > 0) {
      for (const pRange of expectedRanges) {
        const pKey = `${pRange.coreKey}:${pRange.start}:${pRange.end}`
        const res = resourceMap.get(pKey)
        if (!res) {
          acc.allPledgedRangesComplete = false
          continue
        }
        accumulateResourceProgress(res, acc)
      }
    } else {
      for (const res of resourceMap.values()) {
        totalBlocks += res.range.end - res.range.start
        accumulateResourceProgress(res, acc)
      }
    }

    const complete = expectedRanges.length > 0
      ? (acc.allPledgedRangesComplete && acc.verifiedBlocks === totalBlocks && totalBlocks > 0)
      : (resourceMap.size > 0 && acc.allPledgedRangesComplete && acc.verifiedBlocks === totalBlocks && totalBlocks > 0)

    return {
      archiveId,
      verifiedBlocks: acc.verifiedBlocks,
      totalBlocks,
      verifiedBytes: acc.verifiedBytes,
      verifiedRanges: acc.aggregatedRanges,
      complete,
    }
  }

  async function validateAuthorizedArchiveInputs ({
    pledge,
    requestedCoreKey,
    start,
    end,
    shouldDownload,
    inputCoreRef,
  }) {
    if (shouldDownload !== false && !policy.archiveAllowed) fail('explicit archive consent is required')
    if (shouldDownload !== false && policy.archiveUploadCeilingBytes <= policy.archiveUploadedBytes) fail('archive budget exhausted')
    if (policy.status !== 'active') fail('runtime is not active')
    const envelope = pledge?.envelope || pledge
    const verified = await verifyArchivePledge(envelope, { now: options.now?.() })
    if (!verified) fail('archive pledge authorization failed')
    const coreKey = hex32(requestedCoreKey, 'coreKey')
    const range = safeRange(start, end)
    if (range.end === null) fail('archive range.end is required')
    const authorized = verified.body.ranges.some(candidate => candidate.coreKey === coreKey && candidate.start === range.start && candidate.end === range.end)
    if (!authorized) fail('archive range is not pledge-authorized')

    if (!inputCoreRef) fail('immutable coreRef is required for archive retention')
    const coreRef = normalizeAssetCoreRefV2(inputCoreRef, 'coreRef')
    if (coreRef.key !== coreKey) fail('coreRef key does not match requested coreKey')
    if (range.end > coreRef.length) fail('archive range exceeds coreRef length')

    const archiveId = verified.pledgeId
    const resourceId = `${archiveId}:${coreKey}:${range.start}:${range.end}`
    return { verified, coreKey, range, coreRef, archiveId, resourceId }
  }

  function wireArchiveResourceSource (resource, assetSession, coreRef, range, archiveId, verifiedRanges, onProgress) {
    function expectedBlockSize (index) {
      if (coreRef && index === coreRef.length - 1) {
        return coreRef.byteLength - (coreRef.length - 1) * coreRef.blockSize
      }
      return coreRef?.blockSize || ASSET_BLOCK_SIZE
    }

    function addVerifiedBlockIndex (index) {
      if (!resource.verifiedBlockIndexes.has(index)) {
        resource.verifiedBlockIndexes.add(index)
        resource.verifiedTransferBytes += expectedBlockSize(index)
        resource.verifiedIntervals = mergeRangeList(resource.verifiedIntervals, [{ start: index, end: index + 1 }])
      }
    }

    const originalApply = assetSession.blockSource.apply.bind(assetSession.blockSource)
    return {
      resourceId: coreRef.assetId,
      length: range.end,
      async apply(params) {
        const res = await originalApply(params)
        if (Number.isSafeInteger(params?.index) && params.index >= range.start && params.index < range.end) {
          addVerifiedBlockIndex(params.index)
          if (typeof onProgress === 'function') {
            const snapshot = aggregateCachedArchiveProgress(archiveId, verifiedRanges)
            onProgress(snapshot).catch(() => {})
          }
        }
        return res
      },
    }
  }

  function claimArchiveCoreProtection (archiveId, coreKey, range) {
    if (typeof options.retainArchiveCore !== 'function') return null
    const release = options.retainArchiveCore({ archiveId, coreKey, start: range.start, end: range.end })
    return typeof release === 'function' ? release : null
  }

  function joinArchiveDownloadScopes ({ archiveId, coreKey, coreRef, range, shouldDownload, verified }) {
    const assetTopic = deriveStaticAssetTopic(coreRef.assetId)
    if (shouldDownload !== false) {
      const assetMode = `archive-download:${archiveId}:${coreKey}:${range.start}:${range.end}`
      joinScope({
        purpose: 'asset',
        topic: assetTopic,
        scopeId: coreRef.assetId,
        mode: assetMode,
      })
    }

    const topic = deriveArchiveTopic({ protocolMajor, archiveId })
    const mode = `range:${coreKey}:${range.start}:${range.end}`
    const { scope } = joinScope({
      purpose: 'archive',
      topic,
      scopeId: archiveId,
      mode,
      archiveId,
      archiveResources: new Map(),
      archivePending: new Set(),
      archiveRetries: new Map(),
      archiveFailures: new Map(),
      archiveUploadCeilingBytes: verified.body.uploadCeilingBytes,
    })
    if (!scope.archiveResources) scope.archiveResources = new Map()
    return { scope, mode }
  }

  function buildRetainedArchiveResource ({
    resourceId,
    archiveId,
    coreKey,
    coreRef,
    core,
    assetSession,
    download,
    range,
    mode,
    shouldDownload,
    releaseArchiveProtection,
  }) {
    return {
      resourceId,
      archiveId,
      coreKey,
      coreRef,
      core,
      assetSession,
      download,
      range,
      mode,
      shouldDownload,
      nextIndex: shouldDownload === false ? range.end : range.start,
      releaseArchiveProtection,
      quarantined: false,
      verifiedBlockIndexes: new Set(),
      verifiedTransferBytes: 0,
      verifiedIntervals: [],
      scanCursor: range.start,
      scanComplete: false,
    }
  }

  async function retainAuthorizedArchive ({
    pledge,
    coreKey: requestedCoreKey,
    start,
    end,
    download: shouldDownload = true,
    coreRef: inputCoreRef,
    onProgress = null,
  } = {}) {
    const validated = await validateAuthorizedArchiveInputs({
      pledge,
      requestedCoreKey,
      start,
      end,
      shouldDownload,
      inputCoreRef,
    })
    const { verified, coreKey, range, coreRef, archiveId, resourceId } = validated

    const existing = archives.get(resourceId)
    if (existing) return { ...existing.result, status: 'already-retained' }
    if (!store?.get) fail('corestore is unavailable')

    let releaseArchiveProtection = null
    let assetSession = null
    let resource = null
    try {
      releaseArchiveProtection = claimArchiveCoreProtection(archiveId, coreKey, range)

      assetSession = createAssetSession({
        coreRef,
        store,
        startBlock: range.start,
        endBlock: range.end,
        ownsCore: false,
        onQuarantine: () => {
          if (resource) resource.quarantined = true
        },
      })
      const core = await assetSession.ready()
      const download = shouldDownload === false
        ? null
        : core.download?.({ start: range.start, end: range.end }) || null

      const { scope, mode } = joinArchiveDownloadScopes({
        archiveId,
        coreKey,
        coreRef,
        range,
        shouldDownload,
        verified,
      })
      resource = buildRetainedArchiveResource({
        resourceId,
        archiveId,
        coreKey,
        coreRef,
        core,
        assetSession,
        download,
        range,
        mode,
        shouldDownload,
        releaseArchiveProtection,
      })

      resource.blockSource = wireArchiveResourceSource(
        resource,
        assetSession,
        coreRef,
        range,
        archiveId,
        verified.body.ranges,
        onProgress,
      )

      resource.blockHandle = blockEngine.attach({
        scope,
        source: resource.blockSource,
        allowedRange: range,
        policyEpoch: () => policy.epoch,
        mayServe: () => policy.archiveAllowed && policy.networkEnabled,
      })
      scope.archiveResources.set(resourceId, resource)
      void pumpArchiveSessions(scope)
      const result = { status: 'retained', archiveId, coreKey, range: { ...range }, topic: stableScopeDiagnostic(scope) }
      archives.set(resourceId, { scope, resource, result })
      return result
    } catch (error) {
      try { releaseArchiveProtection?.() } catch { /* best-effort protection release */ }
      try { await assetSession?.close?.() } catch { /* best-effort failed-session close */ }
      throw error
    }
  }


  function ensureOffloadSweep (resource) {
    if (!resource.offloadSweep) {
      resource.offloadSweep = {
        expectedCursor: null,
        activeGeneration: 0,
        generation: null,
        accumulatedResidentBlocks: 0,
        accumulatedRemoteBlocks: 0,
        accumulatedResidentBytes: 0,
        accumulatedRemoteBytes: 0,
        accumulatedAssessedBlocks: 0,
        coveredThrough: null,
        verifiedRanges: [],
      }
    }
    return resource.offloadSweep
  }

  function ensureArchiveProgressSweep (resource) {
    if (!resource.archiveProgressSweep) resource.archiveProgressSweep = createArchiveProgressSweep()
    return resource.archiveProgressSweep
  }

  function validateArchiveProgressCursor (matching, cursor, resourceOrder, useOffload) {
    if (cursor === null) return { valid: true, incomingCursor: null, targetRangeIdx: 0 }
    if (typeof cursor !== 'string' || !ARCHIVE_PROGRESS_CURSOR_PATTERN.test(cursor)) return { valid: false }
    for (let index = 0; index < matching.length; index++) {
      const resource = matching[index]
      const sweep = useOffload ? ensureOffloadSweep(resource) : ensureArchiveProgressSweep(resource)
      const expected = sweep.expectedCursor
      if (!expected || expected.token !== cursor) continue
      const current = cursorForArchiveResource(expected, resource, index, resourceOrder)
      if (sweep.generation !== expected.generation || !sameArchiveCursor(expected, current)) return { valid: false }
      return { valid: true, incomingCursor: expected, targetRangeIdx: index }
    }
    return { valid: false }
  }

  function accumulateOffloadSweepTotals (state, sweep) {
    state.verifiedBlocks += (sweep.accumulatedResidentBlocks + sweep.accumulatedRemoteBlocks)
    state.verifiedBytes += (sweep.accumulatedResidentBytes + sweep.accumulatedRemoteBytes)
    if (sweep.verifiedRanges.length > 0) state.verifiedRanges.push(...sweep.verifiedRanges)
  }

  function resolveDeferredArchiveCursor (state, sweep, resourceCursor, res, rIdx, range, resourceOrder) {
    state.truncated = true
    if (!state.nextCursor) {
      state.nextCursor = resourceCursor !== null && sweep.expectedCursor
        ? sweep.expectedCursor.token
        : issueArchiveProgressCursor(sweep, res, rIdx, range.start, resourceOrder)
    }
  }

  function classifyOffloadPageAssessment (assessment, assessed, pageStart, range) {
    const pageSpan = range.end - pageStart
    const validPageAssessment = assessment.aborted !== true &&
      Number.isSafeInteger(assessed) && assessed > 0 && assessed <= pageSpan
    const pageEnd = Number(assessment.nextCursor?.blockIndex)
    const validPageCursor = validPageAssessment &&
      Number.isSafeInteger(pageEnd) &&
      pageEnd === pageStart + assessed &&
      pageEnd > pageStart &&
      pageEnd < range.end &&
      assessment.nextCursor?.rangeIndex === 0
    const completePage = assessment.aborted !== true &&
      assessment.truncated !== true &&
      assessment.nextCursor == null &&
      validPageAssessment &&
      assessed === pageSpan
    return { validPageCursor, completePage, pageEnd }
  }

  function sealCompletedOffloadRange (sweep, res, range, rangeTotal) {
    sweep.coveredThrough = range.end
    sweep.expectedCursor = null
    const totalRetrievable = sweep.accumulatedResidentBlocks + sweep.accumulatedRemoteBlocks
    const fullyVerified = rangeTotal > 0 &&
      sweep.coveredThrough === range.end &&
      sweep.accumulatedAssessedBlocks === rangeTotal &&
      totalRetrievable === rangeTotal
    sweep.verifiedRanges = fullyVerified
      ? [{ coreKey: res.coreKey, start: range.start, end: range.end }]
      : []
  }

  function applyOffloadAssessmentResult ({ assessment, res, rIdx, range, rangeTotal, offloadCursor, resourceOrder, sweep, state }) {
    const assessed = Number(assessment.assessedBlocks) || 0
    state.remainingBudget = Math.max(0, state.remainingBudget - assessed)
    sweep.accumulatedResidentBlocks += (Number(assessment.residentBlocks) || 0)
    sweep.accumulatedRemoteBlocks += (Number(assessment.remoteRetrievableBlocks) || 0)
    sweep.accumulatedResidentBytes += (Number(assessment.residentBytes) || 0)
    sweep.accumulatedRemoteBytes += (Number(assessment.remoteRetrievableBytes) || 0)
    sweep.accumulatedAssessedBlocks = (sweep.accumulatedAssessedBlocks || 0) + assessed

    const pageStart = offloadCursor?.blockIndex ?? range.start
    const { validPageCursor, completePage, pageEnd } = classifyOffloadPageAssessment(
      assessment,
      assessed,
      pageStart,
      range,
    )
    if (assessment.truncated === true && validPageCursor) {
      sweep.coveredThrough = pageEnd
      state.truncated = true
      state.nextCursor = issueArchiveProgressCursor(sweep, res, rIdx, sweep.coveredThrough, resourceOrder)
      return
    }
    if (completePage) {
      sealCompletedOffloadRange(sweep, res, range, rangeTotal)
      return
    }
    resetOffloadSweep(sweep)
    state.truncated = true
    state.nextCursor = issueArchiveProgressCursor(sweep, res, rIdx, range.start, resourceOrder)
  }

  async function runOffloadRetrievabilityPass ({ res, range, offloadCursor, state, signal, sweep }) {
    const passId = (sweep.passId = (Number(sweep.passId) || 0) + 1)
    sweep.activeGeneration = passId
    let assessment = null
    try {
      if (!signal?.aborted) {
        assessment = await blockOffload.assessRetrievability({
          core: res.core,
          ranges: [range],
          cursor: offloadCursor,
          signal,
          maxBlocks: state.remainingBudget,
        })
      }
    } catch {
      assessment = null
    } finally {
      if (sweep.activeGeneration === passId) sweep.activeGeneration = 0
    }
    return { passId, assessment }
  }

  async function processOffloadArchiveResource ({
    res,
    rIdx,
    targetRangeIdx,
    incomingCursor,
    resourceOrder,
    state,
    signal,
  }) {
    const range = res.range
    const rangeTotal = range.end - range.start
    const sweep = ensureOffloadSweep(res)
    const resourceCursor = rIdx === targetRangeIdx ? incomingCursor : null

    if (rIdx > targetRangeIdx || (rIdx === targetRangeIdx && resourceCursor === null)) {
      resetOffloadSweep(sweep)
    }

    if (rIdx < targetRangeIdx) {
      accumulateOffloadSweepTotals(state, sweep)
      return
    }

    if (state.truncated || state.remainingBudget <= 0) {
      resolveDeferredArchiveCursor(state, sweep, resourceCursor, res, rIdx, range, resourceOrder)
      return
    }

    if (sweep.activeGeneration !== 0) {
      resolveDeferredArchiveCursor(state, sweep, resourceCursor, res, rIdx, range, resourceOrder)
      accumulateOffloadSweepTotals(state, sweep)
      return
    }

    const offloadCursor = resourceCursor == null ? null : { ...resourceCursor, rangeIndex: 0 }
    const { passId, assessment } = await runOffloadRetrievabilityPass({
      res,
      range,
      offloadCursor,
      state,
      signal,
      sweep,
    })

    if (sweep.passId !== passId) {
      state.truncated = true
      if (!state.nextCursor && sweep.expectedCursor) state.nextCursor = sweep.expectedCursor.token
      return
    }

    if (assessment && !signal?.aborted) {
      applyOffloadAssessmentResult({ assessment, res, rIdx, range, rangeTotal, offloadCursor, resourceOrder, sweep, state })
    } else {
      resetOffloadSweep(sweep)
      state.truncated = true
      if (!state.nextCursor) state.nextCursor = issueArchiveProgressCursor(sweep, res, rIdx, range.start, resourceOrder)
    }

    accumulateOffloadSweepTotals(state, sweep)
  }

  function updateCorestoreBlockVerification (res, idx, verified, coreRef) {
    const bSize = (coreRef && idx === coreRef.length - 1)
      ? (coreRef.byteLength - (coreRef.length - 1) * coreRef.blockSize)
      : (coreRef?.blockSize || ASSET_BLOCK_SIZE)
    if (verified) {
      if (!res.verifiedBlockIndexes.has(idx)) {
        res.verifiedBlockIndexes.add(idx)
        res.verifiedTransferBytes = (res.verifiedTransferBytes || 0) + bSize
        res.verifiedIntervals = mergeRangeList(res.verifiedIntervals || [], [{ start: idx, end: idx + 1 }])
      }
      return
    }
    if (!res.verifiedBlockIndexes.has(idx)) return
    res.verifiedBlockIndexes.delete(idx)
    res.verifiedTransferBytes = Math.max(0, (res.verifiedTransferBytes || 0) - bSize)
    const remaining = [...res.verifiedBlockIndexes].sort((a, b) => a - b)
    let rebuilt = []
    for (const b of remaining) {
      rebuilt = mergeRangeList(rebuilt, [{ start: b, end: b + 1 }])
    }
    res.verifiedIntervals = rebuilt
  }

  async function scanCorestoreBlocks (res, cursorIdx, chunkEnd, signal, coreRef) {
    let scannedThrough = cursorIdx
    for (let idx = cursorIdx; idx < chunkEnd; idx++) {
      if (signal?.aborted) break
      let verified = false
      try {
        const val = await res.assetSession?.readVerifiedBlock?.(idx)
        if (val != null && b4a.isBuffer(val)) verified = true
      } catch {
        verified = false
      }
      updateCorestoreBlockVerification(res, idx, verified, coreRef)
      scannedThrough = idx + 1
    }
    return scannedThrough
  }

  function accumulatePriorCorestoreResource (state, res, rangeTotal) {
    const rVBlocks = res.verifiedBlockIndexes ? res.verifiedBlockIndexes.size : 0
    state.verifiedBlocks += rVBlocks
    state.verifiedBytes += (res.verifiedTransferBytes || 0)
    if (res.scannedFullPass && rVBlocks === rangeTotal && rangeTotal > 0) {
      state.verifiedRanges.push({ coreKey: res.coreKey, start: res.range.start, end: res.range.end })
    }
  }

  function resolveCorestoreScanCursor (res, range, resourceCursor) {
    let cursorIdx = resourceCursor !== null
      ? resourceCursor.blockIndex
      : (res.scanCursor ?? range.start)
    if (cursorIdx < range.start || cursorIdx > range.end) cursorIdx = range.start
    return cursorIdx
  }

  function finalizeCorestoreScanChunk ({ res, sweep, state, range, scannedThrough, chunkEnd, signal, rIdx, resourceOrder }) {
    if (signal?.aborted) {
      res.scanCursor = scannedThrough
      state.truncated = true
      state.nextCursor = issueArchiveProgressCursor(sweep, res, rIdx, scannedThrough, resourceOrder)
      return
    }
    if (chunkEnd < range.end) {
      res.scanCursor = chunkEnd
      state.truncated = true
      state.nextCursor = issueArchiveProgressCursor(sweep, res, rIdx, chunkEnd, resourceOrder)
      return
    }
    res.scanCursor = range.start
    res.scannedFullPass = true
    sweep.expectedCursor = null
  }

  async function processCorestoreArchiveResource ({
    res,
    rIdx,
    targetRangeIdx,
    incomingCursor,
    resourceOrder,
    state,
    signal,
  }) {
    const range = res.range
    const coreRef = res.coreRef
    const rangeTotal = range.end - range.start
    const sweep = ensureArchiveProgressSweep(res)
    if (rIdx < targetRangeIdx) {
      accumulatePriorCorestoreResource(state, res, rangeTotal)
      return
    }

    const resourceCursor = rIdx === targetRangeIdx ? incomingCursor : null
    if (rIdx > targetRangeIdx || (rIdx === targetRangeIdx && resourceCursor === null)) {
      resetArchiveProgressSweep(sweep)
      res.scanCursor = range.start
      res.scannedFullPass = false
    }

    if (state.truncated || state.remainingBudget <= 0) {
      resolveDeferredArchiveCursor(state, sweep, resourceCursor, res, rIdx, range, resourceOrder)
      return
    }

    const cursorIdx = resolveCorestoreScanCursor(res, range, resourceCursor)
    const chunkEnd = Math.min(range.end, cursorIdx + state.remainingBudget)
    const scannedBlocks = chunkEnd - cursorIdx
    state.remainingBudget = Math.max(0, state.remainingBudget - scannedBlocks)
    const scannedThrough = await scanCorestoreBlocks(res, cursorIdx, chunkEnd, signal, coreRef)
    finalizeCorestoreScanChunk({
      res,
      sweep,
      state,
      range,
      scannedThrough,
      chunkEnd,
      signal,
      rIdx,
      resourceOrder,
    })

    const rangeVerifiedBlocks = res.verifiedBlockIndexes.size
    state.verifiedBlocks += rangeVerifiedBlocks
    state.verifiedBytes += (res.verifiedTransferBytes || 0)
    if (res.scannedFullPass && rangeVerifiedBlocks === rangeTotal && rangeTotal > 0 && !state.truncated) {
      state.verifiedRanges.push({ coreKey: res.coreKey, start: range.start, end: range.end })
    }
  }

  function collectMatchingArchiveResources (id, key) {
    const matching = []
    for (const retained of archives.values()) {
      const res = retained.resource
      if (res.quarantined === true) continue
      if (id && res.archiveId !== id) continue
      if (key && res.coreKey !== key) continue
      matching.push(res)
    }
    matching.sort(compareArchiveResources)
    return matching
  }

  function createArchiveProgressState (maxBlocks) {
    const budget = Number.isSafeInteger(maxBlocks) && maxBlocks > 0 ? Math.min(maxBlocks, 4096) : 2048
    return {
      remainingBudget: budget,
      verifiedBlocks: 0,
      verifiedBytes: 0,
      verifiedRanges: [],
      truncated: false,
      nextCursor: null,
    }
  }

  async function scanArchiveProgressResources ({
    matching,
    targetRangeIdx,
    incomingCursor,
    resourceOrder,
    state,
    signal,
    useOffload,
  }) {
    let totalBlocks = 0
    for (let rIdx = 0; rIdx < matching.length; rIdx++) {
      const res = matching[rIdx]
      totalBlocks += res.range.end - res.range.start
      const args = {
        res,
        rIdx,
        targetRangeIdx,
        incomingCursor,
        resourceOrder,
        state,
        signal,
      }
      if (useOffload) await processOffloadArchiveResource(args)
      else await processCorestoreArchiveResource(args)
    }
    return totalBlocks
  }

  async function getAuthorizedArchiveProgress ({ archiveId: targetArchiveId, coreKey: targetCoreKey, cursor = null, signal = null, maxBlocks = null } = {}) {
    const id = targetArchiveId ? hex32(targetArchiveId, 'archiveId') : null
    const key = targetCoreKey ? hex32(targetCoreKey, 'coreKey') : null
    const matching = collectMatchingArchiveResources(id, key)
    if (matching.length === 0) return null

    const resourceOrder = archiveResourceOrder(matching)
    const useOffload = blockOffload && typeof blockOffload.assessRetrievability === 'function'
    const totalResourceBlocks = matching.reduce((total, resource) => total + (resource.range.end - resource.range.start), 0)
    const validatedCursor = validateArchiveProgressCursor(matching, cursor, resourceOrder, useOffload)
    if (!validatedCursor.valid) {
      return {
        archiveId: id,
        coreKey: key,
        verifiedBlocks: 0,
        totalBlocks: totalResourceBlocks,
        verifiedBytes: 0,
        verifiedRanges: [],
        complete: false,
        truncated: true,
        nextCursor: null,
      }
    }

    const { incomingCursor, targetRangeIdx } = validatedCursor
    const state = createArchiveProgressState(maxBlocks)
    const totalBlocks = await scanArchiveProgressResources({
      matching,
      targetRangeIdx,
      incomingCursor,
      resourceOrder,
      state,
      signal,
      useOffload,
    })

    return {
      archiveId: id,
      coreKey: key,
      verifiedBlocks: state.verifiedBlocks,
      totalBlocks,
      verifiedBytes: state.verifiedBytes,
      verifiedRanges: state.verifiedRanges,
      complete: !state.truncated && totalBlocks > 0 && state.verifiedBlocks === totalBlocks,
      truncated: state.truncated,
      nextCursor: state.nextCursor,
    }
  }


  function checkAssessmentBudget (store, targetPublicationId, targetRenditionId, requiredRanges) {
    if (!store || typeof store.requestAssessment !== 'function') return null
    const admitted = store.requestAssessment(targetPublicationId, targetRenditionId)
    if (admitted !== false) return null
    const cached = store.getCachedEvidence?.(targetPublicationId, targetRenditionId) || {}
    const evidence = {
      publicationId: targetPublicationId,
      renditionId: targetRenditionId,
      requiredRanges,
      peers: cached.peers || [],
      localRanges: cached.localRanges || [],
      s3Ranges: cached.s3Ranges || [],
      archivePledgeCount: cached.archivePledgeCount || 0,
      previouslyObserved: cached.previouslyObserved === true,
      budgetExceeded: true,
    }
    const snapshot = assessAvailabilityFn(evidence, { now: options.now?.() || Date.now() })
    return { ...snapshot, assessmentPending: true, nextCursor: null }
  }

  function challengeBlockIndex (requiredRanges) {
    const ranges = requiredRanges.filter(range =>
      Number.isSafeInteger(range?.start) &&
      Number.isSafeInteger(range?.end) &&
      range.start >= 0 &&
      range.end > range.start)
    const total = ranges.reduce((sum, range) => sum + range.end - range.start, 0)
    if (total === 0) return null
    let offset = sampleUniformCandidateBlock(total)
    for (const range of ranges) {
      const length = range.end - range.start
      if (offset < length) return range.start + offset
      offset -= length
    }
    return null
  }

  async function probeAndChallengeActivePeers ({
    scope,
    store,
    requiredRanges,
    targetPublicationId,
    targetRenditionId,
    signal,
  }) {
    const core = scope?.assetSession?.core
    if (!core || !store || signal?.aborted) return
    const peerIds = [...new Set((core.peers || []).flatMap(peer => {
      const key = peer?.remotePublicKey
      return (b4a.isBuffer(key) || key instanceof Uint8Array) && key.byteLength === 32
        ? [b4a.toString(key, 'hex')]
        : []
    }))]
    // Hypercore schedules across all connected peers. A proof can only be
    // attributed to one transport identity when exactly one peer was eligible.
    if (peerIds.length !== 1) return
    const transportKey = peerIds[0]
    const blockIndex = challengeBlockIndex(requiredRanges)
    if (blockIndex === null) return
    const startMs = Date.now()
    try {
      await core.get(blockIndex, { timeout: Math.min(assetTransferTimeoutMs, 2_000) })
      store.recordChallengeResult(targetPublicationId, targetRenditionId, {
        transportKey,
        status: 'passed',
        latencyMs: Math.max(1, Date.now() - startMs),
        provenRanges: [{ start: blockIndex, end: blockIndex + 1 }],
        at: options.now?.() || Date.now(),
      })
    } catch (error) {
      store.recordChallengeResult(targetPublicationId, targetRenditionId, {
        transportKey,
        status: signal?.aborted || error?.code === 'REQUEST_TIMEOUT' ? 'timeout' : 'failed',
        latencyMs: Math.max(1, Date.now() - startMs),
        at: options.now?.() || Date.now(),
      })
    }
  }

  function scheduleAvailabilityContinuation ({
    scope,
    core,
    requiredRanges,
    signal,
    maxBlocks,
    assessment,
    totalRequiredBlocks,
    store,
    targetPublicationId,
    targetRenditionId,
  }) {
    try { scope.availabilityContinuation?.abort?.() } catch { /* best-effort */ }
    const continuation = new AbortController()
    scope.availabilityContinuation = continuation
    const parentSignal = signal
    const onParentAbort = () => {
      try { continuation.abort() } catch { /* best-effort */ }
    }
    if (parentSignal) {
      if (parentSignal.aborted) continuation.abort()
      else parentSignal.addEventListener?.('abort', onParentAbort, { once: true })
    }
    void collectRetrievabilityAssessment(
      (pageInput) => blockOffload.assessRetrievability(pageInput),
      {
        core,
        ranges: requiredRanges,
        signal: continuation.signal,
        maxBlocks,
        followContinuations: true,
        cursor: assessment.nextCursor,
      },
    ).then((full) => {
      if (continuation.signal.aborted || scope.closed) return
      const totalAssessed = (Number(assessment.assessedBlocks) || 0) + (Number(full.assessedBlocks) || 0)
      const fullCovered = full.assessmentPending !== true &&
        !full.truncated &&
        !full.aborted &&
        totalAssessed === totalRequiredBlocks &&
        totalRequiredBlocks > 0
      if (!fullCovered || !store) return
      const mergedLocal = mergeRangeList(assessment.residentRanges || [], full.residentRanges || [])
      const mergedRemote = mergeRangeList(assessment.remoteRetrievableRanges || [], full.remoteRetrievableRanges || [])
      store.recordLocalRanges(targetPublicationId, targetRenditionId, mergedLocal)
      store.recordS3Ranges(targetPublicationId, targetRenditionId, mergedRemote)
    }).catch(() => {}).finally(() => {
      if (parentSignal && onParentAbort) {
        try { parentSignal.removeEventListener?.('abort', onParentAbort) } catch { /* best-effort */ }
      }
      if (scope.availabilityContinuation === continuation) scope.availabilityContinuation = null
    })
  }

  async function assessOffloadCustody ({
    scope,
    requiredRanges,
    signal,
    maxBlocks,
    followContinuations,
    store,
    targetPublicationId,
    targetRenditionId,
  }) {
    let localRanges = []
    let s3Ranges = []
    let assessmentPending = false
    let nextCursor = null
    let custodyFullyCovered = false

    try {
      const core = scope?.assetSession?.core || null
      const assessment = await collectRetrievabilityAssessment(
        (pageInput) => blockOffload.assessRetrievability(pageInput),
        {
          core,
          ranges: requiredRanges,
          signal,
          maxBlocks,
          followContinuations,
        },
      )
      assessmentPending = assessment.assessmentPending === true || assessment.aborted === true
      nextCursor = assessment.nextCursor || null
      const totalRequiredBlocks = requiredRanges.reduce((sum, r) => sum + (r.end - r.start), 0)
      custodyFullyCovered = assessmentPending !== true &&
        !assessment.truncated &&
        !assessment.aborted &&
        Number(assessment.assessedBlocks) === totalRequiredBlocks &&
        totalRequiredBlocks > 0

      if (custodyFullyCovered) {
        localRanges = Array.isArray(assessment.residentRanges) ? assessment.residentRanges : []
        s3Ranges = Array.isArray(assessment.remoteRetrievableRanges) ? assessment.remoteRetrievableRanges : []
      }

      if (
        followContinuations !== true &&
        assessmentPending &&
        assessment.nextCursor &&
        scope &&
        !scope.closed
      ) {
        scheduleAvailabilityContinuation({
          scope,
          core,
          requiredRanges,
          signal,
          maxBlocks,
          assessment,
          totalRequiredBlocks,
          store,
          targetPublicationId,
          targetRenditionId,
        })
      }
    } catch {
      assessmentPending = true
      custodyFullyCovered = false
      nextCursor = null
    }

    return { localRanges, s3Ranges, assessmentPending, nextCursor, custodyFullyCovered }
  }

  async function assessLocalCorestoreCustody (scope, requiredRanges, signal) {
    const assetSession = scope?.assetSession || null
    if (!assetSession || requiredRanges.length === 0) {
      return { localRanges: [], s3Ranges: [], assessmentPending: false, nextCursor: null, custodyFullyCovered: false }
    }
    let allResident = true
    let assessmentPending = false
    for (const reqRange of requiredRanges) {
      if (signal?.aborted) {
        allResident = false
        assessmentPending = true
        break
      }
      for (let idx = reqRange.start; idx < reqRange.end; idx++) {
        try {
          const block = await assetSession.readVerifiedBlock(idx)
          if (block == null || !b4a.isBuffer(block)) {
            allResident = false
            break
          }
        } catch {
          allResident = false
          break
        }
      }
      if (!allResident) break
    }
    return {
      localRanges: allResident ? requiredRanges : [],
      s3Ranges: [],
      assessmentPending,
      nextCursor: null,
      custodyFullyCovered: allResident,
    }
  }

  function findRetainedScopeForAvailability (targetPublicationId, targetRenditionId) {
    let retained = targetRenditionId ? renditions.get(targetRenditionId) : null
    if (!retained && targetPublicationId) {
      for (const candidate of renditions.values()) {
        if (candidate?.scope?.publicationId === targetPublicationId) {
          retained = candidate
          break
        }
      }
    }
    return retained?.scope || null
  }

  function buildAvailabilityEvidence ({
    targetPublicationId,
    targetRenditionId,
    requiredRanges,
    store,
    localRanges,
    s3Ranges,
    custodyFullyCovered,
    assessmentPending,
  }) {
    const cached = store?.getCachedEvidence?.(targetPublicationId, targetRenditionId) || {}
    return {
      publicationId: targetPublicationId,
      renditionId: targetRenditionId,
      requiredRanges,
      peers: cached.peers || [],
      localRanges: custodyFullyCovered
        ? localRanges
        : (assessmentPending ? (cached.localRanges || []) : localRanges),
      s3Ranges: custodyFullyCovered
        ? s3Ranges
        : (assessmentPending ? (cached.s3Ranges || []) : s3Ranges),
      archivePledgeCount: cached.archivePledgeCount || 0,
      previouslyObserved: cached.previouslyObserved === true,
      budgetExceeded: cached.budgetExceeded === true,
    }
  }

  async function assessAvailability ({
    publicationId,
    renditionId = null,
    requiredRanges = [],
    signal = null,
    followContinuations = true,
    maxBlocks = 2048,
  } = {}) {
    if (!publicationId) fail('publicationId is required for availability assessment')
    const store = availabilityEvidenceStore || null
    const targetPublicationId = String(publicationId)
    const targetRenditionId = renditionId ? String(renditionId) : null

    const budgetResult = checkAssessmentBudget(store, targetPublicationId, targetRenditionId, requiredRanges)
    if (budgetResult) return budgetResult

    const scope = findRetainedScopeForAvailability(targetPublicationId, targetRenditionId)
    await probeAndChallengeActivePeers({ scope, store, requiredRanges, targetPublicationId, targetRenditionId, signal })

    const useOffload = blockOffload && typeof blockOffload.assessRetrievability === 'function'
    const custody = useOffload
      ? await assessOffloadCustody({
        scope,
        requiredRanges,
        signal,
        maxBlocks,
        followContinuations,
        store,
        targetPublicationId,
        targetRenditionId,
      })
      : await assessLocalCorestoreCustody(scope, requiredRanges, signal)

    const { localRanges, s3Ranges, assessmentPending, nextCursor, custodyFullyCovered } = custody

    if (store && custodyFullyCovered) {
      store.recordLocalRanges(targetPublicationId, targetRenditionId, localRanges)
      store.recordS3Ranges(targetPublicationId, targetRenditionId, s3Ranges)
    }

    const evidence = buildAvailabilityEvidence({
      targetPublicationId,
      targetRenditionId,
      requiredRanges,
      store,
      localRanges,
      s3Ranges,
      custodyFullyCovered,
      assessmentPending,
    })

    const snapshot = assessAvailabilityFn(evidence, { now: options.now?.() || Date.now() })
    return {
      ...snapshot,
      assessmentPending,
      nextCursor,
    }
  }

  function retainedArchiveResource(archiveId, coreKey, index) {
    const id = hex32(archiveId, 'archiveId')
    const key = hex32(coreKey, 'coreKey')
    if (!Number.isSafeInteger(index) || index < 0) fail('archive challenge index is invalid')
    for (const retained of archives.values()) {
      const resource = retained.resource
      if (resource.quarantined !== true && resource.archiveId === id && resource.coreKey === key &&
          index >= resource.range.start && index < resource.range.end) return resource
    }
    fail('archive challenge is outside the retained pledge range')
  }

  async function createAuthorizedArchiveChallengeProof({ archiveId, coreKey, index } = {}) {
    const resource = retainedArchiveResource(archiveId, coreKey, index)
    if (!await resource.core.has?.(index)) fail('challenged archive block is not locally retained')
    const proof = await authorizedBlockProof(resource.core, index)
    if (proof?.block?.index !== index || !b4a.isBuffer(proof.block.value) ||
        proof.block.value.byteLength === 0 || proof.block.value.byteLength > MAX_ARCHIVE_BLOCK_BYTES) {
      fail('generated archive challenge proof is invalid')
    }
    const proofBytes = c.encode(c.any, proof)
    if (proofBytes.byteLength > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES) fail('archive challenge proof exceeds bounded limit')
    return proofBytes
  }

  async function verifyAuthorizedArchiveChallengeProof({ archiveId, coreKey, index, proofBytes } = {}) {
    const resource = retainedArchiveResource(archiveId, coreKey, index)
    const bytes = b4a.from(proofBytes || [])
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES) return false
    try {
      const proof = c.decode(c.any, bytes)
      if (proof?.block?.index !== index || !b4a.isBuffer(proof.block.value) ||
          proof.block.value.byteLength === 0 || proof.block.value.byteLength > MAX_ARCHIVE_BLOCK_BYTES) return false
      await resource.core.verifyFullyRemote(proof)
      return true
    } catch {
      return false
    }
  }

  async function releaseAuthorizedArchive ({ archiveId } = {}) {
    const id = hex32(archiveId, 'archiveId')
    const retained = [...archives.entries()].filter(([, value]) => value.resource.archiveId === id)
    let released = false
    for (const [resourceId, value] of retained) {
      archives.delete(resourceId)
      blockEngine.detach(value.resource.blockHandle)
      value.scope.archiveResources?.delete(resourceId)
      try { value.resource.releaseArchiveProtection?.() } catch { /* best-effort protection release */ }
      value.resource.releaseArchiveProtection = null
      await Promise.allSettled([
        cleanupResource(value.resource.download, ['destroy', 'close']),
        cleanupResource(value.resource.core, ['close']),
      ])
      released = await leaveScope(value.scope, value.resource.mode) || released
    }
    return { status: 'released', archiveId: id, released }
  }

  async function prepareScopeClose (scope) {
    try { scope.availabilityContinuation?.abort?.() } catch { /* best-effort */ }
    scope.availabilityContinuation = null
    await scope.assetSession?.close?.()
    for (const transfer of scope.archiveChallengeProofTransfers?.values() || []) clearTimeout(transfer.timer)
    scope.archiveChallengeProofTransfers?.clear()
  }

  async function finalizeScopeClose (scope) {
    for (const resource of scope.archiveResources?.values() || []) {
      blockEngine.detach(resource.blockHandle)
      try { resource.releaseArchiveProtection?.() } catch { /* best-effort protection release */ }
      resource.releaseArchiveProtection = null
    }
    const resources = scope.archiveResources
      ? [...scope.archiveResources.values()].flatMap(resource => [
          [resource.download, ['destroy', 'close']],
          [resource.core, ['close']],
        ])
      : [
          [scope.download, ['destroy', 'close']],
          [scope.assetSession ? null : scope.core, ['close']],
        ]
    await Promise.allSettled(resources.map(([resource, methods]) => cleanupResource(resource, methods)))
  }


  return {
    queueArchiveRetry, clearArchiveTimer, startArchivePumpWhenOpen,
    handleArchiveFrame, pumpArchiveSessions, prepareScopeClose, finalizeScopeClose,
    retainAuthorizedRendition, releaseAuthorizedRendition, getActiveAssetSession,
    revalidateRetainedRenditions, retainArchiveDiscovery, releaseArchiveDiscovery,
    publishArchiveRequest, publishArchivePledge, publishArchiveChallenge, publishArchiveChallengeProof,
    retainAuthorizedArchive, releaseAuthorizedArchive, getAuthorizedArchiveProgress,
    assessAvailability, createAuthorizedArchiveChallengeProof,
    verifyAuthorizedArchiveChallengeProof,
  }
}
