import b4a from 'b4a'
import c from 'compact-encoding'

import {
  ASSET_BLOCK_ERROR_CODES, MAX_ASSET_BLOCKS_PER_REQUEST, MAX_ASSET_TRANSFER_ID,
  decodeAssetBlockError, decodeAssetBlockRequest, decodeAssetBlockResponse, decodeAssetIdPrefix,
  decodeAssetRangeSummaryPage, decodeAssetRangeSummaryRequest, encodeAssetBlockError,
  encodeAssetBlockRequest, encodeAssetBlockResponse, encodeAssetRangeSummaryPage, encodeAssetRangeSummaryRequest,
} from './frame.js'
import {
  MAX_VERIFIED_BLOCK_BYTES, MAX_VERIFIED_PROOF_BYTES, VERIFIED_BLOCK_CHUNK_BYTES,
  createVerifiedBlockProof, decodeVerifiedBlockChunk, decodeVerifiedBlockProof,
  encodeVerifiedBlockChunk, encodeVerifiedBlockProof,
} from './block-protocol.js'
import { deriveArchiveDiscoveryTopic, deriveArchiveTopic } from './topics.js'
import { verifyArchivePledge } from '../archive/pledge.js'
import { isArtworkRendition, normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import { deriveStaticAssetTopic } from '../assets/static-core.js'
import { createAssetSession } from '../assets/asset-session.js'
import { decodeApplicationEnvelope, encodeApplicationEnvelope } from '../records/application-envelope.js'

const MAX_ASSET_BLOCK_BYTES = MAX_VERIFIED_BLOCK_BYTES
const MAX_ASSET_PROOF_BYTES = MAX_VERIFIED_PROOF_BYTES
const MAX_ARCHIVE_CHALLENGE_PROOF_BYTES = 320 * 1024
const ASSET_CHUNK_BYTES = VERIFIED_BLOCK_CHUNK_BYTES
const ASSET_TRANSFER_TIMEOUT_MS = 10_000
const ASSET_TRANSPORT_ERROR_CODES = new Set(['INVALID_PROOF', 'QUARANTINED', 'DISCONNECTED', 'TIMEOUT', 'UNAVAILABLE'])
const MAX_ASSET_PEERS_PER_REQUEST = 16
const MAX_ASSET_PEER_ID_BYTES = 128
const ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES = 48 * 1024
const MAX_ARCHIVE_CHALLENGE_TRANSFERS = 16
const ARCHIVE_CHALLENGE_TRANSFER_TIMEOUT_MS = 10_000
const ARCHIVE_DISCOVERY_ENVELOPE_TYPES = new Set(['archive-request', 'archive-pledge', 'archive-challenge'])
const ARCHIVE_DISCOVERY_TYPES = new Set([...ARCHIVE_DISCOVERY_ENVELOPE_TYPES, 'archive-challenge-proof'])

function fail (message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function assetAuthorizationId (renditionId, ownerId) {
  return `${renditionId}\0${ownerId}`
}

export function createScopedContentRuntime (context) {
  const {
    options, store, authorizePublication, authorizeConsumerWork, protocolMajor, networkId,
    assetTransferTimeoutMs, counters, renditions, archives, blockEngine,
    normalizeRetentionClass, scopeUploadRetentionClass, reservePolicyUpload,
    findScope, joinScope, leaveScope, closeSession, sendScopedFrame, recordProtocolError,
    cleanupResource, stableScopeDiagnostic, safeRange, hex32, policy,
  } = context
  let nextAssetTransferId = 1n

  function boundedAssetPeerId (value) {
    const peerId = String(value || '')
    if (!peerId || b4a.byteLength(peerId) > MAX_ASSET_PEER_ID_BYTES) fail('asset peerId is invalid')
    return peerId
  }

  function assetTransportError (code, peerId, message, cause = null) {
    if (!ASSET_TRANSPORT_ERROR_CODES.has(code)) fail('asset transport error code is invalid')
    const boundedCause = cause
      ? {
          code: String(cause.code || cause.name || 'ERROR').slice(0, 64),
          message: String(cause.message || cause).slice(0, 256),
        }
      : null
    const error = new Error(
      String(message || code).slice(0, 256),
      boundedCause ? { cause: boundedCause } : undefined,
    )
    error.name = 'AssetTransportError'
    error.code = code
    error.peerId = peerId === null || peerId === undefined ? null : boundedAssetPeerId(peerId)
    return error
  }

  function sealAssetInventoryRequest (session, request) {
    if (!request || request.closed || session?.assetInventoryRequest !== request) return false
    request.closed = true
    clearTimeout(request.timer)
    request.timer = null
    request.signal?.removeEventListener?.('abort', request.onAbort)
    session.assetInventoryRequest = null
    return true
  }

  function settleAssetInventoryRequest (request, error = null, page = null) {
    if (error) request.reject(error)
    else request.resolve(page)
  }

  function closeAssetInventoryRequest (session, request, error = null, page = null) {
    if (!sealAssetInventoryRequest(session, request)) return false
    settleAssetInventoryRequest(request, error, page)
    return true
  }

  function cancelAssetSummaryScan(session) {
    if (!session?.assetSummaryScan) return false
    session.assetSummaryScan.cancelled = true
    session.assetSummaryScan = null
    return true
  }

  function encodeAssetIndex (index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) fail('asset block index is out of bounds')
    const payload = b4a.alloc(4)
    payload.writeUInt32BE(index, 0)
    return payload
  }

  function decodeAssetIndex (payload) {
    if (!b4a.isBuffer(payload) || payload.byteLength !== 4) fail('asset block index payload is invalid')
    return payload.readUInt32BE(0)
  }
  function clearAssetTimer (tracked) {
    if (!tracked?.assetTimer) return
    clearTimeout(tracked.assetTimer)
    tracked.assetTimer = null
  }

  function allocateAssetTransferId () {
    if (nextAssetTransferId > MAX_ASSET_TRANSFER_ID) fail('asset transfer id exhausted')
    return nextAssetTransferId++
  }

  function assetAbortError (peerId = null, message = 'asset request aborted') {
    const error = new Error(message)
    error.name = 'AbortError'
    error.code = 'ABORT_ERR'
    error.peerId = peerId
    return error
  }

  function sealAssetRequest (scope, request) {
    if (!request || request.closed) return false
    request.closed = true
    clearTimeout(request.timer)
    request.timer = null
    request.signal?.removeEventListener?.('abort', request.onAbort)
    for (const transfer of request.transfers.values()) transfer.close?.('request-closed')
    request.transfers.clear()
    scope.assetRequests.delete(request.key)
    return true
  }

  function settleAssetRequest (request, error = null) {
    if (error) request.reject(error)
    else request.resolve({
      verifiedBlockIndexes: [...request.verified].sort((left, right) => left - right),
      peerIds: [...request.peerIds].sort(),
    })
  }

  function closeAssetRequest (scope, request, error = null) {
    if (!sealAssetRequest(scope, request)) return false
    settleAssetRequest(request, error)
    return true
  }

  async function quarantineAssetScope (scope, cause, context = null) {
    if (!scope) return
    const invalidPeerId = context?.peerId || null
    const invalidTransferId = context?.transferId ?? null
    const requestSettlements = []
    for (const request of [...(scope.assetRequests?.values() || [])]) {
      const code = invalidPeerId &&
          invalidTransferId !== null &&
          request.transferId === invalidTransferId
        ? 'INVALID_PROOF'
        : 'QUARANTINED'
      if (sealAssetRequest(scope, request)) {
        requestSettlements.push([request, assetTransportError(
          code,
          invalidPeerId,
          code === 'INVALID_PROOF' ? 'asset proof verification failed' : 'asset core was quarantined',
          cause,
        )])
      }
    }
    const inventorySettlements = []
    for (const session of scope.sessions.values()) {
      cancelAssetSummaryScan(session)
      const inventory = session.assetInventoryRequest
      if (sealAssetInventoryRequest(session, inventory)) {
        inventorySettlements.push([inventory, assetTransportError(
          'QUARANTINED',
          invalidPeerId,
          'asset core was quarantined',
          cause,
        )])
      }
      for (const response of session.assetResponses?.values() || []) response.cancelled = true
      session.assetResponses?.clear()
    }
    const download = scope.download
    scope.download = null
    await cleanupResource(download, ['destroy', 'close'])
    for (const [request, error] of requestSettlements) settleAssetRequest(request, error)
    for (const [request, error] of inventorySettlements) settleAssetInventoryRequest(request, error)
  }

  function requestPeerFailure (request) {
    const priority = ['INVALID_PROOF', 'QUARANTINED', 'TIMEOUT', 'UNAVAILABLE', 'DISCONNECTED']
    const failures = [...request.peerFailures.values()]
    for (const code of priority) {
      const failure = failures.find(error => error.code === code)
      if (failure) return failure
    }
    return assetTransportError('UNAVAILABLE', null, 'asset blocks are unavailable')
  }

  function failAssetRequestPeer (scope, peerId, code = 'DISCONNECTED', cause = null) {
    for (const request of scope.assetRequests?.values() || []) {
      if (!request.requestedPeers.has(peerId) || request.closed) continue
      request.failedPeers.add(peerId)
      if (!request.peerFailures.has(peerId)) {
        request.peerFailures.set(peerId, assetTransportError(
          code,
          peerId,
          code === 'INVALID_PROOF' ? 'asset proof verification failed' : 'asset blocks are unavailable from peer',
          cause,
        ))
      }
      for (const [index, transfer] of request.transfers) {
        if (transfer.peerId !== peerId) continue
        transfer.close?.('peer-failed')
        request.transfers.delete(index)
      }
      if ([...request.requestedPeers].every(id => request.failedPeers.has(id))) {
        closeAssetRequest(scope, request, requestPeerFailure(request))
      }
    }
  }

  function assertAssetFrameScope (scope, payload) {
    const assetId = decodeAssetIdPrefix(payload)
    if (!b4a.equals(assetId, b4a.from(scope.assetId, 'hex'))) fail('asset frame assetId mismatch')
  }

  async function authorizedBlockProof (core, index) {
    return createVerifiedBlockProof({
      manifest: core.manifest,
      proof: blockIndex => core.proof({
        block: { index: blockIndex, nodes: 0 },
        upgrade: { start: 0, length: core.length },
      }),
    }, index)
  }

  function encodeAssetProof (index, proof, value) {
    return encodeVerifiedBlockProof({ index, proof, value })
  }

  function decodeAssetProof (payload, expectedIndex) {
    return decodeVerifiedBlockProof(payload, { index: expectedIndex })
  }

  function encodeAssetChunk (index, offset, value) {
    return encodeVerifiedBlockChunk({ index, offset, value })
  }

  const decodeAssetChunk = decodeVerifiedBlockChunk


  function sendAssetError (scope, tracked, range, code) {
    return sendScopedFrame(tracked, 'asset', 'asset-block-error', encodeAssetBlockError({
      assetId: scope.assetId,
      transferId: range.transferId,
      startBlock: range.startBlock,
      endBlock: range.endBlock,
      code,
    }))
  }


  async function sendAssetBlocks (scope, tracked, range) {
    if (range.startBlock < scope.range.start || range.endBlock > scope.range.end) {
      fail('asset block request is outside the authorized range')
    }
    if (tracked.assetResponses.size >= MAX_ASSET_BLOCKS_PER_REQUEST ||
        tracked.assetResponses.has(range.transferId)) {
      fail('asset responder request limit exceeded')
    }
    const responseState = { cancelled: false, policyEpoch: policy.epoch, range }
    tracked.assetResponses.set(range.transferId, responseState)
    let served = 0
    try {
      const retentionClass = scopeUploadRetentionClass(scope)
      if (!retentionClass || !policy.networkEnabled) {
        sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
        return
      }
      await scope.assetSession.ready()
      const abandon = () => {
        const current = !responseState.cancelled && !scope.closed && !tracked.closed &&
          scope.sessions.get(tracked.peerId) === tracked
        if (current) sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
      }
      for (let index = range.startBlock; index < range.endBlock; index++) {
        const result = await scope.assetSession.blockEngine.serve({
          handle: scope.blockHandle,
          peerId: tracked.peerId,
          request: {
            resourceId: scope.assetId,
            start: range.startBlock,
            end: range.endBlock,
            index,
            retentionClass,
          },
          isActive: () => !responseState.cancelled && !scope.closed && !tracked.closed &&
            policy.networkEnabled && responseState.policyEpoch === policy.epoch,
          encodeProof: ({ index, proof, value }) => encodeAssetProof(index, proof, value),
          reserve: ({ bytes }) => reservePolicyUpload(retentionClass, bytes),
          sendProofPart: ({ offset, totalBytes, chunk }) => sendScopedFrame(
            tracked,
            'asset',
            'asset-block-response',
            encodeAssetBlockResponse({
              assetId: scope.assetId,
              transferId: range.transferId,
              startBlock: range.startBlock,
              endBlock: range.endBlock,
              blockIndex: index,
              kind: 'proof',
              offset,
              totalBytes,
              chunk,
            }),
          ),
          sendBlockPart: ({ offset, totalBytes, chunk }) => sendScopedFrame(
            tracked,
            'asset',
            'asset-block-response',
            encodeAssetBlockResponse({
              assetId: scope.assetId,
              transferId: range.transferId,
              startBlock: range.startBlock,
              endBlock: range.endBlock,
              blockIndex: index,
              kind: 'block',
              offset,
              totalBytes,
              chunk,
            }),
          ),
        })
        if (result.status === 'sent') served++
        else if (result.status === 'cancelled') return abandon()
      }
      if (served === 0 && !responseState.cancelled && !tracked.closed) {
        sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
      }
    } finally {
      tracked.assetResponses.delete(range.transferId)
    }
  }

  function blockResponsePart (scope, response) {
    return {
      resourceId: scope.assetId,
      start: response.startBlock,
      end: response.endBlock,
      index: response.blockIndex,
      offset: response.offset,
      totalBytes: response.totalBytes,
      chunk: response.chunk,
    }
  }

  function receiveAssetProofPart (scope, transfer, response) {
    if (transfer.proofMetadata) fail('asset proof was already completed')
    const received = scope.assetSession.blockEngine.receiveProofPart({
      handle: scope.blockHandle,
      transfer,
      part: blockResponsePart(scope, response),
    })
    if (received.status !== 'complete') return
    const metadata = decodeAssetProof(received.assembly.buffer, transfer.index)
    const validation = scope.assetSession.validateProofMetadata({
      index: transfer.index,
      proof: metadata.proof,
      byteLength: metadata.byteLength,
      peerId: transfer.peerId,
      transferId: transfer.transferId,
    })
    if (validation && typeof validation.then === 'function') {
      received.assembly.buffer = null
      transfer.preflight = validation
      return validation
    }
    transfer.expectedBlockBytes = validation
    transfer.proofMetadata = metadata
    received.assembly.buffer = null
  }

  function receiveAssetBlockPart (scope, transfer, response) {
    if (!transfer.proofMetadata) fail('asset block bytes arrived before a complete canonical proof')
    if (response.totalBytes !== transfer.expectedBlockBytes) {
      fail('asset block response length does not match the verified descriptor')
    }
    return scope.assetSession.blockEngine.receiveBlockPart({
      handle: scope.blockHandle,
      transfer,
      part: blockResponsePart(scope, response),
    })
  }

  async function finishAssetResponse (scope, request, transfer) {
    if (transfer.applying || !transfer.proofMetadata || !transfer.block ||
        transfer.block.receivedBytes !== transfer.block.totalBytes) return
    transfer.applying = true
    try {
      if (request.closed || scope.assetRequests.get(request.key) !== request) return
      const result = await scope.assetSession.blockEngine.finish({
        handle: scope.blockHandle,
        request,
        transfer,
        proof: transfer.proofMetadata.proof,
      })
      if (result.status === 'ignored' || request.closed || scope.assetRequests.get(request.key) !== request) return 'ignored'
      request.transfers.delete(transfer.index)
      request.remaining.delete(transfer.index)
      request.verified.add(transfer.index)
      request.peerIds.add(transfer.peerId)
      if (request.remaining.size === 0) closeAssetRequest(scope, request)
    } catch (error) {
      const closedDuringVerification =
        error?.message === 'asset block request is closed' &&
        (request.closed ||
          scope.assetRequests.get(request.key) !== request ||
          request.transfers.get(transfer.index) !== transfer)
      transfer.close?.('failed')
      if (request.transfers.get(transfer.index) === transfer) request.transfers.delete(transfer.index)
      if (closedDuringVerification) return 'ignored'
      throw error
    }
  }

  async function acceptAssetBlockResponse (scope, tracked, payload) {
    assertAssetFrameScope(scope, payload)
    const response = decodeAssetBlockResponse(payload, { coreLength: scope.assetSession.coreRef.length })
    const request = scope.assetRequests.get(response.transferId)
    if (!request || request.closed || !request.requestedPeers.has(tracked.peerId)) return { status: 'ignored' }
    if (response.startBlock !== request.startBlock || response.endBlock !== request.endBlock) {
      fail('asset block response range does not match its transfer')
    }
    if (!request.remaining.has(response.blockIndex)) return { status: 'ignored' }
    let transfer = request.transfers.get(response.blockIndex)
    if (!transfer) {
      if (response.kind !== 'proof' || response.offset !== 0) {
        fail('asset block bytes arrived before a complete canonical proof')
      }
      transfer = scope.assetSession.blockEngine.createTransfer({
        handle: scope.blockHandle,
        resourceId: scope.assetId,
        start: response.startBlock,
        end: response.endBlock,
        index: response.blockIndex,
        peerId: tracked.peerId,
        transferId: response.transferId,
      })
      transfer.proofMetadata = null
      transfer.preflight = null
      transfer.expectedBlockBytes = null
      transfer.applying = false
      request.transfers.set(response.blockIndex, transfer)
    }
    if (transfer.transferId !== response.transferId) fail('asset block response transferId changed')
    if (transfer.peerId !== tracked.peerId) fail('asset block response changed contributing peer')
    if (transfer.preflight) await transfer.preflight
    if (response.kind === 'proof') {
      const preflight = receiveAssetProofPart(scope, transfer, response)
      if (preflight) await preflight
    } else {
      receiveAssetBlockPart(scope, transfer, response)
    }
    const completion = await finishAssetResponse(scope, request, transfer)
    if (completion === 'ignored') return { status: 'ignored' }
    return { status: request.closed ? 'complete' : 'accepted' }
  }

  async function handleAssetFrame (scope, tracked, frame) {
    counters.inboundAssetFrames++
    if (!tracked || tracked.closed || tracked.state !== 'active') fail('asset session is not active')
    switch (frame.type) {
      case 'probe':
        return { status: 'ok' }
      case 'asset-range-summary-request': {
        assertAssetFrameScope(scope, frame.payload)
        const request = decodeAssetRangeSummaryRequest(frame.payload, { coreLength: scope.assetSession.coreRef.length })
        if (tracked.assetSummaryScan) fail('asset inventory scan is already active for this peer')
        const scan = { cancelled: false, policyEpoch: policy.epoch }
        tracked.assetSummaryScan = scan
        const isActive = () => !scan.cancelled &&
          tracked.assetSummaryScan === scan &&
          !scope.closed &&
          !tracked.closed &&
          !tracked.channel?.closed &&
          scan.policyEpoch === policy.epoch
        try {
          const page = policy.uploadAllowed && policy.networkEnabled
            ? await scope.assetSession.listAssetRanges({ cursor: request.cursor, limit: request.limit, isActive })
            : { ranges: [], nextCursor: null }
          if (!isActive()) return { status: 'ignored' }
          sendScopedFrame(tracked, 'asset', 'asset-range-summary-page', encodeAssetRangeSummaryPage({
            assetId: scope.assetId,
            ranges: page.ranges,
            nextCursor: page.nextCursor,
            coreLength: scope.assetSession.coreRef.length,
            cursor: request.cursor,
            limit: request.limit,
          }))
          return { status: 'sent' }
        } finally {
          if (tracked.assetSummaryScan === scan) tracked.assetSummaryScan = null
        }
      }
      case 'asset-range-summary-page': {
        assertAssetFrameScope(scope, frame.payload)
        const request = tracked.assetInventoryRequest
        const page = decodeAssetRangeSummaryPage(frame.payload, {
          coreLength: scope.assetSession.coreRef.length,
          cursor: request?.cursor ?? null,
          limit: request?.limit,
        })
        if (!request || request.closed) return { status: 'ignored' }
        closeAssetInventoryRequest(tracked, request, null, {
          ranges: page.ranges,
          nextCursor: page.nextCursor,
        })
        return { status: 'accepted' }
      }
      case 'asset-block-request': {
        assertAssetFrameScope(scope, frame.payload)
        const range = decodeAssetBlockRequest(frame.payload, { coreLength: scope.assetSession.coreRef.length })
        if (range.transferId <= tracked.lastAssetTransferId) fail('asset transferId is not monotonically increasing')
        tracked.lastAssetTransferId = range.transferId
        await sendAssetBlocks(scope, tracked, range)
        return { status: 'sent' }
      }
      case 'asset-block-response':
        try {
          return await acceptAssetBlockResponse(scope, tracked, frame.payload)
        } catch (error) {
          failAssetRequestPeer(scope, tracked.peerId, 'INVALID_PROOF', error)
          throw error
        }
      case 'asset-block-error': {
        assertAssetFrameScope(scope, frame.payload)
        const response = decodeAssetBlockError(frame.payload, { coreLength: scope.assetSession.coreRef.length })
        const request = scope.assetRequests.get(response.transferId)
        if (!request || request.closed || !request.requestedPeers.has(tracked.peerId)) return { status: 'ignored' }
        if (response.startBlock !== request.startBlock || response.endBlock !== request.endBlock) {
          fail('asset block error range does not match its transfer')
        }
        failAssetRequestPeer(scope, tracked.peerId, 'UNAVAILABLE')
        return { status: 'unavailable' }
      }
      default:
        fail('frame type is not allowed for asset purpose')
    }
  }

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
    return {
      coreKey: hex32(value?.coreKey, 'coreKey'),
      index: decodeAssetIndex(encodeAssetIndex(value?.index)),
    }
  }

  function encodeArchiveProof (coreKey, index, proof, value) {
    const metadata = c.decode(c.any, encodeAssetProof(index, proof, value))
    metadata.coreKey = hex32(coreKey, 'coreKey')
    const payload = c.encode(c.any, metadata)
    if (payload.byteLength > MAX_ASSET_PROOF_BYTES) fail('archive proof exceeds bounded limit')
    return payload
  }

  function decodeArchiveProof (payload, expected) {
    if (!b4a.isBuffer(payload) || payload.byteLength > MAX_ASSET_PROOF_BYTES) fail('archive proof exceeds bounded limit')
    const metadata = c.decode(c.any, payload)
    if (hex32(metadata?.coreKey, 'coreKey') !== expected.coreKey) fail('archive proof core is invalid')
    const assetMetadata = { ...metadata }
    delete assetMetadata.coreKey
    return decodeAssetProof(c.encode(c.any, assetMetadata), expected.index)
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
        }, ASSET_TRANSFER_TIMEOUT_MS)
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

  async function sendArchiveBlock (scope, tracked, request) {
    if (!policy.archiveAllowed) {
      sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
      return
    }
    const resource = archiveResourceFor(scope, request.coreKey, request.index)
    const lastServed = tracked.archiveLastServed.get(resource?.resourceId) ?? -1
    if (tracked.archiveServing || !resource || request.index <= lastServed) {
      fail('archive block request is outside the authorized monotonic range')
    }
    tracked.archiveServing = true
    const policyEpoch = policy.epoch
    try {
      if (!policy.archiveAllowed || !policy.uploadAllowed || !policy.networkEnabled || !await resource.core.has?.(request.index)) {
        sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
        return
      }
      const proof = await authorizedBlockProof(resource.core, request.index)
      const value = b4a.from(proof?.block?.value || [])
      const ceiling = scope.archiveUploadCeilingBytes
      const reservation = policyEpoch === policy.epoch
        ? await reservePolicyUpload('archive-pin', value.byteLength)
        : null
      if (!reservation || policyEpoch !== policy.epoch ||
          proof?.block?.index !== request.index || value.byteLength > MAX_ASSET_BLOCK_BYTES ||
          tracked.archiveServedBytes + value.byteLength > ceiling) {
        reservation?.release()
        sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
        return
      }
      const canBatch = typeof tracked.channel?.cork === 'function' && typeof tracked.channel?.uncork === 'function'
      if (canBatch) tracked.channel.cork()
      let sent = false
      try {
        sent = sendScopedFrame(tracked, 'archive', 'archive-block-proof', encodeArchiveProof(request.coreKey, request.index, proof, value))
        for (let offset = 0; sent && offset < value.byteLength; offset += ASSET_CHUNK_BYTES) {
          if (!policy.archiveAllowed || policyEpoch !== policy.epoch || scope.closed || tracked.closed) {
            sent = false
            break
          }
          const chunk = value.subarray(offset, Math.min(value.byteLength, offset + ASSET_CHUNK_BYTES))
          sent = sendScopedFrame(tracked, 'archive', 'archive-block-chunk', encodeAssetChunk(request.index, offset, chunk))
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

  async function receiveArchiveChallengeProofChunk(scope, tracked, payload) {
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
    const transferId = b4a.toString(envelope.recordId, 'hex')
    const key = `${tracked.peerId}:${transferId}`
    let transfer = scope.archiveChallengeProofTransfers.get(key)
    if (offset === 0) {
      clearArchiveChallengeProofTransfer(scope, key)
      if (scope.archiveChallengeProofTransfers.size >= MAX_ARCHIVE_CHALLENGE_TRANSFERS) {
        fail('archive challenge proof transfer limit exceeded')
      }
      transfer = {
        envelope,
        totalBytes,
        chunks: [],
        receivedBytes: 0,
        timer: setTimeout(() => clearArchiveChallengeProofTransfer(scope, key), ARCHIVE_CHALLENGE_TRANSFER_TIMEOUT_MS),
      }
      transfer.timer?.unref?.()
      scope.archiveChallengeProofTransfers.set(key, transfer)
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


  async function handleArchiveFrame (scope, tracked, frame) {
    if (!tracked || tracked.closed || tracked.state !== 'active') fail('archive session is not active')
    if (scope.archiveDiscovery) {
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
    switch (frame.type) {
      case 'probe':
        return { status: 'ok' }
      case 'archive-block-request':
        await sendArchiveBlock(scope, tracked, decodeArchiveBlockRef(frame.payload))
        return { status: 'sent' }
      case 'archive-block-proof': {
        const request = tracked.archiveRequest
        const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
        if (!resource || tracked.archiveTransfer) fail('unexpected archive proof')
        const metadata = decodeArchiveProof(frame.payload, request)
        const transfer = blockEngine.createTransfer({
          handle: resource.blockHandle,
          resourceId: request.coreKey,
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
            resourceId: request.coreKey,
            start: resource.range.start,
            end: resource.range.end,
            index: request.index,
            offset: 0,
            totalBytes: frame.payload.byteLength,
            chunk: frame.payload,
          },
        })
        if (received.status !== 'complete') fail('archive proof transfer is incomplete')
        transfer.proofMetadata = metadata
        transfer.expectedBlockBytes = metadata.byteLength
        tracked.archiveTransfer = transfer
        if (metadata.byteLength === 0) await finishArchiveTransfer(scope, tracked)
        return { status: 'accepted' }
      }
      case 'archive-block-chunk': {
        const request = tracked.archiveRequest
        const transfer = tracked.archiveTransfer
        const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
        if (!resource || !transfer) fail('unexpected archive block chunk')
        const chunk = decodeAssetChunk(frame.payload)
        if (chunk.index !== request.index) fail('archive block chunk is out of sequence')
        const received = blockEngine.receiveBlockPart({
          handle: resource.blockHandle,
          transfer,
          part: {
            resourceId: request.coreKey,
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

  async function retainAuthorizedRendition ({
    manifest,
    renditionId,
    ownerId: requestedOwnerId,
    retentionClass: requestedRetentionClass,
    start = 0,
    end = null,
    entityRef = null,
    publicationId = null,
  } = {}) {
    const retentionClass = normalizeRetentionClass(requestedRetentionClass)
    if (policy.status !== 'active') fail('runtime is not active')
    const consumerVisible = await authorizeConsumerWork({
      operation: 'asset-retain',
      entityRef,
      publicationId: publicationId || manifest?.publicationId || null,
      renditionId,
    })
    if (!consumerVisible) fail('consumer media is not visible under local policy', 'CONSUMER_MEDIA_NOT_VISIBLE')
    const id = String(renditionId || '')
    const ownerId = String(requestedOwnerId || manifest?.publicationId || id)
    if (!ownerId) fail('retention owner is required')
    const rendition = (manifest?.body?.renditions || []).find(candidate => candidate.renditionId === id)
    if (!rendition || rendition.blocked || rendition.superseded) fail('rendition is not manifest-authorized')
    const coreRef = normalizeAssetCoreRefV2(rendition.core)
    const declaredLength = coreRef.length
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) fail('rendition core length is invalid')
    // Shared cores require the rendition's provenance span, not the whole core length.
    const uploadProvenance = (manifest?.body?.provenance || []).filter(candidate =>
      (candidate?.type === 'upload' || candidate?.type === 'artwork') &&
      candidate.renditionId === id &&
      candidate.coreKey === rendition.core?.key &&
      Number.isSafeInteger(candidate.start) &&
      Number.isSafeInteger(candidate.end) &&
      candidate.start >= 0 &&
      candidate.end > candidate.start
    )
    // A single provenance entry must cover the entire derived default range.
    const soleUpload = uploadProvenance.length === 1 ? uploadProvenance[0] : null
    const defaultStart = soleUpload ? soleUpload.start : 0
    const defaultEnd = soleUpload ? soleUpload.end : declaredLength
    const range = safeRange(start === 0 && end === null ? defaultStart : start, end === null ? defaultEnd : end)
    if (range.end > declaredLength) fail('rendition range exceeds the manifest core length')
    const verified = await authorizePublication({ manifest, renditionId: id, start: range.start, end: range.end })
    if (!verified) fail('publication manifest authorization failed')
    const coreKey = coreRef.key
    const existing = renditions.get(id)
    if (existing) {
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
      if (!store?.get) fail('corestore is unavailable')
      let assetSession = null
      try {
        assetSession = createAssetSession({
          coreRef,
          store,
          startBlock: range.start,
          endBlock: range.end,
          onQuarantine: ({ cause, context }) => quarantineAssetScope(scope, cause, context),
        })
        const core = await assetSession.ready()
        const download = core.download?.({ start: range.start, end: range.end }) || null
        ;({ scope } = joinScope({
          purpose: 'asset',
          topic,
          scopeId: coreRef.assetId,
          mode,
          assetId: coreRef.assetId,
          coreKey,
          download,
          range,
          assetSession,
          assetRequests: new Map(),
          retentionClasses: new Set([retentionClass]),
          entityRef,
          publicationId: publicationId || manifest?.publicationId || null,
          assetAuthorizations: new Map([[
            assetAuthorizationId(id, ownerId),
            { manifest, renditionId: id, range: { ...range } },
          ]]),
        }))
        scope.blockHandle = assetSession.blockEngine.attach({
          scope,
          source: assetSession.blockSource,
          allowedRange: range,
          policyEpoch: () => policy.epoch,
          mayServe: () => Boolean(scopeUploadRetentionClass(scope)) && policy.networkEnabled,
        })
      } catch (error) {
        try { await assetSession?.close?.() } catch { /* best-effort failed-session close */ }
        throw error
      }
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
    // Retain visible artwork with the media it identifies.
    await retainPublicationArtwork({ manifest, entityRef, publicationId })
    return result
  }

  async function releaseAuthorizedRendition ({
    renditionId,
    ownerId: requestedOwnerId,
    assetId: requestedAssetId,
  } = {}) {
    const id = String(renditionId || '')
    const assetId = requestedAssetId === undefined
      ? null
      : hex32(requestedAssetId, 'assetId')
    const retained = renditions.get(id)
    if (!retained) {
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
    if (assetId && retained.scope.assetId !== assetId) {
      fail('retained rendition asset identity mismatch')
    }
    const requestedOwnerIds = requestedOwnerId === undefined
      ? new Set(retained.owners.keys())
      : new Set([String(requestedOwnerId)])
    const requestedAuthorizationIds = new Set([...requestedOwnerIds].map(ownerId =>
      assetAuthorizationId(id, ownerId)))
    const remainingAuthorizations = [...(retained.scope.assetAuthorizations?.entries() || [])]
      .filter(([authorizationId]) => !requestedAuthorizationIds.has(authorizationId))
    const scopeRangeStillOwned = remainingAuthorizations.some(([, authorization]) =>
      authorization.range.start === retained.scope.range.start &&
      authorization.range.end === retained.scope.range.end)
    const revokeDependentOwners = remainingAuthorizations.length > 0 && !scopeRangeStillOwned
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

  function activeAssetPeers (scope) {
    return [...scope.sessions.values()].filter(session =>
      !session.closed && (session.state === 'active' || session.protocol?.state === 'active') && !session.channel?.closed)
  }

  function normalizeAssetPeerIds (peerIds) {
    if (peerIds === undefined) return null
    if (!Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > MAX_ASSET_PEERS_PER_REQUEST) {
      fail('asset peerIds are out of bounds')
    }
    const normalized = peerIds.map(boundedAssetPeerId)
    if (new Set(normalized).size !== normalized.length) fail('asset peerIds must be unique')
    return normalized.sort()
  }

  function mapAssetSessionError (scope, error) {
    if (error?.name === 'AbortError') return error
    if (scope && (!scope.assetSession.core || scope.assetSession.poisoned)) {
      return assetTransportError('QUARANTINED', null, 'asset core was quarantined', error)
    }
    if (String(error?.message || '').includes('unavailable')) {
      return assetTransportError('UNAVAILABLE', null, 'verified asset block is unavailable', error)
    }
    return error
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

  function getActiveAssetPeerIds ({ assetId } = {}) {
    if (policy.status !== 'active' || !policy.networkEnabled) fail('runtime is not active')
    return activeAssetPeers(activeAssetScope(assetId)).map(peer => peer.peerId).sort()
  }

  async function listAssetRanges ({ assetId, cursor = null, limit } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    const scope = activeAssetScope(assetId)
    return scope.assetSession.listAssetRanges({ cursor, limit })
  }

  async function listPeerAssetRanges ({ assetId, peerId, cursor = null, limit, signal } = {}) {
    if (policy.status !== 'active' || !policy.networkEnabled) fail('runtime is not active')
    const scope = activeAssetScope(assetId)
    const id = boundedAssetPeerId(peerId)
    const session = scope.sessions.get(id)
    if (!session || session.closed || session.state !== 'active' || session.channel?.closed) {
      throw assetTransportError('UNAVAILABLE', id, 'asset peer is not active')
    }
    if (session.assetInventoryRequest) {
      throw assetTransportError('UNAVAILABLE', id, 'asset inventory request is already pending')
    }
    if (signal?.aborted) throw assetAbortError(id, 'asset inventory request aborted')
    const payload = encodeAssetRangeSummaryRequest({
      assetId: scope.assetId,
      cursor,
      limit,
    })
    const normalized = decodeAssetRangeSummaryRequest(payload, {
      coreLength: scope.assetSession.coreRef.length,
    })
    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    const request = {
      cursor: normalized.cursor,
      limit: normalized.limit,
      signal,
      timer: null,
      closed: false,
      onAbort: null,
      resolve,
      reject,
    }
    request.onAbort = () => {
      if (!closeAssetInventoryRequest(
        session,
        request,
        assetAbortError(id, 'asset inventory request aborted'),
      )) return
      closeSession(scope, id, 'asset-inventory-aborted', session)
    }
    session.assetInventoryRequest = request
    signal?.addEventListener?.('abort', request.onAbort, { once: true })
    request.timer = setTimeout(() => {
      if (!closeAssetInventoryRequest(
        session,
        request,
        assetTransportError('TIMEOUT', id, 'asset inventory request timed out'),
      )) return
      closeSession(scope, id, 'asset-inventory-timeout', session)
    }, assetTransferTimeoutMs)
    if (signal?.aborted) {
      request.onAbort()
      return promise
    }
    try {
      if (!sendScopedFrame(session, 'asset', 'asset-range-summary-request', payload)) {
        closeAssetInventoryRequest(
          session,
          request,
          assetTransportError('UNAVAILABLE', id, 'asset inventory request could not be sent'),
        )
      }
    } catch (cause) {
      closeAssetInventoryRequest(
        session,
        request,
        assetTransportError('UNAVAILABLE', id, 'asset inventory request could not be sent', cause),
      )
    }
    return promise
  }

  async function hasVerifiedAssetBlock ({ assetId, blockIndex, signal } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    if (signal?.aborted) throw assetAbortError(null, 'asset block possession check aborted')
    const scope = activeAssetScope(assetId)
    const isActive = () => policy.status === 'active' && !scope.closed && !signal?.aborted
    try {
      return await scope.assetSession.hasVerifiedBlock(blockIndex, { isActive })
    } catch (error) {
      if (signal?.aborted) throw assetAbortError(null, 'asset block possession check aborted')
      throw mapAssetSessionError(scope, error)
    }
  }

  async function readVerifiedAssetBlock ({ assetId, blockIndex, signal } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    if (signal?.aborted) throw assetAbortError(null, 'asset block read aborted')
    const scope = activeAssetScope(assetId)
    const isActive = () => policy.status === 'active' && !scope.closed && !signal?.aborted
    try {
      return await scope.assetSession.readVerifiedBlock(blockIndex, { isActive })
    } catch (error) {
      if (signal?.aborted) throw assetAbortError(null, 'asset block read aborted')
      throw mapAssetSessionError(scope, error)
    }
  }

  async function requestAssetBlocks ({ assetId, startBlock, endBlock, peerIds, requirePeerEvidence = false, signal } = {}) {
    if (policy.status !== 'active' || !policy.networkEnabled) fail('runtime is not active')
    if (typeof requirePeerEvidence !== 'boolean') fail('requirePeerEvidence must be a boolean')
    const cancellation = { aborted: signal?.aborted === true, request: null, scope: null }
    if (cancellation.aborted) throw assetAbortError()
    const onAbort = () => {
      cancellation.aborted = true
      if (cancellation.request) closeAssetRequest(cancellation.scope, cancellation.request, assetAbortError())
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const detachAbort = () => signal?.removeEventListener?.('abort', onAbort)

    let scope
    let range
    let selectedPeerIds
    const verified = new Set()
    const remaining = new Set()
    try {
      scope = activeAssetScope(assetId)
      cancellation.scope = scope
      selectedPeerIds = normalizeAssetPeerIds(peerIds)
      const transferId = allocateAssetTransferId()
      range = decodeAssetBlockRequest(encodeAssetBlockRequest({
        assetId: scope.assetId,
        transferId,
        startBlock,
        endBlock,
      }), { coreLength: scope.assetSession.coreRef.length })
      if (range.startBlock < scope.range.start || range.endBlock > scope.range.end) {
        fail('asset block request is outside the authorized range')
      }
      if (scope.assetRequests.size >= MAX_ASSET_BLOCKS_PER_REQUEST) {
        fail('active asset request limit exceeded')
      }
      const scanActive = () => !cancellation.aborted &&
        policy.status === 'active' &&
        policy.networkEnabled &&
        !scope.closed
      for (let index = range.startBlock; index < range.endBlock; index++) {
        if (!scanActive()) throw cancellation.aborted ? assetAbortError() : new Error('asset block request is closed')
        const present = await scope.assetSession.hasVerifiedBlock(index, { isActive: scanActive })
        if (!scanActive()) throw cancellation.aborted ? assetAbortError() : new Error('asset block request is closed')
        if (present) verified.add(index)
        if (!present || requirePeerEvidence) remaining.add(index)
      }
      if (remaining.size === 0) {
        if (cancellation.aborted) throw assetAbortError()
        detachAbort()
        return {
          verifiedBlockIndexes: [...verified],
          peerIds: [],
        }
      }
    } catch (error) {
      detachAbort()
      if (cancellation.aborted && error?.name !== 'AbortError') throw assetAbortError()
      throw mapAssetSessionError(scope, error)
    }

    const activePeers = activeAssetPeers(scope)
    const selectedSet = selectedPeerIds ? new Set(selectedPeerIds) : null
    const peers = selectedSet
      ? activePeers.filter(peer => selectedSet.has(peer.peerId))
      : activePeers
    if (peers.length === 0) {
      detachAbort()
      const unavailablePeerId = selectedPeerIds?.length === 1 ? selectedPeerIds[0] : null
      throw assetTransportError('UNAVAILABLE', unavailablePeerId, 'asset scope has no selected active peers')
    }
    if (cancellation.aborted) {
      detachAbort()
      throw assetAbortError()
    }

    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    // Mark the promise handled before an in-memory peer can reject re-entrantly.
    void promise.catch(() => {})
    const request = {
      key: range.transferId,
      transferId: range.transferId,
      startBlock: range.startBlock,
      endBlock: range.endBlock,
      remaining,
      verified,
      peerIds: new Set(),
      requestedPeers: new Set(),
      failedPeers: new Set(),
      peerFailures: new Map(),
      transfers: new Map(),
      signal,
      onAbort,
      timer: null,
      closed: false,
      resolve,
      reject,
    }
    request.timer = setTimeout(() => {
      const timedOutPeerId = request.requestedPeers.size === 1
        ? request.requestedPeers.values().next().value
        : null
      closeAssetRequest(scope, request, assetTransportError(
        'TIMEOUT',
        timedOutPeerId,
        'asset block request timed out',
      ))
    }, assetTransferTimeoutMs)
    scope.assetRequests.set(request.key, request)
    cancellation.request = request
    if (cancellation.aborted || signal?.aborted) {
      closeAssetRequest(scope, request, assetAbortError())
      return promise
    }

    const payload = encodeAssetBlockRequest({
      assetId: scope.assetId,
      transferId: request.transferId,
      startBlock: range.startBlock,
      endBlock: range.endBlock,
    })
    // Register every target before sending because peers may answer re-entrantly.
    for (const peer of peers) request.requestedPeers.add(peer.peerId)
    try {
      for (const peer of peers) {
        if (request.closed) break
        if (!sendScopedFrame(peer, 'asset', 'asset-block-request', payload)) {
          request.requestedPeers.delete(peer.peerId)
        }
      }
    } catch (cause) {
      const peerId = peers.length === 1 ? peers[0].peerId : null
      closeAssetRequest(scope, request, assetTransportError(
        'UNAVAILABLE',
        peerId,
        'asset block request could not be sent',
        cause,
      ))
      return promise
    }
    if (request.requestedPeers.size === 0) {
      const peerId = peers.length === 1 ? peers[0].peerId : null
      closeAssetRequest(scope, request, assetTransportError(
        'UNAVAILABLE',
        peerId,
        'asset block request could not be sent',
      ))
    }
    return promise
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

  async function retainAuthorizedArchive ({ pledge, coreKey: requestedCoreKey, start, end, download: shouldDownload = true } = {}) {
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
    const archiveId = verified.pledgeId
    const resourceId = `${archiveId}:${coreKey}:${range.start}:${range.end}`
    const existing = archives.get(resourceId)
    if (existing) return { ...existing.result, status: 'already-retained' }
    if (!store?.get) fail('corestore is unavailable')
    const core = store.get({ key: b4a.from(coreKey, 'hex') })
    let releaseArchiveProtection = null
    try {
      if (typeof options.retainArchiveCore === 'function') {
        const release = options.retainArchiveCore({ archiveId, coreKey, start: range.start, end: range.end })
        if (typeof release === 'function') releaseArchiveProtection = release
      }
      await core.ready?.()
      const download = shouldDownload === false
        ? null
        : core.download?.({ start: range.start, end: range.end }) || null
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
      const resource = {
        resourceId,
        archiveId,
        coreKey,
        core,
        download,
        range,
        mode,
        nextIndex: shouldDownload === false ? range.end : range.start,
        releaseArchiveProtection,
      }
      resource.blockSource = {
        resourceId: coreKey,
        length: range.end,
        async apply({ index, proof, value, isActive }) {
          if (!isActive()) throw new Error('archive block request is closed')
          try {
            const applied = await core.applyProof({ ...proof, block: { ...proof.block, value } })
            if (applied !== true) throw new Error('core.applyProof rejected the archive block')
            if (!await core.has(index)) throw new Error('verified archive block was not committed')
          } catch (cause) {
            resource.quarantined = true
            await core.close?.()
            throw new Error('archive block proof verification failed', { cause })
          }
        },
      }
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
      try { await core.close?.() } catch { /* best-effort failed-retention core close */ }
      throw error
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
        proof.block.value.byteLength === 0 || proof.block.value.byteLength > MAX_ASSET_BLOCK_BYTES) {
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
          proof.block.value.byteLength === 0 || proof.block.value.byteLength > MAX_ASSET_BLOCK_BYTES) return false
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
    for (const session of scope.sessions.values()) cancelAssetSummaryScan(session)
    for (const request of [...(scope.assetRequests?.values() || [])]) {
      closeAssetRequest(scope, request, new Error('asset scope was released'))
    }
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
    assetTransportError, closeAssetInventoryRequest, cancelAssetSummaryScan, failAssetRequestPeer,
    queueArchiveRetry, clearArchiveTimer, startArchivePumpWhenOpen, sendAssetError,
    handleAssetFrame, handleArchiveFrame, pumpArchiveSessions, prepareScopeClose, finalizeScopeClose,
    retainAuthorizedRendition, releaseAuthorizedRendition, listAssetRanges, getActiveAssetSession,
    getActiveAssetPeerIds, listPeerAssetRanges, hasVerifiedAssetBlock, readVerifiedAssetBlock,
    requestAssetBlocks, revalidateRetainedRenditions, retainArchiveDiscovery, releaseArchiveDiscovery,
    publishArchiveRequest, publishArchivePledge, publishArchiveChallenge, publishArchiveChallengeProof,
    retainAuthorizedArchive, releaseAuthorizedArchive, createAuthorizedArchiveChallengeProof,
    verifyAuthorizedArchiveChallengeProof,
  }
}
