import { AVAILABILITY_EVIDENCE_TTL_MS } from './availability.js'

const DEFAULT_ASSESSMENT_BUDGET = 64
const MAX_PEERS_PER_RENDITION = 64
const MAX_RANGES_PER_PEER = 128

function boundedRanges(value) {
  if (!Array.isArray(value)) return []
  const ranges = []
  for (const entry of value.slice(0, MAX_RANGES_PER_PEER)) {
    const start = Number(entry?.start)
    const end = Number(entry?.end)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) continue
    ranges.push({ start, end })
  }
  return ranges
}

function transportKey(value) {
  const key = typeof value === 'string' ? value.toLowerCase() : ''
  return /^[0-9a-f]{2,128}$/.test(key) ? key : null
}

function renditionKey(publicationId, renditionId) {
  return `${publicationId}\n${renditionId || ''}`
}

/**
 * Collection point for availability evidence.
 *
 * Assessment is lazy and budgeted: rendering a catalog page must not open every
 * asset swarm, so a rendition contributes peer evidence only after something
 * visible, selected, cached, or explicitly audited admits it through
 * `requestAssessment`. Renditions outside that bounded set report
 * `budgetExceeded` instead of pretending they were checked and found empty.
 *
 * The store records only what the transport layer authenticated: a remote Noise
 * public key, the block ranges it advertised, and the outcome of a local
 * hash-verified possession challenge. Peer counts, scorer statistics, and
 * publisher claims are not evidence and never enter here.
 */
export function createAvailabilityEvidenceStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const budget = Number.isSafeInteger(options.assessmentBudget) && options.assessmentBudget > 0
    ? options.assessmentBudget
    : DEFAULT_ASSESSMENT_BUDGET
  const renditions = new Map()

  function admitted(key) {
    const entry = renditions.get(key)
    if (!entry) return null
    // Refresh LRU position so an actively rendered title keeps its slot.
    renditions.delete(key)
    renditions.set(key, entry)
    return entry
  }

  function ensure(key) {
    const existing = admitted(key)
    if (existing) return existing
    const entry = { peers: new Map(), localRanges: [], archivePledgeCount: 0, observed: false }
    renditions.set(key, entry)
    while (renditions.size > budget) {
      const oldest = renditions.keys().next().value
      renditions.delete(oldest)
    }
    return entry
  }

  function peerRecord(entry, key) {
    let peer = entry.peers.get(key)
    if (peer) return peer
    if (entry.peers.size >= MAX_PEERS_PER_RENDITION) return null
    peer = {
      transportKey: key,
      connected: true,
      advertisedRanges: [],
      advertisedAt: 0,
      challengeStatus: 'pending',
      verifiedAt: 0,
      provenRanges: null,
      archivist: false,
    }
    entry.peers.set(key, peer)
    return peer
  }

  function prune(entry, at) {
    for (const [key, peer] of entry.peers) {
      const decided = peer.challengeStatus !== 'pending'
      const aged = at - Math.max(peer.verifiedAt, peer.advertisedAt) > AVAILABILITY_EVIDENCE_TTL_MS
      if (!peer.connected && decided && aged) entry.peers.delete(key)
    }
  }

  return {
    /**
     * Admit a rendition into the bounded active assessment set. Returns false
     * when the budget is exhausted, so callers can degrade honestly instead of
     * opening another swarm.
     */
    requestAssessment(publicationId, renditionId = null) {
      const key = renditionKey(publicationId, renditionId)
      if (renditions.has(key)) {
        admitted(key)
        return true
      }
      if (renditions.size >= budget) return false
      ensure(key)
      return true
    },

    recordAdvertisement(publicationId, renditionId, advertisement = {}) {
      const key = transportKey(advertisement.transportKey)
      if (!key) return false
      const entry = admitted(renditionKey(publicationId, renditionId))
      if (!entry) return false
      const peer = peerRecord(entry, key)
      if (!peer) return false
      peer.connected = true
      peer.archivist = peer.archivist || advertisement.archivist === true
      peer.advertisedRanges = boundedRanges(advertisement.ranges)
      peer.advertisedAt = Number(advertisement.at ?? now()) || 0
      // A new advertisement invalidates the proof of the previous one, and an
      // advertisement alone is not an observation: only a decided challenge
      // outcome can later downgrade this rendition to unavailable.
      peer.challengeStatus = 'pending'
      peer.verifiedAt = 0
      peer.provenRanges = null
      return true
    },

    /**
     * Outcome of an unpredictable local challenge over blocks the peer already
     * advertised. `provenRanges` narrows the proof when the challenge could only
     * reach part of the advertisement.
     */
    recordChallengeResult(publicationId, renditionId, result = {}) {
      const key = transportKey(result.transportKey)
      if (!key) return false
      const entry = admitted(renditionKey(publicationId, renditionId))
      const peer = entry?.peers.get(key)
      if (!peer) return false
      const status = String(result.status || '')
      if (status !== 'passed' && status !== 'failed' && status !== 'timeout') return false
      peer.challengeStatus = status
      entry.observed = true
      if (status === 'passed') {
        peer.verifiedAt = Number(result.at ?? now()) || 0
        peer.provenRanges = result.provenRanges == null ? null : boundedRanges(result.provenRanges)
      }
      return true
    },

    /** A dropped transport stops contributing immediately, everywhere. */
    recordDisconnect(transportKeyValue) {
      const key = transportKey(transportKeyValue)
      if (!key) return
      for (const entry of renditions.values()) {
        const peer = entry.peers.get(key)
        if (peer) peer.connected = false
      }
    },

    recordLocalRanges(publicationId, renditionId, ranges) {
      const entry = ensure(renditionKey(publicationId, renditionId))
      entry.localRanges = boundedRanges(ranges)
    },

    recordArchivePledgeCount(publicationId, renditionId, count) {
      const entry = ensure(renditionKey(publicationId, renditionId))
      entry.archivePledgeCount = Number.isSafeInteger(count) && count > 0 ? count : 0
    },

    /**
     * Passive read for response shaping. It never joins a topic, opens a core,
     * or issues a challenge.
     */
    getCachedEvidence(publicationId, renditionId = null) {
      const key = renditionKey(publicationId, renditionId)
      const entry = renditions.get(key)
      if (!entry) return { budgetExceeded: renditions.size >= budget }
      const at = Number(now()) || 0
      prune(entry, at)
      return {
        peers: [...entry.peers.values()].map(peer => ({
          transportKey: peer.transportKey,
          connected: peer.connected,
          advertisedRanges: peer.advertisedRanges,
          advertisedAt: peer.advertisedAt,
          challengeStatus: peer.challengeStatus,
          verifiedAt: peer.verifiedAt,
          archivist: peer.archivist,
          ...(peer.provenRanges === null ? {} : { provenRanges: peer.provenRanges }),
        })),
        localRanges: entry.localRanges,
        archivePledgeCount: entry.archivePledgeCount,
        previouslyObserved: entry.observed,
      }
    },

    trackedRenditionCount() {
      return renditions.size
    },
  }
}
