export function createArchivePolicy(options = {}) {
  const capacityBytes = Number(options.capacityBytes || 0)
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 0) throw new Error('capacityBytes must be non-negative integer')
  const reservations = new Map()

  function usedBytes() {
    let used = 0
    for (const reservation of reservations.values()) used += reservation.bytes
    return used
  }

  return {
    reserve({ pledgeId, bytes, expiresAt } = {}) {
      const id = String(pledgeId || '')
      const size = Number(bytes)
      if (!id || !Number.isSafeInteger(size) || size < 0) return { accepted: false, reason: 'invalid-reservation' }
      if (usedBytes() + size > capacityBytes) return { accepted: false, reason: 'capacity-exceeded' }
      reservations.set(id, { bytes: size, expiresAt: Number(expiresAt) || 0 })
      return { accepted: true, pledgeId: id, reservedBytes: size }
    },
    reconcile({ pledgeId, actualBytes } = {}) {
      const entry = reservations.get(String(pledgeId))
      if (!entry) return false
      entry.bytes = Math.max(0, Number(actualBytes) || 0)
      return true
    },
    expire(now = 0) {
      for (const [id, reservation] of reservations) {
        if (reservation.expiresAt > 0 && reservation.expiresAt <= now) reservations.delete(id)
      }
    },
    availableBytes() {
      return capacityBytes - usedBytes()
    },
  }
}
