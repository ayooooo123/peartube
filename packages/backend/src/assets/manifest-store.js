import { verifyPublicationManifest } from './manifest.js'

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
  const byPublication = new Map()
  const byPublisherSequence = new Map()
  const byRendition = new Map()
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
      const ok = await verifyPublicationManifest(manifest, { allowedSigners })
      if (!ok) {
        quarantined.push(manifest)
        return { status: 'quarantined' }
      }

      byPublication.set(publicationId, manifest)
      const publisherId = manifest.body.publisherId
      byPublisherSequence.set(`${publisherId}:${manifest.body.sequence}`, publicationId)
      for (const rendition of manifest.body.renditions || []) append(byRendition, rendition.renditionId, publicationId)
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

    getManifestByPublisherSequence(publisherId, sequence) {
      return byPublication.get(byPublisherSequence.get(`${publisherId}:${sequence}`)) || null
    },

    getManifestsByRendition(renditionId) {
      return rows(byRendition.get(renditionId) || [])
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
