import { normalizeAssetCoreRefV2 } from '../assets/rendition.js'

const HEX_32 = /^[0-9a-f]{64}$/
const ALLOWED_STATUS_FIELDS = Object.freeze([
  'capacityBytes',
  'maxRequestBytes',
  'reservedBytes',
  'availableBytes',
  'acceptedRequests',
  'knownRequests',
  'receivedPledges',
  'randomRejections',
  'capacityRejections',
  'authorizationRejections',
])

function statusFailure(errorCode) {
  return {
    success: false,
    enabled: false,
    capacityBytes: 0,
    maxRequestBytes: 0,
    reservedBytes: 0,
    availableBytes: 0,
    acceptedRequests: 0,
    knownRequests: 0,
    receivedPledges: 0,
    randomRejections: 0,
    capacityRejections: 0,
    authorizationRejections: 0,
    acceptancePermille: 0,
    errorCode,
  }
}

function requestFailure(errorCode) {
  return { success: false, status: 'failed', requestId: '', errorCode }
}

function hasOnlyFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(field => fields.has(field))
}

function statusResponse(status = {}) {
  const response = {
    success: true,
    enabled: status.enabled === true,
  }
  for (const field of ALLOWED_STATUS_FIELDS) {
    const value = Number(status[field])
    response[field] = Number.isSafeInteger(value) && value >= 0 ? value : 0
  }
  const probability = Number(status.acceptanceProbability)
  response.acceptancePermille = Number.isFinite(probability)
    ? Math.max(0, Math.min(1000, Math.round(probability * 1000)))
    : 0
  return response
}

export function createArchiveParticipationApi(options = {}) {
  const archiveNetwork = options.archiveNetwork || null
  const manifestStore = options.manifestStore || null

  return Object.freeze({
    async getArchiveParticipation(request = {}) {
      if (!hasOnlyFields(request, new Set())) return statusFailure('ARCHIVE_REQUEST_INVALID')
      if (!archiveNetwork?.getStatus) return statusFailure('ARCHIVE_NETWORK_UNAVAILABLE')
      try {
        return statusResponse(archiveNetwork.getStatus())
      } catch {
        return statusFailure('ARCHIVE_STATUS_FAILED')
      }
    },

    async setArchiveParticipation(request = {}) {
      const fields = new Set(['enabled', 'capacityBytes', 'maxRequestBytes', 'acceptancePermille'])
      if (!hasOnlyFields(request, fields) || typeof request.enabled !== 'boolean' ||
          !Number.isSafeInteger(request.capacityBytes) || request.capacityBytes < 0 ||
          !Number.isSafeInteger(request.maxRequestBytes) || request.maxRequestBytes < 0 ||
          !Number.isSafeInteger(request.acceptancePermille) || request.acceptancePermille < 0 || request.acceptancePermille > 1000) {
        return statusFailure('ARCHIVE_PARTICIPATION_INVALID')
      }
      if (!archiveNetwork?.setParticipation) return statusFailure('ARCHIVE_NETWORK_UNAVAILABLE')
      try {
        const policy = {
          enabled: request.enabled,
          capacityBytes: request.capacityBytes,
          maxRequestBytes: request.maxRequestBytes,
          acceptanceProbability: request.acceptancePermille / 1000,
        }
        return statusResponse(await archiveNetwork.setParticipation(policy))
      } catch {
        return statusFailure('ARCHIVE_PARTICIPATION_FAILED')
      }
    },

    async requestArchivePublication(request = {}) {
      const fields = new Set(['publicationId', 'renditionId', 'retentionUntil'])
      if (!hasOnlyFields(request, fields) || !HEX_32.test(request.publicationId || '') || !HEX_32.test(request.renditionId || '') ||
          (request.retentionUntil !== undefined && (!Number.isSafeInteger(request.retentionUntil) || request.retentionUntil < 1))) {
        return requestFailure('ARCHIVE_REQUEST_INVALID')
      }
      if (!archiveNetwork?.requestArchive) return requestFailure('ARCHIVE_NETWORK_UNAVAILABLE')
      try {
        const manifest = await manifestStore?.getManifest?.(request.publicationId)
        if (!manifest) return requestFailure('ARCHIVE_PUBLICATION_NOT_FOUND')
        const rendition = manifest.body?.renditions?.find(candidate => candidate.renditionId === request.renditionId)
        let core
        try {
          core = normalizeAssetCoreRefV2(rendition?.core)
        } catch {
          return requestFailure('ARCHIVE_RENDITION_NOT_FOUND')
        }
        const result = await archiveNetwork.requestArchive({
          publicationId: request.publicationId,
          renditionId: request.renditionId,
          ranges: [{ coreKey: core.key, start: 0, end: core.length }],
          requestedBytes: core.byteLength,
          ...(request.retentionUntil === undefined ? {} : { retentionUntil: request.retentionUntil }),
        })
        return {
          success: result?.status === 'published',
          status: String(result?.status || 'failed'),
          requestId: String(result?.requestId || ''),
          ...(result?.status === 'published' ? {} : { errorCode: 'ARCHIVE_REQUEST_FAILED' }),
        }
      } catch {
        return requestFailure('ARCHIVE_REQUEST_FAILED')
      }
    },
    async reannounceArchiveRequests() {
      if (!archiveNetwork?.reannounceLocalRequests) return { success: false, reannounced: 0 }
      try {
        const result = await archiveNetwork.reannounceLocalRequests()
        return { success: result?.status === 'ok', reannounced: Number(result?.reannounced) || 0 }
      } catch {
        return { success: false, reannounced: 0 }
      }
    },
  })
}
