function rangeSize(range) {
  return Math.max(0, Number(range.end) - Number(range.start))
}

function covers(range = {}, target = {}) {
  return Number(range.start) <= Number(target.start) && Number(range.end) >= Number(target.end)
}

function validateRange(range = {}) {
  const start = Number(range.start)
  const end = Number(range.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('invalid playback range')
  return { start, end }
}

function scorePeer(peer, target) {
  const hasRange = (peer.ranges || []).some(range => covers(range, target))
  if (!hasRange || peer.connected === false) return null
  const latency = Math.max(0, Number(peer.latencyMs || 0))
  const throughput = Math.max(1, Number(peer.throughput || 1))
  return { peer, score: latency - throughput }
}

export function createMultiPeerScheduler(options = {}) {
  const local = options.local || { hasRange: () => false }
  const peers = Array.isArray(options.peers) ? options.peers.slice() : []
  const maxInFlightBytes = Number.isSafeInteger(options.maxInFlightBytes) ? options.maxInFlightBytes : 64 * 1024 * 1024
  let peerRequests = 0
  let inFlightBytes = 0
  const reservations = new Set()

  function reserve(range) {
    const size = rangeSize(range)
    if (inFlightBytes + size > maxInFlightBytes) return false
    const reservation = { size }
    reservations.add(reservation)
    inFlightBytes += size
    return reservation
  }

  function release(reservation) {
    if (!reservation || !reservations.has(reservation)) return
    reservations.delete(reservation)
    inFlightBytes -= reservation.size
  }

  return {
    async requestRange(input = {}) {
      const target = validateRange(input)
      if (local.hasRange?.(target)) return { status: 'ok', source: 'local', range: target, verified: true, originAttempted: false }

      const candidates = peers.map(peer => scorePeer(peer, target)).filter(Boolean).sort((a, b) => a.score - b.score || String(a.peer.id).localeCompare(String(b.peer.id)))
      for (const candidate of candidates) {
        const reservation = reserve(target)
        if (!reservation) return { status: 'unavailable', errorCode: 'BUDGET_EXHAUSTED', range: target, originAttempted: false }
        peerRequests++
        try {
          const ok = typeof candidate.peer.verify === 'function' ? candidate.peer.verify(target) : true
          if (!ok) continue
          return { status: 'ok', source: 'peer', peerId: candidate.peer.id, range: target, verified: true, originAttempted: false }
        } finally {
          release(reservation)
        }
      }
      return { status: 'unavailable', errorCode: 'NO_VERIFIED_SOURCE', range: target, deadlineMs: input.deadlineMs || null, originAttempted: false }
    },

    reserveBackground(input = {}) {
      return reserve(validateRange(input))
    },

    seek() {
      for (const reservation of Array.from(reservations)) release(reservation)
    },

    metrics() {
      return { peerRequests, inFlightBytes }
    },
  }
}
