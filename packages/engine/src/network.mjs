import Hypercore from 'hypercore'
import Hyperswarm from 'hyperswarm'

export function channelDiscoveryTopic(channelKey) {
  const key = normalizeChannelKey(channelKey)
  return Hypercore.discoveryKey(key)
}

export function createDriveDiscoveryNetwork({
  store,
  channelKey,
  swarm = new Hyperswarm(),
  announce = false,
  lookup = true,
  onConnectionError = null
}) {
  if (!store || typeof store.replicate !== 'function') throw new Error('store with replicate() is required')

  const topic = channelDiscoveryTopic(channelKey)
  const onConnection = (conn) => {
    try {
      store.replicate(conn)
    } catch (err) {
      if (typeof onConnectionError === 'function') onConnectionError(err, conn)
      else conn?.destroy?.(err)
    }
  }

  swarm.on('connection', onConnection)
  const discovery = swarm.join(topic, { server: Boolean(announce), client: Boolean(lookup) })
  const flushed = discovery?.flushed?.()
  if (flushed?.catch) flushed.catch(() => {})

  return {
    swarm,
    topic,
    discovery,
    async close() {
      swarm.off?.('connection', onConnection)
      discovery?.destroy?.()
      await swarm.destroy?.()
    }
  }
}

function normalizeChannelKey(channelKey) {
  if (Buffer.isBuffer(channelKey)) return channelKey
  if (channelKey && channelKey.buffer && typeof channelKey.byteLength === 'number') return Buffer.from(channelKey)
  if (typeof channelKey === 'string' && /^[0-9a-fA-F]{64}$/.test(channelKey)) return Buffer.from(channelKey, 'hex')
  throw new Error('channelKey must be a 32-byte Buffer or 64-character hex string')
}
