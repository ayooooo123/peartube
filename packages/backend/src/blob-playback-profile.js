/**
 * Blob Playback Profiles
 *
 * Bridges the upload-time MP4 probe (mp4-playback-probe.js) to playback-time
 * range prioritization (blob-range-priority.js):
 *
 * - In-memory registry keyed the same way as the range-priority registry
 *   (coreKeyHex + blob block span), consulted on every prioritized range
 *   request to snap seeks to keyframes and boost back-moov fetches.
 * - Local persistence in ctx.metaDb (JSON hyperbee) so profiles survive
 *   restarts. Only the uploading device has a probe today; propagating the
 *   index through the channel HyperDB schema is a follow-up (the video
 *   schema is a fixed compact hyperschema).
 * - Remote probing: viewers without a stored profile can probe a remote blob
 *   through hyperblobs sparse reads. For back-moov files those reads target
 *   exactly the bytes the player is about to block on.
 */

import Hyperblobs from 'hyperblobs'
import b4a from 'b4a'

import { normalizeBlobRefInput, stringifyBlobId } from './blob-ref.js'
import { probeMp4PlaybackProfile, isMp4MimeType } from './mp4-playback-probe.js'

const PROFILE_DB_PREFIX = 'playback-profile!'
const MAX_REGISTERED_PROFILES = 16
const REMOTE_PROBE_TIMEOUT_MS = 8000
// Remote moov reads ride P2P replication; bound them tighter than local probes.
const REMOTE_PROBE_MAX_MOOV_BYTES = 16 * 1024 * 1024

// registryKey -> profile (Map insertion order = LRU)
const registeredProfiles = new Map()
// profileDbKey -> Promise — dedupes concurrent remote probes per blob
const inflightRemoteProbes = new Map()

export function getBlobProfileRegistryKey(coreKeyHex, blob) {
  return `${coreKeyHex}:${blob.blockOffset}:${blob.blockLength}`
}

function profileDbKey(blobsCoreKey, blobId) {
  return `${PROFILE_DB_PREFIX}${blobsCoreKey}!${blobId}`
}

// Key within the `playback-profile` metaDb subspace (no namespace prefix — the
// sub-encoder adds it). Mirrors the legacy key minus the PROFILE_DB_PREFIX.
function profileSubKey(blobsCoreKey, blobId) {
  return `${blobsCoreKey}!${blobId}`
}

function isUsableProfile(profile) {
  return Boolean(profile && profile.version === 1 && profile.moovPosition)
}

export function registerBlobPlaybackProfile(coreKeyHex, blob, profile) {
  if (!coreKeyHex || !blob || !isUsableProfile(profile)) return false
  const key = getBlobProfileRegistryKey(coreKeyHex, blob)
  registeredProfiles.delete(key)
  registeredProfiles.set(key, profile)
  while (registeredProfiles.size > MAX_REGISTERED_PROFILES) {
    const oldest = registeredProfiles.keys().next().value
    registeredProfiles.delete(oldest)
  }
  return true
}

export function getBlobPlaybackProfile(coreKeyHex, blob) {
  if (!coreKeyHex || !blob) return null
  const key = getBlobProfileRegistryKey(coreKeyHex, blob)
  const profile = registeredProfiles.get(key)
  if (!profile) return null
  // Refresh LRU position: an active playback should not be evicted by
  // background profile registrations.
  registeredProfiles.delete(key)
  registeredProfiles.set(key, profile)
  return profile
}

export function clearBlobPlaybackProfiles() {
  registeredProfiles.clear()
}

export async function saveBlobPlaybackProfile(ctx, { blobsCoreKey, blobId }, profile) {
  if (!ctx?.metaSubspaces?.playbackProfiles || !blobsCoreKey || !blobId || !isUsableProfile(profile)) return false
  try {
    await ctx.metaSubspaces.playbackProfiles.put(profileSubKey(blobsCoreKey, String(blobId)), profile)
    return true
  } catch {
    return false
  }
}

export async function loadBlobPlaybackProfile(ctx, { blobsCoreKey, blobId }) {
  if (!ctx?.metaSubspaces?.playbackProfiles || !blobsCoreKey || !blobId) return null
  try {
    const node = await ctx.metaSubspaces.playbackProfiles.get(profileSubKey(blobsCoreKey, String(blobId)))
    return isUsableProfile(node?.value) ? node.value : null
  } catch {
    return null
  }
}

/**
 * Probe a (possibly remote) blob through hyperblobs sparse reads. Reads box
 * headers plus the moov box; every fetched block is one the player needs
 * anyway (front-moov: parsed immediately at startup; back-moov: the startup
 * bottleneck itself).
 */
export async function probeRemoteBlobPlaybackProfile(ctx, { blobsCoreKey, blob }, options = {}) {
  if (!ctx?.store || !blobsCoreKey || !blob || !Number.isInteger(blob.byteLength)) return null

  const timeoutMs = options.timeoutMs ?? REMOTE_PROBE_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let core = null
  try {
    core = ctx.store.get(b4a.from(blobsCoreKey, 'hex'))
    await core.ready()
    const blobs = new Hyperblobs(core)

    const readAt = async (offset, length) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('remote probe timeout')
      const chunks = []
      const stream = blobs.createReadStream(blob, { start: offset, length })
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { stream.destroy() } catch { /* best effort */ }
          reject(new Error('remote probe timeout'))
        }, remaining)
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.on('end', () => {
          clearTimeout(timer)
          resolve(b4a.concat(chunks))
        })
        stream.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
    }

    return await probeMp4PlaybackProfile(readAt, blob.byteLength, {
      source: 'remote-probe',
      maxMoovBytes: options.maxMoovBytes ?? REMOTE_PROBE_MAX_MOOV_BYTES,
    })
  } catch {
    return null
  } finally {
    if (core) {
      try {
        const closing = core.close?.()
        if (closing?.catch) closing.catch(() => {})
      } catch { /* best effort */ }
    }
  }
}

/**
 * Make a blob's playback profile available to range prioritization:
 * registry hit → done; else stored profile; else (mp4 only) remote probe,
 * persisting the result for next time. Best-effort, never throws.
 *
 * @returns {Promise<Object|null>} the registered profile, if any
 */
export async function attachBlobPlaybackProfile(ctx, { blobsCoreKey, blobId, mimeType }, options = {}) {
  try {
    const blob = normalizeBlobRefInput(blobId)
    if (!blobsCoreKey || !blob) return null
    const blobIdStr = stringifyBlobId(blob)

    const registered = getBlobPlaybackProfile(blobsCoreKey, blob)
    if (registered) return registered

    let profile = await loadBlobPlaybackProfile(ctx, { blobsCoreKey, blobId: blobIdStr })

    if (!profile && options.allowRemoteProbe !== false && isMp4MimeType(mimeType)) {
      const dbKey = profileDbKey(blobsCoreKey, blobIdStr)
      let inflight = inflightRemoteProbes.get(dbKey)
      if (!inflight) {
        inflight = probeRemoteBlobPlaybackProfile(ctx, { blobsCoreKey, blob }, options)
          .finally(() => inflightRemoteProbes.delete(dbKey))
        inflightRemoteProbes.set(dbKey, inflight)
      }
      profile = await inflight
      if (profile) await saveBlobPlaybackProfile(ctx, { blobsCoreKey, blobId: blobIdStr }, profile)
    }

    if (!profile) return null
    registerBlobPlaybackProfile(blobsCoreKey, blob, profile)
    return profile
  } catch {
    return null
  }
}
