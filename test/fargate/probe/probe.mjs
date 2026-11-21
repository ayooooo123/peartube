import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import id from 'hypercore-id-encoding'
import { startConnectivity } from './dht-probe.mjs'
import { startRelayedPeer } from './relayed-peer.mjs'

const env = process.env
const kinds = ['peartube', 'blind-peer', 'blind-relay', 'relayed-peer']
const roles = ['pt-direct', 'pt-relayed', 'bp', 'br', 'rp']
const hex = text => typeof text === 'string' && /^[0-9a-f]{64}$/i.test(text)

function config () {
  if (!env.RUN || !env.KIND || !kinds.includes(env.KIND) || !roles.includes(env.ROLE) || !env.TOPIC_SEED) {
    throw new Error('RUN, KIND, ROLE and TOPIC_SEED are required')
  }
  const deadline = Number(env.DEADLINE_MIN)
  const sample = Number(env.SAMPLE_MS || 5000)
  const maxConns = Number(env.RP_MAX_CONNS || 6)
  if (!(deadline > 0) || !Number.isFinite(deadline) || !(sample > 0) || !Number.isFinite(sample) ||
      !Number.isSafeInteger(maxConns) || maxConns < 1) throw new Error('Invalid deadline, sample period or connection limit')
  const relayKeys = (env.RELAY_KEYS || '').split(',').filter(Boolean).map(key => {
    if (!hex(key)) throw new Error('RELAY_KEYS must contain 32-byte hex keys')
    return Buffer.from(key, 'hex')
  })
  let subset = null
  if (env.KIND === 'relayed-peer') {
    if (!hex(env.CHANNEL_KEY)) throw new Error('CHANNEL_KEY must be a 32-byte hex key')
    try { subset = JSON.parse(env.SUBSET_JSON) } catch { throw new Error('SUBSET_JSON must be valid JSON') }
    if (!subset || !Array.isArray(subset.entries) || subset.channel?.toLowerCase() !== env.CHANNEL_KEY.toLowerCase() ||
        !Number.isFinite(subset.totalBytes) || subset.totalBytes < 0) throw new Error('Invalid subset')
    for (const entry of subset.entries) {
      if (!hex(entry.blobs) || !Number.isSafeInteger(entry.blockOffset) || entry.blockOffset < 0 ||
          !Number.isSafeInteger(entry.blockLength) || entry.blockLength <= 0 || !Number.isFinite(entry.size) || entry.size < 0) {
        throw new Error('Invalid subset entry')
      }
    }
  }
  return { deadline, sample, maxConns, relayKeys, subset }
}

async function json (url, timeout = 2500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function filesSize (path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = join(path, entry.name)
    if (entry.isDirectory()) total += await filesSize(name)
    else if (entry.isFile()) {
      try { total += (await stat(name)).size } catch (err) { if (err.code !== 'ENOENT') throw err }
    }
  }
  return total
}

function makeEcs (uri, metadata) {
  const prior = new Map()
  const names = new Map((metadata?.Containers || []).map(container => [container.DockerId, container.Name]))
  const taskCpu = Number(metadata?.Limits?.CPU) || null
  return async () => {
    if (!uri) return null
    let stats
    try { stats = await json(`${uri}/task/stats`) } catch { return null }
    const cpuPct = {}
    const memBytes = {}
    const networks = new Map()
    for (const [containerId, item] of Object.entries(stats)) {
      const name = names.get(containerId) || containerId
      const cpu = item.cpu_stats || {}
      const total = cpu.cpu_usage?.total_usage
      const system = cpu.system_cpu_usage
      const old = prior.get(containerId)
      const cores = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1
      cpuPct[name] = old && taskCpu && system > old.system && total >= old.total
        ? (total - old.total) / (system - old.system) * cores * 100 / taskCpu : null
      if (Number.isFinite(total) && Number.isFinite(system)) prior.set(containerId, { total, system })
      memBytes[name] = item.memory_stats?.usage ?? null
      for (const [iface, net] of Object.entries(item.networks || {})) {
        const existing = networks.get(iface) || { rx: 0, tx: 0 }
        existing.rx = Math.max(existing.rx, net.rx_bytes || 0)
        existing.tx = Math.max(existing.tx, net.tx_bytes || 0)
        networks.set(iface, existing)
      }
    }
    let rx = 0
    let tx = 0
    for (const net of networks.values()) { rx += net.rx; tx += net.tx }
    return { cpuPct, memBytes, rx, tx }
  }
}

export async function runProbe ({ bootstrap } = {}) {
  const startedAt = Date.now()
  const options = config()
  const base = { v: 1, run: env.RUN, kind: env.KIND, role: env.ROLE }
  let task = 'local'
  let metadata = null
  let connectivity = null
  let peer = null
  let stopped = false
  let firstByte = false
  let fullCopy = false
  let bpInitial = null
  let sampling = false
  let sampleTimer
  let deadlineTimer
  const metadataUri = env.ECS_CONTAINER_METADATA_URI_V4
  let finish
  const finished = new Promise(resolve => { finish = resolve })

  function line (type, fields) {
    console.log(JSON.stringify({ ...base, type, task, ts: Date.now(), t: Date.now() - startedAt, ...fields }))
  }
  function event (ev, detail = {}) {
    if (!stopped || ev === 'deadline') line('event', { ev, detail })
  }

  async function shutdown (deadline) {
    if (stopped) return
    stopped = true
    clearInterval(sampleTimer)
    clearTimeout(deadlineTimer)
    if (deadline) event('deadline')
    const force = setTimeout(() => process.exit(0), 3000)
    await Promise.allSettled([peer?.close(), connectivity?.close()])
    clearTimeout(force)
    finish()
  }
  process.once('SIGTERM', () => shutdown(false))
  process.once('SIGINT', () => shutdown(false))
  if (metadataUri) {
    try {
      const remaining = Math.max(1, Math.ceil(options.deadline * 60000 - (Date.now() - startedAt)))
      metadata = await json(`${metadataUri}/task`, Math.min(2500, remaining))
      task = metadata.TaskARN?.split('/').pop()?.slice(0, 8) || 'unknown'
    } catch {}
  }
  if (stopped) return finished
  event('start', {
    taskArn: metadata?.TaskARN ?? null,
    startedAt: metadata?.StartedAt ?? new Date(startedAt).toISOString(),
    vcpu: metadata?.Limits?.CPU ?? null,
    memMiB: metadata?.Limits?.Memory ?? null,
    image: metadata?.Containers?.find(container => container.Name === 'probe')?.Image ?? null
  })
  const remaining = Math.max(0, options.deadline * 60000 - (Date.now() - startedAt))
  if (!remaining) {
    await shutdown(true)
    return finished
  }
  deadlineTimer = setTimeout(() => shutdown(true), remaining)
  const ecs = makeEcs(metadataUri, metadata)
  try {
    connectivity = startConnectivity({ role: env.ROLE, topicSeed: env.TOPIC_SEED, relayKeys: options.relayKeys, onEvent: event, bootstrap })
  } catch (err) { event('error', { where: 'probe-start', message: err.message }) }
  if (env.KIND === 'relayed-peer') {
    try {
      peer = await startRelayedPeer({
        subset: options.subset, channelKey: env.CHANNEL_KEY, maxConns: options.maxConns,
        relayKeys: () => connectivity?.relayKeys() || options.relayKeys,
        relayAddress: key => connectivity?.relayAddress(key) || null,
        onEvent: event, startedAt, storage: env.RP_STORE || '/data/rp', bootstrap
      })
    } catch (err) { event('error', { where: 'rp-start', message: err.message }) }
  }
  if (stopped) {
    await peer?.close()
    return finished
  }
  if (!stopped) event('ready')

  async function sample () {
    if (stopped || sampling) return
    sampling = true
    try {
      const fields = { ecs: await ecs() }
      if (env.KIND === 'peartube') {
        try {
          const api = env.PT_API || 'http://127.0.0.1:8174'
          const [status, plugins] = await Promise.all([json(`${api}/v1/status`), json(`${api}/v1/plugins`)])
          const info = plugins.plugins?.find(plugin => plugin.name === 'p2p-replicate')
          if (info) {
            const rep = {}
            for (const key of ['enabled', 'replicating', 'replicatedBytes', 'replicatedEntries', 'totalEntries', 'targetBytes', 'skippedDiskFull', 'skippedUnavailable', 'activeSlices', 'freeDiskBytes']) rep[key] = info[key] ?? null
            fields.pt = {
              peers: status.peers, lanPeers: status.lanPeers, publicPeers: status.routes?.public?.peers,
              rxBytes: status.rxBytes, txBytes: status.txBytes, downBps: status.downBps, upBps: status.upBps,
              cachedBytes: status.cachedBytes, rtt: status.rtt, retransmits: status.retransmits, rep
            }
            if (!firstByte && rep.replicatedBytes > 0) { firstByte = true; event('first-byte', { replicatedBytes: rep.replicatedBytes }) }
            if (!fullCopy && Number.isFinite(rep.targetBytes) && rep.totalEntries > 0 && rep.replicatedEntries === rep.totalEntries && rep.replicatedBytes >= rep.targetBytes) {
              fullCopy = true
              event('full-copy', { replicatedBytes: rep.replicatedBytes })
            }
          }
        } catch {}
      } else if (env.KIND === 'blind-peer') {
        let bytes = null
        try { bytes = await filesSize(env.BP_STORE || '/bpstore') } catch {}
        fields.bp = { storeBytes: bytes, key: null }
        if (bytes !== null && bpInitial === null) bpInitial = bytes
        if (!firstByte && bytes !== null && bpInitial !== null && bytes - bpInitial > 1024 * 1024) {
          firstByte = true
          event('first-byte', { storeBytes: bytes, initialBytes: bpInitial })
        }
      } else if (env.KIND === 'blind-relay') {
        let key = null
        try {
          const log = await readFile(env.SHARED_LOG || '/shared/relay.log', 'utf8')
          const match = log.match(/Server listening on\s+([a-z0-9]{52})/i)
          if (match) key = id.decode(match[1]).toString('hex')
        } catch {}
        fields.br = { key }
      } else if (peer) {
        try { fields.rp = await peer.sample() } catch (err) { event('error', { where: 'rp-sample', message: err.message }) }
      }
      fields.probe = connectivity?.sample() || null
      if (!stopped) line('sample', fields)
    } catch (err) {
      event('error', { where: 'sample', message: err.message })
    } finally {
      sampling = false
    }
  }
  sampleTimer = setInterval(sample, options.sample)
  await sample()
  await finished
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProbe().catch(err => {
    console.error(err.message)
    process.exitCode = 1
  })
}
