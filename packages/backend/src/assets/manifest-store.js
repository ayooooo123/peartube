import { requiredRangesForRendition } from './availability.js'
import { verifyPublicationManifest } from './manifest.js'
import { isArtworkRendition, normalizeAssetCoreRefV2 } from './rendition.js'
import { toHex } from '../publisher/canonical.js'

function signerHex(value) {
  return Buffer.from(value).toString('hex')
}

function append(map, key, publicationId) {
  const rows = map.get(key) || []
  if (!rows.includes(publicationId)) rows.push(publicationId)
  map.set(key, rows)
}

function cloneManifest(manifest) {
  return manifest
}

export function createAssetManifestStore(options = {}) {
  const trustedSigners = new Set((options.trustedSigners || []).map(signerHex))
  const verifyManifest = typeof options.verifyManifest === 'function'
    ? options.verifyManifest
    : (manifest, verifyOptions) => verifyPublicationManifest(manifest, verifyOptions)
  const byPublication = new Map()
  const byPublisherSequence = new Map()
  const byRendition = new Map()
  const byAssetId = new Map()
  const bySupersession = new Map()
  const currentByPublisher = new Map()
  const quarantined = []

  function rows(ids = []) {
    return ids.map(id => byPublication.get(id)).filter(Boolean).map(cloneManifest)
  }

  return {
    async ingestManifest(manifest) {
      const publicationId = manifest?.publicationId
      if (!publicationId) return { status: 'quarantined' }
      const existing = byPublication.get(publicationId)
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(manifest)) return { status: 'duplicate', publicationId }
        return { status: 'conflict', publicationId }
      }
      const allowedSigners = Array.from(trustedSigners)
      const ok = await verifyManifest(manifest, { allowedSigners })
      if (!ok) {
        quarantined.push(manifest)
        return { status: 'quarantined' }
      }

      byPublication.set(publicationId, manifest)
      const publisherId = manifest.body.publisherId
      byPublisherSequence.set(`${publisherId}:${manifest.body.sequence}`, publicationId)
      const renditions = [
        ...(manifest.body.renditions || []),
        ...(manifest.body.artwork || []),
        ...(manifest.body.subtitles || []),
      ]
      for (const rendition of renditions) {
        append(byRendition, rendition.renditionId, publicationId)
        append(byAssetId, rendition.core.assetId, publicationId)
      }
      if (manifest.body.previousManifestId) append(bySupersession, manifest.body.previousManifestId, publicationId)

      const current = currentByPublisher.get(publisherId)
      const currentManifest = current ? byPublication.get(current) : null
      if (!currentManifest || manifest.body.sequence > currentManifest.body.sequence || (manifest.body.sequence === currentManifest.body.sequence && publicationId < current)) {
        currentByPublisher.set(publisherId, publicationId)
      }
      return { status: 'accepted', publicationId }
    },

    getManifest(publicationId) {
      return byPublication.get(publicationId) || null
    },

    /**
     * The immutable rendition a consumer must actually receive, plus the block
     * ranges a peer has to advertise and prove. Availability is assessed
     * against this, never against the publisher's claimed status.
     */
    getRenditionRequirement(publicationId, renditionId = null) {
      const manifest = byPublication.get(publicationId)
      if (!manifest) return null
      const rendition = (manifest.body?.renditions || []).find(candidate => (
        candidate &&
        candidate.blocked !== true &&
        candidate.superseded !== true &&
        typeof candidate.renditionId === 'string' &&
        candidate.renditionId.length > 0 &&
        // Asked for by id, artwork answers for itself. Choosing on its own,
        // this is picking the media a viewer came for, never its cover.
        (renditionId == null ? !isArtworkRendition(candidate) : candidate.renditionId === renditionId)
      ))
      if (!rendition) return null
      let coreRef
      try {
        coreRef = normalizeAssetCoreRefV2(rendition.core)
      } catch {
        coreRef = null
      }
      const coreKey = coreRef?.key || (rendition.core?.key ? toHex(rendition.core.key, 32) : null)
      const coreLength = coreRef?.length ?? (Number(rendition.core?.length) || 0)
      return {
        publicationId,
        renditionId: rendition.renditionId,
        coreKey,
        coreLength,
        requiredRanges: requiredRangesForRendition(rendition),
      }
    },

    getManifestByPublisherSequence(publisherId, sequence) {
      return byPublication.get(byPublisherSequence.get(`${publisherId}:${sequence}`)) || null
    },

    getManifestsByRendition(renditionId) {
      return rows(byRendition.get(renditionId) || [])
    },

    getManifestsByAssetId(assetId) {
      return rows(byAssetId.get(assetId) || [])
    },

    getSupersedingManifests(manifestId) {
      return rows(bySupersession.get(manifestId) || [])
    },

    getCurrentPublisherHead(publisherId) {
      return byPublication.get(currentByPublisher.get(publisherId)) || null
    },

    getQuarantinedManifests() {
      return quarantined.slice()
    },
  }
}
