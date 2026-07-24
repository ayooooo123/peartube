import b4a from 'b4a'

import { hashCanonical } from '../publisher/canonical.js'

function hexDigest(domain, body) {
  return b4a.toString(hashCanonical(domain, body), 'hex')
}

function normalizePublisherId(value) {
  const text = String(value || '')
  return /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : hexDigest('peartube.legacy.publisher.v1', { value: text || 'unknown' })
}

function normalizeVideo(video = {}, index = 0) {
  const legacySourceId = String(video.id || video.videoId || `legacy-${index}`)
  return {
    legacySourceId,
    title: video.title || null,
    deleted: video.deleted === true,
    contentHash: video.contentHash || video.hash || null,
    blobRef: video.blobRef || null,
    thumbnail: video.thumbnail || null,
    source: video.source || 'legacy-channel',
  }
}

export function migratePublicationV1(legacy = {}, options = {}) {
  const publisherId = normalizePublisherId(legacy.ownerPublisherId || legacy.publisherId || legacy.channelKey)
  const videos = (legacy.videos || []).map(normalizeVideo)
  const completed = new Set(options.checkpoint?.completedLegacySourceIds || [])
  const publications = []
  const claims = []
  const startIndex = options.checkpoint ? 0 : 0
  let processed = 0

  for (let i = startIndex; i < videos.length; i++) {
    const video = videos[i]
    if (completed.has(video.legacySourceId)) continue
    const basis = { publisherId, legacySourceId: video.legacySourceId, contentHash: video.contentHash, tombstone: video.deleted === true }
    const publicationId = hexDigest('peartube.publication-v1.import.publication-id.v1', basis)
    const publication = {
      publicationId,
      publisherId,
      legacySourceId: video.legacySourceId,
      title: video.title,
      tombstone: video.deleted === true,
      contentHash: video.contentHash,
      blobRef: video.blobRef,
      thumbnail: video.thumbnail,
      entityRef: null,
      agentRef: null,
      provenance: { source: video.source, legacySourceId: video.legacySourceId },
    }
    publications.push(publication)
    claims.push({
      claimId: hexDigest('peartube.publication-v1.import.claim-id.v1', { publicationId, kind: publication.tombstone ? 'legacy-tombstone' : 'legacy-publication' }),
      publicationId,
      kind: publication.tombstone ? 'legacy-tombstone' : 'legacy-publication',
      provenance: publication.provenance,
    })
    completed.add(video.legacySourceId)
    processed++
    if (options.stopAfter && processed >= options.stopAfter) break
  }

  if (options.checkpoint) {
    for (const video of videos) {
      if (!completed.has(video.legacySourceId)) continue
      const basis = { publisherId, legacySourceId: video.legacySourceId, contentHash: video.contentHash, tombstone: video.deleted === true }
      const publicationId = hexDigest('peartube.publication-v1.import.publication-id.v1', basis)
      if (!publications.some(p => p.publicationId === publicationId)) {
        publications.push({ publicationId, publisherId, legacySourceId: video.legacySourceId, title: video.title, tombstone: video.deleted === true, contentHash: video.contentHash, blobRef: video.blobRef, thumbnail: video.thumbnail, entityRef: null, agentRef: null, provenance: { source: video.source, legacySourceId: video.legacySourceId } })
        claims.push({ claimId: hexDigest('peartube.publication-v1.import.claim-id.v1', { publicationId, kind: video.deleted === true ? 'legacy-tombstone' : 'legacy-publication' }), publicationId, kind: video.deleted === true ? 'legacy-tombstone' : 'legacy-publication', provenance: { source: video.source, legacySourceId: video.legacySourceId } })
      }
    }
  }

  return { publisherId, publications, claims, checkpoint: { completedLegacySourceIds: Array.from(completed).sort() } }
}
