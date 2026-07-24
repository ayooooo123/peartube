import { verifyBootstrapLocator } from './bootstrap-protocol.js'

export function createBootstrapManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxLocatorsPerPeer = Number(options.maxLocatorsPerPeer || 128)
  const locatorsByPublisher = new Map()
  const seenByPeer = new Map()

  function peerSet(peerId) {
    const key = String(peerId)
    if (!seenByPeer.has(key)) seenByPeer.set(key, new Set())
    return seenByPeer.get(key)
  }

  return {
    async ingestLocator(peerId, envelope) {
      const seen = peerSet(peerId)
      if (seen.size >= maxLocatorsPerPeer) return { status: 'quota-exceeded' }
      const verified = await verifyBootstrapLocator(envelope, { ...options, now: now() })
      if (!verified) return { status: 'quarantined' }
      const body = verified.body
      const replayKey = `${body.publisherId}:${body.catalogHead}:${body.issuedAt}`
      if (seen.has(replayKey)) return { status: 'replay' }
      seen.add(replayKey)
      const current = locatorsByPublisher.get(body.publisherId)
      if (!current || body.issuedAt > current.issuedAt || (body.issuedAt === current.issuedAt && body.catalogEpoch >= current.catalogEpoch)) {
        locatorsByPublisher.set(body.publisherId, { ...body, trusted: verified.trusted, catalogChainVerified: verified.catalogChainVerified })
      }
      return { status: 'accepted', publisherId: body.publisherId }
    },
    getLocator(publisherId) {
      return locatorsByPublisher.get(String(publisherId).toLowerCase()) || null
    },
    listLocators() {
      return Array.from(locatorsByPublisher.values()).sort((a, b) => a.publisherId.localeCompare(b.publisherId))
    },
  }
}
