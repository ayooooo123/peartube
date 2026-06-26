import b4a from 'b4a'

/**
 * Client surface for delegating PearTube cores/autobases to native Holepunch
 * blind peers (mirrors). This is the counterpart to `relay-blind-peer.js`: the
 * relay runs the blind-peer *server*; every node runs this *client* so its own
 * uploads stay available even while the device is offline.
 *
 * The upstream `blind-peering` module keys its mirror set by hyperdht-address
 * encoded buffers (key + optional node hints), NOT raw 32-byte hypercore keys —
 * passing a raw key silently mis-parses. PearTube stores relay keys as raw hex
 * everywhere, so this wrapper owns the raw<->encoded conversion and exposes a
 * raw-hex API to the rest of the backend.
 */

function isHexKey(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function toHexKey(value) {
  if (!value) return null
  if (typeof value === 'string') return isHexKey(value) ? value.toLowerCase() : null
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    return value.length === 32 ? b4a.toString(value, 'hex') : null
  }
  return null
}

function normalizeKeys(keys) {
  const out = []
  for (const key of Array.isArray(keys) ? keys : keys ? [keys] : []) {
    const hex = toHexKey(key)
    if (hex) out.push(hex)
  }
  return out
}

function createNoopBlindPeeringClient({ error = null } = {}) {
  return {
    enabled: false,
    error,
    instance: null,
    addMirrorKeys() { return 0 },
    getActiveMirrorKeys() { return [] },
    addCore() { return false },
    addAutobase() { return false },
    async suspend() {},
    async resume() {},
    getStats() {
      return { enabled: false, mirrors: 0, addCore: 0, addAutobase: 0, error }
    },
    async close() {},
  }
}

/* eslint-disable no-empty */
/**
 * @param {object} options
 * @param {{ store?: any, swarm?: any, wakeup?: any }} options.ctx - storage context (needs swarm.dht + store)
 * @param {Array<string|Uint8Array>} [options.mirrorKeys] - initial raw blind-peer keys
 * @param {boolean} [options.enabled]
 * @param {boolean} [options.suspended] - start suspended (e.g. app backgrounded)
 * @param {object} [options.logger]
 * @param {Function} [options.BlindPeeringCtor] - inject for tests
 * @param {(key: Uint8Array) => Uint8Array} [options.encodeAddress] - inject for tests
 */
export async function createBlindPeeringClient({
  ctx,
  mirrorKeys = [],
  enabled = true,
  suspended = false,
  logger = {},
  BlindPeeringCtor = null,
  encodeAddress = null,
} = {}) {
  const dht = ctx?.swarm?.dht
  if (!enabled || !ctx?.store || !dht || ctx?.swarm?._peartubeOffline) {
    return createNoopBlindPeeringClient({ error: ctx?.swarm?._peartubeOfflineReason || null })
  }

  let BlindPeering = BlindPeeringCtor
  if (!BlindPeering) {
    try {
      const mod = await import('blind-peering')
      BlindPeering = mod.default || mod
    } catch (err) {
      logger.warn?.('[blind-peering] module unavailable', { error: err?.message || String(err) })
      return createNoopBlindPeeringClient({ error: err?.message || String(err) })
    }
  }

  let encode = encodeAddress
  if (!encode) {
    try {
      const mod = await import('hyperdht-address')
      const fn = mod.encode || mod.default?.encode
      encode = (key) => fn(key, [])
    } catch (err) {
      logger.warn?.('[blind-peering] hyperdht-address unavailable', { error: err?.message || String(err) })
      return createNoopBlindPeeringClient({ error: err?.message || String(err) })
    }
  }

  // Raw-hex mirror set is the source of truth; encoded buffers are derived.
  const mirrors = new Set(normalizeKeys(mirrorKeys))

  function encodedList() {
    const encoded = []
    for (const hex of mirrors) {
      try { encoded.push(encode(b4a.from(hex, 'hex'))) } catch {}
    }
    return encoded
  }

  let instance
  try {
    instance = new BlindPeering(dht, ctx.store, {
      keys: encodedList(),
      wakeup: ctx.wakeup || null,
      suspended,
    })
  } catch (err) {
    logger.warn?.('[blind-peering] failed to start', { error: err?.message || String(err) })
    return createNoopBlindPeeringClient({ error: err?.message || String(err) })
  }

  logger.info?.('[blind-peering] client ready', { mirrors: mirrors.size })

  return {
    enabled: true,
    error: null,
    instance,
    /**
     * Merge in newly-learned mirror keys (e.g. from feed discovery). Returns the
     * count of keys that were not already known.
     * @param {Array<string|Uint8Array>|string|Uint8Array} keys
     */
    addMirrorKeys(keys) {
      let added = 0
      for (const hex of normalizeKeys(keys)) {
        if (!mirrors.has(hex)) {
          mirrors.add(hex)
          added++
        }
      }
      if (added) {
        try { instance.setKeys(encodedList()) } catch (err) {
          logger.warn?.('[blind-peering] setKeys failed', { error: err?.message || String(err) })
        }
      }
      return added
    },
    getActiveMirrorKeys() {
      return Array.from(mirrors)
    },
    /**
     * Delegate a hypercore to the closest mirrors (background, never throws).
     * `announce` defaults true so mirrors advertise the bytes for other peers.
     */
    addCore(core, opts = {}) {
      if (!core || mirrors.size === 0) return false
      try {
        instance.addCoreBackground(core, { announce: true, ...opts })
        return true
      } catch (err) {
        logger.warn?.('[blind-peering] addCore failed', { error: err?.message || String(err) })
        return false
      }
    },
    addAutobase(base, opts = {}) {
      if (!base || mirrors.size === 0) return false
      try {
        instance.addAutobaseBackground(base, { announce: true, ...opts })
        return true
      } catch (err) {
        logger.warn?.('[blind-peering] addAutobase failed', { error: err?.message || String(err) })
        return false
      }
    },
    async suspend() {
      try { await instance.suspend?.() } catch {}
    },
    async resume() {
      try { await instance.resume?.() } catch {}
    },
    getStats() {
      return {
        enabled: true,
        mirrors: mirrors.size,
        addCore: instance.stats?.addCore ?? 0,
        addAutobase: instance.stats?.addAutobase ?? 0,
        error: null,
      }
    },
    async close() {
      try { await instance.close?.() } catch {}
    },
  }
}
