function defaults(options = {}) {
  const maxMessages = Number(options.maxMessages || 128)
  const maxBytes = Number(options.maxBytes || 1024 * 1024)
  return {
    maxMessages,
    maxBytes,
    maxVerifications: Number(options.maxVerifications || 32),
    maxInFlightBytes: Number(options.maxInFlightBytes || 1024 * 1024),
    refillPerTick: Math.max(0, Number(options.refillPerTick ?? 0)),
    refillIntervalMs: Math.max(1, Number(options.refillIntervalMs || 1000)),
  }
}

export function createNetworkAdmission(options = {}) {
  const limits = defaults(options)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const peers = new Map()
  // A refilled message slot returns an average message worth of byte budget, so
  // one knob keeps both quotas in step instead of letting bytes stay a lifetime
  // cap while messages decay.
  const bytesPerMessage = limits.maxMessages > 0 ? limits.maxBytes / limits.maxMessages : 0

  function clock() {
    const at = Number(now())
    return Number.isFinite(at) ? at : 0
  }

  // `messages`/`bytes` are rate quotas: without this they are lifetime quotas and
  // a peer that once hit the cap is rejected for the rest of the process.
  // `verifications`/`inFlightBytes` are concurrency gauges released by the
  // reservation itself and must never decay on a timer.
  function refill(s) {
    if (limits.refillPerTick <= 0) return s
    const at = clock()
    const elapsed = at - s.refilledAt
    if (elapsed < 0) {
      s.refilledAt = at
      return s
    }
    const ticks = Math.floor(elapsed / limits.refillIntervalMs)
    if (ticks <= 0) return s
    s.refilledAt += ticks * limits.refillIntervalMs
    s.messages = Math.max(0, s.messages - ticks * limits.refillPerTick)
    s.bytes = Math.max(0, s.bytes - Math.floor(ticks * limits.refillPerTick * bytesPerMessage))
    return s
  }

  function state(peerId) {
    const key = String(peerId)
    const existing = peers.get(key)
    if (existing) return refill(existing)
    const created = {
      messages: 0,
      bytes: 0,
      verifications: 0,
      inFlightBytes: 0,
      reservations: new Set(),
      refilledAt: clock(),
    }
    peers.set(key, created)
    return created
  }

  function reject(reason) {
    return { accepted: false, reason }
  }

  return {
    reserve({ peerId, bytes = 0, verify = false } = {}) {
      const size = Math.max(0, Number(bytes || 0))
      const s = state(peerId)
      if (s.messages + 1 > limits.maxMessages) return reject('message-budget')
      if (s.bytes + size > limits.maxBytes) return reject('byte-budget')
      if (verify && s.verifications + 1 > limits.maxVerifications) return reject('verification-budget')
      if (s.inFlightBytes + size > limits.maxInFlightBytes) return reject('in-flight-bytes')
      s.messages += 1
      s.bytes += size
      if (verify) s.verifications += 1
      s.inFlightBytes += size
      let released = false
      const reservation = {
        accepted: true,
        release(reason = 'complete') {
          if (released) return
          released = true
          s.inFlightBytes = Math.max(0, s.inFlightBytes - size)
          if (verify) s.verifications = Math.max(0, s.verifications - 1)
          s.reservations.delete(reservation)
          reservation.reason = reason
        },
      }
      s.reservations.add(reservation)
      return reservation
    },
    // Dropping the entry is what bounds the map over a process lifetime, and it
    // is also what lets a reconnecting peer start from a clean budget.
    disconnect(peerId) {
      const key = String(peerId)
      const s = peers.get(key)
      if (!s) return
      for (const reservation of Array.from(s.reservations)) reservation.release('disconnect')
      peers.delete(key)
    },
    peerCount() {
      return peers.size
    },
    snapshot(peerId) {
      const s = peers.get(String(peerId))
      if (!s) return { messages: 0, bytes: 0, verifications: 0, inFlightBytes: 0 }
      refill(s)
      return { messages: s.messages, bytes: s.bytes, verifications: s.verifications, inFlightBytes: s.inFlightBytes }
    },
  }
}
