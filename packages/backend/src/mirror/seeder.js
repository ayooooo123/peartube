import { fetchMirrorDescriptor } from './fetcher.js'
import { DescriptorState, WorkerPhase, toFixed32, toFixed64 } from './schemas.js'
import { appendDescriptorAdded } from './autobase.js'
import { createMirrorRefreshManager, createMirrorRefreshPolicy } from './refresh.js'

const ZERO_32 = new Uint8Array(32)

function keyHex(bytes) {
  return Buffer.from(bytes || ZERO_32).toString('hex')
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  if (typeof value === 'string' && value.trim()) {
    try { return BigInt(value) } catch { /* ignore invalid bigint */ }
  }
  return fallback
}

async function ensureReady(value) {
  if (value && typeof value.ready === 'function') await value.ready()
  return value
}

const replicatedCoreStreams = new WeakMap()

function connectionHasTopic(info, topicKey) {
  if (!info || !Array.isArray(info.topics)) return false
  const expected = Buffer.from(topicKey || ZERO_32)
  return info.topics.some((topic) => Buffer.compare(Buffer.from(topic || ZERO_32), expected) === 0)
}

async function replicateCoreOnce(core, stream) {
  if (!core || !stream || (typeof stream !== 'object' && typeof stream !== 'function')) return false
  let replicatedCores = replicatedCoreStreams.get(stream)
  if (!replicatedCores) {
    replicatedCores = new WeakSet()
    replicatedCoreStreams.set(stream, replicatedCores)
  }
  if (replicatedCores.has(core)) return false
  replicatedCores.add(core)
  return replicateCore(core, stream)
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
  const onConn = async (stream, info = {}) => {
    if (!connectionHasTopic(info, topicKey)) return
    try {
      await onConnection?.(stream, info)
    } catch { /* ignore connection handler failures */ }
  }
  if (typeof swarm.on === 'function') swarm.on('connection', onConn)
  return {
    topicKey,
    discovery,
    close() {
      try { discovery?.destroy?.() } catch { /* best effort cleanup */ }
      try { swarm.off?.('connection', onConn) } catch { /* best effort cleanup */ }
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

function buildSeedRecord(descriptor, options = {}, extras = {}) {
  const refreshPolicy = createMirrorRefreshPolicy(options.refreshPolicy || options)
  const sourceUrl = extras.sourceUrl || options.sourceUrl || extras.finalUrl || descriptor?.sourceUrl || null
  const now = toBigInt(options.now, BigInt(Date.now()))
  const availabilityEpoch = Number(refreshPolicy.plan({ descriptor }, { now }).nextAvailabilityEpoch)
  const refreshedDescriptor = {
    ...descriptor,
    availabilityEpoch,
  }
  return {
    descriptor: refreshedDescriptor,
    core: extras.core || null,
    topic: extras.topic || toFixed32(descriptor.swarmTopic || ZERO_32),
    sourceUrl,
    sourceMetadata: extras.sourceMetadata || options.sourceMetadata || descriptor?.sourceMetadata || null,
    refreshPolicy,
    refreshManager: createMirrorRefreshManager(options.refreshPolicy || options),
    refreshCount: 0,
    lastRefreshAt: now,
    lastRefetchAt: extras.lastRefetchAt || now,
    lastKeyRotationAt: extras.lastKeyRotationAt || now,
    lastAvailabilityEpoch: availabilityEpoch,
    state: {
      workerPhase: WorkerPhase.SEEDING,
      descriptorState: DescriptorState.ACTIVE,
      topicHex: keyHex(extras.topic || toFixed32(descriptor.swarmTopic || ZERO_32)),
      joined: Boolean(extras.joined),
      lastRefreshAt: now,
      lastAvailabilityEpoch: availabilityEpoch,
      sourcePlatform: extras.sourceMetadata?.sourcePlatform || options.sourceMetadata?.sourcePlatform || null,
    },
    close: extras.close || (async () => {}),
  }
}

export async function refreshMirroredVideo(autobase, swarm, record, options = {}) {
  if (!record) throw new Error('refreshMirroredVideo requires a seed record')
  const now = toBigInt(options.now, BigInt(Date.now()))
  const policy = record.refreshPolicy || createMirrorRefreshPolicy(options.refreshPolicy || options)
  const plan = policy.plan(record, { ...options, now })
  if (!plan.shouldRefresh) {
    return { refreshed: false, plan, record }
  }

  const next = { ...record }
  let updatedDescriptor = record.descriptor
  let reFetched = false
  let rotatedSigningKey = false
  let rotatedAvailabilityEpoch = false

  if (plan.shouldRefetchSource && record.sourceUrl) {
    const fetched = await fetchMirrorDescriptor(record.sourceUrl, {
      ...options,
      signer: options.signer || record.descriptor?.signer,
      availabilityEpoch: plan.nextAvailabilityEpoch,
      now,
    })
    updatedDescriptor = fetched.descriptor
    next.latestFetch = fetched
    next.sourceMetadata = fetched.sourceMetadata || next.sourceMetadata || null
    next.lastRefetchedAt = now
    next.lastRefetchAt = now
    reFetched = true
  }

  if (plan.shouldRotateSigningKey) {
    rotatedAvailabilityEpoch = true
    next.lastKeyRotationAt = now
    if (typeof options.rotateSigningKey === 'function') {
      const rotation = await options.rotateSigningKey(record, plan)
      if (rotation?.signer) {
        updatedDescriptor = { ...updatedDescriptor, signer: toFixed32(rotation.signer) }
        rotatedSigningKey = true
      }
      if (rotation?.signature) {
        updatedDescriptor = { ...updatedDescriptor, signature: toFixed64(rotation.signature) }
      }
    }
  }

  rotatedAvailabilityEpoch = plan.shouldRotateSigningKey || reFetched

  updatedDescriptor = {
    ...updatedDescriptor,
    availabilityEpoch: plan.nextAvailabilityEpoch,
  }

  next.descriptor = updatedDescriptor
  next.lastAvailabilityEpoch = plan.nextAvailabilityEpoch
  next.lastRefreshAt = now
  next.refreshCount = (record.refreshCount || 0) + 1
  next.state = {
    ...(record.state || {}),
    workerPhase: WorkerPhase.SEEDING,
    descriptorState: DescriptorState.ACTIVE,
    lastRefreshAt: now,
    lastAvailabilityEpoch: plan.nextAvailabilityEpoch,
    refreshCount: next.refreshCount,
  }

  if (autobase && typeof options.signBytes === 'function') {
    await appendDescriptorAdded(autobase, buildDescriptorAddedPayload(updatedDescriptor, options), {
      signer: updatedDescriptor.signer || ZERO_32,
      actorId: options.actorId || updatedDescriptor.publisherIdentity || ZERO_32,
      prevEntryId: options.prevEntryId || ZERO_32,
      observedAt: now,
      signBytes: options.signBytes,
    })
  }

  Object.assign(record, next)
  return {
    refreshed: true,
    plan,
    record,
    descriptor: updatedDescriptor,
    reFetched,
    rotatedSigningKey,
    rotatedAvailabilityEpoch,
  }
}

export async function seedMirroredVideo(autobase, swarm, descriptor, options = {}) {
  const core = await openCoreForDescriptor(options.getCore, descriptor, options)
  const topic = toFixed32(descriptor.swarmTopic || ZERO_32)
  const seedHandle = joinSwarmTopic(swarm, topic, async (stream) => {
    if (core) await replicateCoreOnce(core, stream)
  })

  if (autobase && typeof options.signBytes === 'function') {
    await appendDescriptorAdded(autobase, buildDescriptorAddedPayload(descriptor, options), {
      signer: descriptor.signer || ZERO_32,
      actorId: options.actorId || descriptor.publisherIdentity || ZERO_32,
      prevEntryId: options.prevEntryId || ZERO_32,
      observedAt: options.observedAt || BigInt(Date.now()),
      signBytes: options.signBytes,
    })
  }

  return buildSeedRecord(descriptor, options, {
    core,
    topic,
    joined: true,
    close: async () => {
      seedHandle.close()
      try { await core?.close?.() } catch { /* best effort cleanup */ }
    },
  })
}

export async function seedDiscoveredVideo(autobase, swarm, sourceUrl, options = {}) {
  const extracted = await fetchMirrorDescriptor(sourceUrl, options)
  const descriptor = extracted.descriptor
  const sourceMetadata = extracted.sourceMetadata
    ? {
        ...extracted.sourceMetadata,
        sourceRelayId: options.sourceRelayId || options.relayId || extracted.sourceMetadata.sourceRelayId || '',
      }
    : null
  const seeded = await seedMirroredVideo(autobase, swarm, descriptor, {
    ...options,
    sourceUrl: extracted.finalUrl || sourceUrl,
    sourceMetadata,
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
  const refreshManager = createMirrorRefreshManager(options.refreshPolicy || options)
  const timers = new Map()
  let stopped = false

  const scheduleRefresh = (key, record, nextOptions = {}) => {
    if (!options.autoRefresh || stopped) return null
    const plan = record.refreshPolicy.plan(record, nextOptions)
    if (!plan.shouldRefresh && !options.scheduleIdleRefresh) return null
    const delayMs = Math.max(1000, plan.nextRefreshAt - Date.now())
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(async () => {
      timers.delete(key)
      if (stopped || !records.has(key)) return
      const current = records.get(key)
      if (!current) return
      try {
        await refreshRecord(current.autobase, current.swarm, current, nextOptions)
      } catch {
        scheduleRefresh(key, current, nextOptions)
      }
    }, delayMs)
    timers.set(key, timer)
    return timer
  }

  const register = async (autobase, swarm, descriptor, nextOptions = {}) => {
    const record = await seedMirroredVideo(autobase, swarm, descriptor, { ...options, ...nextOptions })
    const key = keyHex(record.topic)
    record.autobase = autobase
    record.swarm = swarm
    records.set(key, record)
    scheduleRefresh(key, record, nextOptions)
    return record
  }

  const registerFromUrl = async (autobase, swarm, sourceUrl, nextOptions = {}) => {
    const record = await seedDiscoveredVideo(autobase, swarm, sourceUrl, { ...options, ...nextOptions })
    const key = keyHex(record.topic)
    record.autobase = autobase
    record.swarm = swarm
    records.set(key, record)
    scheduleRefresh(key, record, nextOptions)
    return record
  }

  const refreshRecord = async (autobase, swarm, record, nextOptions = {}) => {
    if (!record) return null
    const refreshed = await refreshMirroredVideo(autobase, swarm, record, { ...options, ...nextOptions })
    const key = keyHex(record.topic)
    records.set(key, record)
    scheduleRefresh(key, record, nextOptions)
    return refreshed
  }

  const refreshAll = async (nextOptions = {}) => {
    const outcomes = []
    for (const record of records.values()) {
      outcomes.push(await refreshRecord(record.autobase, record.swarm, record, nextOptions))
    }
    return outcomes
  }

  const stop = async () => {
    stopped = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const record of records.values()) {
      try { await record.close?.() } catch { /* best effort cleanup */ }
    }
    records.clear()
  }

  return {
    register,
    registerFromUrl,
    refreshRecord,
    refreshAll,
    stop,
    records,
    refreshManager,
  }
}

export default {
  seedMirroredVideo,
  seedDiscoveredVideo,
  refreshMirroredVideo,
  createMirrorSeeder,
}
