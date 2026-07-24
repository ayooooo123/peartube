import { verifyArchivePledge } from './pledge.js'

export function createArchiveProtocol(options = {}) {
  const maxFrameBytes = Number.isSafeInteger(options.maxFrameBytes) ? options.maxFrameBytes : 256 * 1024
  const maxChallengesPerPeer = Number.isSafeInteger(options.maxChallengesPerPeer) ? options.maxChallengesPerPeer : 4
  const activeChallenges = new Map()

  return {
    async ingestPledge({ envelope } = {}) {
      return Boolean(await verifyArchivePledge(envelope))
    },
    async ingestFrame({ bytes } = {}) {
      return Buffer.byteLength(bytes || []) <= maxFrameBytes
    },
    beginChallenge(peerId) {
      const key = String(peerId || '')
      const count = activeChallenges.get(key) || 0
      if (count >= maxChallengesPerPeer) return false
      activeChallenges.set(key, count + 1)
      return true
    },
    endChallenge(peerId) {
      const key = String(peerId || '')
      const count = activeChallenges.get(key) || 0
      if (count <= 1) activeChallenges.delete(key)
      else activeChallenges.set(key, count - 1)
    },
  }
}
