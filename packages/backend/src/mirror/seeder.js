import { fetchMirrorDescriptor } from './fetcher.js'
import { EventType, DescriptorState, WorkerPhase, DescriptorFlags, SourceType, encodeDescriptor, encodeMirrorRequest, toFixed32 } from './schemas.js'
import { appendDescriptorAdded } from './autobase.js'

const ZERO_32 = new Uint8Array(32)

function keyHex(bytes) {
  return Buffer.from(bytes || ZERO_32).toString('hex')
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  return fallback
}

async function ensureReady(value) {
  if (value && typeof value.ready === 'function') await value.ready()
  return value
}

async function replicateCore(core, stream) {
  if (!core || !stream) return false
  if (typeof core.replicate === 'function') {
    core.replicate(stream)
    return true
  }
  if (typeof core.replicateStream === 'function') {
    core.replicateStream(stream)
    return true
  }
  return false
}

function joinSwarmTopic(swarm, topic, onConnection) {
  if (!swarm || typeof swarm.join !== 'function') {
    throw new Error('joinSwarmTopic requires a Hyperswarm instance with join()')
  }
  const topicKey = toFixed32(topic)
  const discovery = swarm.join(topicKey, { server: true, client: true })
  const onConn = async (stream) => {
    try {
      await onConnection?.(stream)
    } catch {}
  }
  if (typeof swarm.on === 'function') swarm.on('connection', onConn)
  return {
    topicKey,
    discovery,
    close() {
      try { discovery?.destroy?.() } catch {}
      try { swarm.off?.('connection', onConn) } catch {}
    },
  }
}

async function openCoreForDescriptor(getCore, descriptor, context = {}) {
  if (typeof getCore !== 'function') return null
  const core = await getCore(descriptor, context)
  return ensureReady(core)
}

function buildDescriptorAddedPayload(descriptor, options = {}) {
  return {
    descriptor,
    reason: options.reason ?? 0,
    parentEventId: options.parentEventId || ZERO_32,
    localSeenAt: toBigInt(options.localSeenAt, BigInt(Date.now())),
    initialState: options.initialState ?? DescriptorState.ACTIVE,
  }
}

export async function seedMirroredVideo(autobase, swarm, descriptor, options = {}) {
  const core = await openCoreForDescriptor(options.getCore, descriptor, options)
  const topic = toFixed32(descriptor.swarmTopic || ZERO_32)
  const seedHandle = joinSwarmTopic(swarm, topic, async (stream) => {
    if (core) await replicateCore(core, stream)
  })

  if (autobase) {
    await appendDescriptorAdded(autobase, buildDescriptorAddedPayload(descriptor, options), {
      signer: descriptor.signer || ZERO_32,
      actorId: options.actorId || descriptor.publisherIdentity || ZERO_32,
      prevEntryId: options.prevEntryId || ZERO_32,
      observedAt: options.observedAt || BigInt(Date.now()),
      signBytes: options.signBytes,
    })
  }

  return {
    descriptor,
    core,
    topic,
    state: {
      workerPhase: WorkerPhase.SEEDING,
      descriptorState: DescriptorState.ACTIVE,
      topicHex: keyHex(topic),
      joined: true,
    },
    close: async () => {
      seedHandle.close()
      try { await core?.close?.() } catch {}
    },
  }
}

export async function seedDiscoveredVideo(autobase, swarm, sourceUrl, options = {}) {
  const extracted = await fetchMirrorDescriptor(sourceUrl, options)
  const descriptor = extracted.descriptor
  const seeded = await seedMirroredVideo(autobase, swarm, descriptor, {
    ...options,
    reason: options.reason ?? 1,
    initialState: options.initialState ?? DescriptorState.DISCOVERED,
  })

  return {
    ...extracted,
    ...seeded,
  }
}

export function createMirrorSeeder(options = {}) {
  const records = new Map()

  const register = async (autobase, swarm, descriptor, nextOptions = {}) => {
    const record = await seedMirroredVideo(autobase, swarm, descriptor, { ...options, ...nextOptions })
    records.set(keyHex(record.topic), record)
    return record
  }

  const registerFromUrl = async (autobase, swarm, sourceUrl, nextOptions = {}) => {
    const record = await seedDiscoveredVideo(autobase, swarm, sourceUrl, { ...options, ...nextOptions })
    records.set(keyHex(record.topic), record)
    return record
  }

  const stop = async () => {
    for (const record of records.values()) {
      try { await record.close?.() } catch {}
    }
    records.clear()
  }

  return {
    register,
    registerFromUrl,
    stop,
    records,
  }
}

export default {
  seedMirroredVideo,
  seedDiscoveredVideo,
  createMirrorSeeder,
}
