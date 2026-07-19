import b4a from 'b4a'
import sodium from 'sodium-universal'

const KEY_PATTERN = /^[0-9a-f]{64}$/
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/
const PROJECTABLE_STATES = new Set(['durabilityVerified', 'published'])

function normalizeKey(value, name) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new Error(`${name} must be a 64-character hexadecimal key`)
  }
  return value.toLowerCase()
}

function canonicalClaimants(videos) {
  return (videos || [])
    .filter((video) => video && typeof video.id === 'string' && video.id.length > 0)
    .map((video) => {
      const row = {
        videoId: video.id,
        identityKey: video.importIdentityKey || null,
        claimantId: video.importClaimantId || null,
      }
      return {
        row,
        videoId: b4a.from(row.videoId),
        identityKey: b4a.from(String(row.identityKey || '')),
        claimantId: b4a.from(String(row.claimantId || '')),
      }
    })
    .sort((left, right) =>
      b4a.compare(left.videoId, right.videoId) ||
      b4a.compare(left.identityKey, right.identityKey) ||
      b4a.compare(left.claimantId, right.claimantId))
    .map(({ row }) => row)
}

function revisionForVideos(videos) {
  const payload = b4a.from(JSON.stringify(canonicalClaimants(videos)))
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, payload)
  return `sha256:${b4a.toString(digest, 'hex')}`
}

function manifestRevisionNumber(revision) {
  return REVISION_PATTERN.test(revision) ? Number.parseInt(revision.slice(7, 19), 16) : 0
}

function projectStages(input) {
  const staged = {}
  for (const field of ['stagedDescriptor', 'stagedProfile', 'stagedSources', 'stagedArtwork']) {
    if (input[field] !== undefined) staged[field] = input[field]
  }
  return staged
}

function assertLogicalVideo(video, videoId) {
  if (!video) throw new Error(`Private logical video not found: ${videoId}`)
  if (video.canonicalVisibility === 'suppressed') {
    throw new Error(`Private logical video is suppressed: ${videoId}`)
  }
  return video
}

async function assertExactClaim(channel, video) {
  const hasIdentity = typeof video.importIdentityKey === 'string' && video.importIdentityKey.length > 0
  const hasClaimant = typeof video.importClaimantId === 'string' && video.importClaimantId.length > 0
  if (hasIdentity !== hasClaimant) throw new Error(`Video ${video.id} has an incomplete import claim binding`)
  if (!hasIdentity) return null
  if (typeof channel.resolveImportClaim !== 'function') {
    throw new Error(`Import claim evidence is unavailable for video ${video.id}`)
  }
  const winner = await channel.resolveImportClaim(video.importIdentityKey)
  if (
    !winner ||
    winner.identityKey !== video.importIdentityKey ||
    winner.claimantId !== video.importClaimantId ||
    winner.videoId !== video.id
  ) {
    throw new Error(`Video ${video.id} is not the exact winning import claim`)
  }
  return winner
}

function assertPublicBinding(video, privateVideo) {
  if (!video) throw new Error(`Public video is unavailable: ${privateVideo.id}`)
  if (video.id !== privateVideo.id) throw new Error(`Public video identity mismatch: ${privateVideo.id}`)
  if (
    (video.importIdentityKey || null) !== (privateVideo.importIdentityKey || null) ||
    (video.importClaimantId || null) !== (privateVideo.importClaimantId || null)
  ) {
    throw new Error(`Public claim binding mismatch for video ${privateVideo.id}`)
  }
}

async function readProjectablePublicVideo(publicBee, privateVideo) {
  if (!publicBee || typeof publicBee.getVideoWithStatus !== 'function') {
    throw new Error('Public projection status is unavailable')
  }
  const result = await publicBee.getVideoWithStatus(privateVideo.id)
  if (result?.status === 'uncertain') throw new Error(`Public projection is uncertain for video ${privateVideo.id}`)
  if (result?.status !== 'found' || !result.video) {
    throw new Error(`Public video is not projectable: ${privateVideo.id}`)
  }
  assertPublicBinding(result.video, privateVideo)
  if (!PROJECTABLE_STATES.has(result.video.publicationState)) {
    throw new Error(`Public video has invalid publication state: ${privateVideo.id}`)
  }
  return result.video
}

function channelIdentity(channel) {
  return normalizeKey(channel?.keyHex, 'Channel key')
}

function publicBeeIdentity(channel) {
  return normalizeKey(channel?.publicBee?.keyHex || channel?.publicBeeKey, 'Public Bee key')
}

function assertRequestedIdentity(channel, channelKey, publicBeeKey) {
  const expectedChannelKey = channelIdentity(channel)
  const expectedPublicBeeKey = publicBeeIdentity(channel)
  if (normalizeKey(channelKey, 'Channel key') !== expectedChannelKey) {
    throw new Error('Channel key does not match the active channel')
  }
  if (normalizeKey(publicBeeKey, 'Public Bee key') !== expectedPublicBeeKey) {
    throw new Error('Public Bee key does not match the active channel')
  }
  return { channelKey: expectedChannelKey, publicBeeKey: expectedPublicBeeKey }
}

function snapshotVideos(videos) {
  return [...(videos || [])]
    .filter((video) => video?.canonicalVisibility !== 'suppressed')
    .sort((left, right) =>
      Number(right.uploadedAt || 0) - Number(left.uploadedAt || 0) ||
      String(left.id).localeCompare(String(right.id)))
}

/**
 * Compose the durable private channel, canonical PublicBee projection, and
 * stable public-feed snapshot into one replay-safe publication boundary.
 */
export function createContentPublication({ channel, publicFeed } = {}) {
  if (!channel || typeof channel.getVideo !== 'function') throw new Error('A private channel is required')
  if (!publicFeed || typeof publicFeed.upsertChannelSnapshot !== 'function') {
    throw new Error('A stable PublicFeed snapshot writer is required')
  }

  let operationTail = Promise.resolve()
  const enqueue = (operation) => {
    const current = operationTail.then(operation, operation)
    operationTail = current.catch(() => {})
    return current
  }

  const reconcile = async ({ channelKey, publicBeeKey, requiredVideoId = null }) => {
    const identity = assertRequestedIdentity(channel, channelKey, publicBeeKey)
    if (channel.publicProjectionActive === false) {
      return { status: 'deferred', revision: null, changed: false, videos: [] }
    }
    const publicBee = channel.publicBee
    if (!publicBee?.writable || typeof publicBee.reconcileCanonicalClaims !== 'function') {
      throw new Error('Writable PublicBee claim reconciliation is unavailable')
    }
    if (typeof publicBee.getVerifiedRootDescriptor !== 'function') {
      throw new Error('Verified public projection root descriptor access is unavailable')
    }
    const readVerifiedRootDescriptor = async () => {
      const signed = await publicBee.getVerifiedRootDescriptor(identity)
      const descriptor = signed?.descriptor
      if (
        descriptor?.channelId !== identity.channelKey ||
        descriptor?.metadataKey !== identity.publicBeeKey
      ) {
        throw new Error('Verified public projection root descriptor binding is unavailable')
      }
      return signed
    }
    await readVerifiedRootDescriptor()

    const result = await publicBee.reconcileCanonicalClaims(channel, { revisionForVideos })
    if (result?.status !== 'authoritative') {
      throw new Error(`Canonical claim reconciliation is ${result?.status || 'uncertain'}`)
    }
    if (!REVISION_PATTERN.test(result.revision || '')) {
      throw new Error('Canonical claim reconciliation revision is unavailable')
    }
    const videos = snapshotVideos(result.videos)
    if (requiredVideoId && !videos.some((video) => video.id === requiredVideoId)) {
      throw new Error(`Video ${requiredVideoId} is not a visible canonical winner`)
    }

    const [metadata, profile, signedDescriptor] = await Promise.all([
      typeof publicBee.getMetadata === 'function' ? publicBee.getMetadata() : null,
      typeof publicBee.getChannelProfile === 'function' ? publicBee.getChannelProfile() : null,
      readVerifiedRootDescriptor(),
    ])
    const snapshot = {
      ...identity,
      revision: result.revision,
      channelName: profile?.name || metadata?.name || null,
      videoCount: videos.length,
      manifestUpdatedAt: manifestRevisionNumber(result.revision),
      previewVideos: videos,
      videoIds: videos.map((video) => video.id).sort(),
      signedDescriptor,
    }
    const feedResult = await publicFeed.upsertChannelSnapshot(snapshot)
    return {
      status: 'authoritative',
      revision: result.revision,
      changed: result.revisionChanged === true || feedResult?.changed === true,
      videos,
      snapshot: feedResult?.snapshot || snapshot,
    }
  }

  return {
    markDurabilityVerified(videoId) {
      return enqueue(async () => {
        const video = assertLogicalVideo(await channel.getVideo(videoId), videoId)
        if (video.publicationState === 'durabilityVerified' || video.publicationState === 'published') {
          return video
        }
        if (video.publicationState !== 'replicationPending') {
          throw new Error(`Video ${videoId} has an invalid publication state`)
        }
        await channel.updateVideo(videoId, { publicationState: 'durabilityVerified' }, { syncPublic: false })
        return channel.getVideo(videoId)
      })
    },

    project(input = {}) {
      return enqueue(async () => {
        const videoId = input?.videoId
        const video = assertLogicalVideo(await channel.getVideo(videoId), videoId)
        if (!PROJECTABLE_STATES.has(video.publicationState)) {
          throw new Error(`Video ${videoId} has not passed durability verification`)
        }
        await assertExactClaim(channel, video)
        if (typeof channel.activatePublicProjection !== 'function') {
          throw new Error('Deferred public projection activation is unavailable')
        }
        const publicBeeKey = await channel.activatePublicProjection(projectStages(input))
        const refreshed = assertLogicalVideo(await channel.getVideo(videoId), videoId)
        await assertExactClaim(channel, refreshed)
        await readProjectablePublicVideo(channel.publicBee, refreshed)
        return { channelKey: channelIdentity(channel), publicBeeKey: normalizeKey(publicBeeKey || publicBeeIdentity(channel), 'Public Bee key'), videoId }
      })
    },

    announce({ channelKey, publicBeeKey, videoId } = {}) {
      return enqueue(async () => {
        assertRequestedIdentity(channel, channelKey, publicBeeKey)
        if (channel.publicProjectionActive === false) throw new Error('The channel public projection is not active')
        const video = assertLogicalVideo(await channel.getVideo(videoId), videoId)
        if (!PROJECTABLE_STATES.has(video.publicationState)) {
          throw new Error(`Video ${videoId} has not passed durability verification`)
        }
        await assertExactClaim(channel, video)
        await readProjectablePublicVideo(channel.publicBee, video)
        return reconcile({ channelKey, publicBeeKey, requiredVideoId: videoId })
      })
    },

    finalize(videoId) {
      return enqueue(async () => {
        let video = assertLogicalVideo(await channel.getVideo(videoId), videoId)
        if (!PROJECTABLE_STATES.has(video.publicationState)) {
          throw new Error(`Video ${videoId} has not passed durability verification`)
        }
        await assertExactClaim(channel, video)
        let publicVideo = await readProjectablePublicVideo(channel.publicBee, video)
        const revision = await channel.publicBee.getCanonicalReconciliationRevision?.()
        const announcedSnapshot = await publicFeed.getChannelSnapshot?.(
          channelIdentity(channel),
          publicBeeIdentity(channel),
        )
        if (
          !revision ||
          announcedSnapshot?.revision !== revision ||
          !Array.isArray(announcedSnapshot.videoIds) ||
          !announcedSnapshot.videoIds.includes(videoId)
        ) {
          throw new Error(`Video ${videoId} has not been announced in the canonical feed snapshot`)
        }
        if (video.publicationState === 'published' && publicVideo.publicationState === 'published') {
          return publicVideo
        }

        video = assertLogicalVideo(await channel.getVideo(videoId), videoId)
        await assertExactClaim(channel, video)
        if (video.publicationState !== 'published') {
          await channel.updateVideo(videoId, { publicationState: 'published' }, { syncPublic: false })
        }
        await channel.activatePublicProjection()
        video = assertLogicalVideo(await channel.getVideo(videoId), videoId)
        await assertExactClaim(channel, video)
        publicVideo = await readProjectablePublicVideo(channel.publicBee, video)
        if (publicVideo.publicationState !== 'published') {
          throw new Error(`Public video ${videoId} did not reach published state`)
        }
        return publicVideo
      })
    },

    reconcileCanonicalClaims({ channelKey, publicBeeKey } = {}) {
      return enqueue(() => reconcile({ channelKey, publicBeeKey }))
    },
  }
}
