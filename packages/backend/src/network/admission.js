function defaults(options = {}) {
  return {
    maxMessages: Number(options.maxMessages || 128),
    maxBytes: Number(options.maxBytes || 1024 * 1024),
    maxVerifications: Number(options.maxVerifications || 32),
    maxInFlightBytes: Number(options.maxInFlightBytes || 1024 * 1024),
    refillPerTick: Number(options.refillPerTick ?? 0),
  }
}

export function createNetworkAdmission(options = {}) {
  const limits = defaults(options)
  const peers = new Map()

  function state(peerId) {
    const key = String(peerId)
    if (!peers.has(key)) {
      peers.set(key, { messages: 0, bytes: 0, verifications: 0, inFlightBytes: 0, reservations: new Set() })
    }
    return peers.get(key)
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
    disconnect(peerId) {
      const s = state(peerId)
      for (const reservation of Array.from(s.reservations)) reservation.release('disconnect')
      s.inFlightBytes = 0
      s.verifications = 0
    },
    snapshot(peerId) {
      const s = state(peerId)
      return { messages: s.messages, bytes: s.bytes, verifications: s.verifications, inFlightBytes: s.inFlightBytes }
    },
  }
}
