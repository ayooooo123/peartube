import b4a from 'b4a'

function isHexKey(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function toHexKey(value) {
  if (!value) return null
  if (typeof value === 'string') return isHexKey(value) ? value.toLowerCase() : null
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.toString(value, 'hex')
  return null
}

function normalizeBlindPeerKeys(keys) {
  if (!Array.isArray(keys)) return []
  return Array.from(new Set(keys.map(toHexKey).filter(Boolean)))
}

function createNoopRelayBlindPeer({ key, error = null } = {}) {
  return {
    enabled: false,
    publicKey: key || null,
    error,
    addCore() { return false },
    addAutobase() { return false },
    getStats() {
      return { enabled: false, publicKey: key || null, mirroredCores: 0, mirroredAutobases: 0, error }
    },
    async close() {}
  }
}

/* eslint-disable no-empty */
/**
 * Create the PearTube relay's blind-peer surface. This makes the relay usable
 * as a native Holepunch blind peer while keeping PearTube's public-feed and
 * availability protocol on the canonical peartube-network topic.
 */
export async function createRelayBlindPeer({
  ctx,
  storagePath,
  enabled = true,
  trustedPeerKeys = [],
  logger = {},
  BlindPeerCtor = null,
} = {}) {
  if (!enabled || !ctx?.store || ctx?.swarm?._peartubeOffline) {
    return createNoopRelayBlindPeer({ error: ctx?.swarm?._peartubeOfflineReason || null })
  }

  let BlindPeer = BlindPeerCtor
  if (!BlindPeer) {
    try {
      const mod = await import('blind-peer')
      BlindPeer = mod.default || mod
    } catch (err) {
      logger.warn?.('[relay-blind-peer] blind-peer unavailable', { error: err?.message || String(err) })
      return createNoopRelayBlindPeer({ error: err?.message || String(err) })
    }
  }

  try {
    const blindPeer = new BlindPeer(`${storagePath}/blind-peer`, {
      store: ctx.store,
      swarm: ctx.swarm,
      wakeup: ctx.wakeup || undefined,
      trustedPubKeys: normalizeBlindPeerKeys(trustedPeerKeys),
      // PearTube already has explicit retention/cache policy. Do not let the
      // generic blind-peer GC clear mirrored video cores underneath the relay.
      enableGc: false,
    })
    await blindPeer.ready?.()
    await blindPeer.listen?.()

    const publicKey = toHexKey(blindPeer.publicKey || ctx.swarm?.keyPair?.publicKey)
    logger.info?.('[relay-blind-peer] listening', { publicKey })

    const trackedCores = new Set()
    const trackedAutobases = new Set()

    return {
      enabled: true,
      publicKey,
      instance: blindPeer,
      addCore(core, opts = {}) {
        if (!core) return false
        const keyHex = toHexKey(core.key)
        if (keyHex) trackedCores.add(keyHex)
        try {
          // This path is for relay-owned or already-accepted PearTube content.
          // announce=true means the relay advertises bytes on the core's normal
          // discovery topic while public-feed metadata still travels over
          // peartube-network/Protomux.
          blindPeer._announceCore?.(core.key).catch?.(() => {})
        } catch {}
        try { core.download?.({ start: 0, end: -1 }) } catch {}
        return true
      },
      addAutobase(base, opts = {}) {
        if (!base) return false
        const keyHex = toHexKey(base?.key || base?.local?.key || base?.wakeupCapability?.key)
        if (keyHex) trackedAutobases.add(keyHex)
        if (base.local) this.addCore(base.local, opts)
        if (base.core) this.addCore(base.core, opts)
        return true
      },
      getStats() {
        return {
          enabled: true,
          publicKey,
          mirroredCores: trackedCores.size,
          mirroredAutobases: trackedAutobases.size,
          error: null
        }
      },
      async close() {
        await blindPeer.close?.()
      }
    }
  } catch (err) {
    logger.warn?.('[relay-blind-peer] failed to start', { error: err?.message || String(err) })
    return createNoopRelayBlindPeer({ error: err?.message || String(err) })
  }
}
