export function createReplayWindow(options = {}) {
  const maxEntries = Math.max(1, Number(options.maxEntries || 1024))
  const maxSkewMs = Math.max(0, Number(options.maxSkewMs || 30_000))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const peers = new Map()

  function key(purpose) {
    return String(purpose || 'default')
  }

  function touch(peerId) {
    const peerKey = String(peerId)
    let state = peers.get(peerKey)
    if (!state) {
      state = { purposes: new Map(), touched: 0 }
      peers.set(peerKey, state)
    }
    state.touched = now()
    while (peers.size > maxEntries) {
      let oldestKey = null
      let oldest = Infinity
      for (const [id, entry] of peers) {
        if (entry.touched < oldest) {
          oldest = entry.touched
          oldestKey = id
        }
      }
      if (oldestKey) peers.delete(oldestKey)
      else break
    }
    return state
  }

  return {
    accept({ peerId, purpose, nonce, timestamp }) {
      const at = Number(timestamp)
      const current = now()
      if (!Number.isFinite(at) || Math.abs(at - current) > maxSkewMs) return { accepted: false, reason: 'clock-skew' }
      const nextNonce = Number(nonce)
      if (!Number.isSafeInteger(nextNonce) || nextNonce < 0) return { accepted: false, reason: 'invalid-nonce' }
      const state = touch(peerId)
      const purposeKey = key(purpose)
      const last = state.purposes.get(purposeKey) ?? -1
      if (nextNonce <= last) return { accepted: false, reason: 'replay' }
      state.purposes.set(purposeKey, nextNonce)
      return { accepted: true }
    },
    hasPeer(peerId) {
      return peers.has(String(peerId))
    },
  }
}
