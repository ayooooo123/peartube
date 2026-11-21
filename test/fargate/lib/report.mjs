// Report for the Fargate swarm test.
//
// writeReport({ run, from, resultsDir, arch }) reads the files the collector
// leaves in a run directory:
//   events.jsonl or events.sample.jsonl  (required)
//   tasks.json                           (optional; inferred from events)
//   scrape.jsonl, home.jsonl, owner.jsonl (optional)
//
// It writes report.md, summary.json and cost.json into resultsDir. The report
// has five tables:
//   1. per step and kind: timings, throughput, CPU, memory, skipped
//   2. route evidence: real relayed-peer streams, PearTube tasks, scrape and
//      owner-client counters, with the pt-relayed route stated as not observable
//   3. connectivity check: the probe's own DHT and forced-relay test numbers,
//      kept clearly apart from PearTube transfers
//   4. home relay latency and uplink tx deltas per step
//   5. cost: expected from measured counters, worst at 80% of every cap
//
// Missing values are written as `n/a: <reason>` in Markdown and as null plus a
// reason string in JSON. Nothing is estimated into a blank cell.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPS, MIX, PRICES, calculateCost } from './cost.mjs'
import { scrubArtifact } from './scrape.mjs'
import { blindPeerLogKey } from './aws.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FARGATE_DIR = path.dirname(HERE)
const MIB = 1024 * 1024
const KIND_ORDER = ['peartube', 'blind-peer', 'blind-relay', 'relayed-peer']
const ROLE_ORDER = ['pt-direct', 'pt-relayed', 'bp', 'br', 'rp']

function toNum (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function timeMs (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

function isNum (value) {
  return typeof value === 'number' && Number.isFinite(value)
}

// The sample's blind peer key may be z32 while the owner client writes hex.
// Decode z-base-32 the way the z32 package does, so the two lines meet.
const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'

function z32ToHex (value) {
  const input = value.toLowerCase()
  const bytes = []
  let position = 0
  const quintet = () => Z32_ALPHABET.indexOf(input[position++])
  const remainder = input.length & 7
  const groups = (input.length - remainder) / 8

  for (let i = 0; i < groups; i++) {
    const a = quintet()
    const b = quintet()
    const c = quintet()
    const d = quintet()
    const e = quintet()
    const f = quintet()
    const g = quintet()
    const h = quintet()
    if ([a, b, c, d, e, f, g, h].some(v => v < 0)) return null
    bytes.push((a << 3) | (b >>> 2))
    bytes.push(((b & 3) << 6) | (c << 1) | (d >>> 4))
    bytes.push(((d & 15) << 4) | (e >>> 1))
    bytes.push(((e & 1) << 7) | (f << 2) | (g >>> 3))
    bytes.push(((g & 7) << 5) | h)
  }

  if (remainder >= 4) {
    const a = quintet()
    const b = quintet()
    const c = quintet()
    const d = quintet()
    if ([a, b, c, d].some(v => v < 0)) return null
    bytes.push((a << 3) | (b >>> 2))
    bytes.push(((b & 3) << 6) | (c << 1) | (d >>> 4))
  }
  if (remainder > 4) return null
  if (bytes.length !== 32) return null
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function keyId (value) {
  if (typeof value !== 'string') return ''
  const lower = value.toLowerCase()
  if (/^[0-9a-f]{64}$/.test(lower)) return lower
  if (/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(lower)) {
    return z32ToHex(lower) || lower
  }
  return lower
}

function mean (values) {
  const valid = values.filter(isNum)
  if (valid.length === 0) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function median (values) {
  const valid = values.filter(isNum).sort((a, b) => a - b)
  if (valid.length === 0) return null
  const middle = Math.floor(valid.length / 2)
  return valid.length % 2 === 1
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2
}

function maxOf (values) {
  const valid = values.filter(isNum)
  return valid.length === 0 ? null : Math.max(...valid)
}

function sumNumbers (object) {
  if (!object || typeof object !== 'object') return null
  let sum = 0
  let any = false
  for (const value of Object.values(object)) {
    if (isNum(value)) {
      sum += value
      any = true
    }
  }
  return any ? sum : null
}

function stat (values) {
  const valid = values.filter(isNum).sort((a, b) => a - b)
  if (valid.length === 0) return { n: 0, median: null, p95: null, max: null }
  return { n: valid.length, median: median(valid), p95: valid[Math.ceil(valid.length * 0.95) - 1], max: valid[valid.length - 1] }
}

function parseLines (text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') lines.push(value)
    } catch {
      // The stock containers write plain lines too. They are kept by collect
      // and ignored here, as SCHEMA.md says.
    }
  }
  return lines
}

async function readText (file) {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function dedupe (lines) {
  const seen = new Set()
  return lines.filter(line => {
    const key = JSON.stringify(line)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function readInputs (dir) {
  let eventsName = 'events.jsonl'
  let eventsText = await readText(path.join(dir, eventsName))
  if (eventsText === null) {
    eventsName = 'events.sample.jsonl'
    eventsText = await readText(path.join(dir, eventsName))
  }
  if (eventsText === null) {
    throw new Error('no events.jsonl or events.sample.jsonl in ' + dir)
  }

  const eventLines = parseLines(eventsText)
  const tasksText = await readText(path.join(dir, 'tasks.json'))
  let tasksJson = null
  if (tasksText !== null) {
    let parsed
    try {
      parsed = JSON.parse(tasksText)
    } catch (err) {
      throw new Error('tasks.json is not valid JSON: ' + err.message)
    }
    if (!Array.isArray(parsed)) throw new Error('tasks.json must be an array')
    tasksJson = parsed
  }

  const ownerText = await readText(path.join(dir, 'owner.jsonl'))
  const scrapeText = await readText(path.join(dir, 'scrape.jsonl'))
  const homeText = await readText(path.join(dir, 'home.jsonl'))

  const embedded = type => eventLines.filter(line => line.type === type)
  const owner = dedupe([...parseLines(ownerText), ...embedded('owner')])
  const scrape = dedupe([...parseLines(scrapeText), ...embedded('scrape')])
  const home = dedupe([...parseLines(homeText), ...embedded('home')])

  return {
    eventsName,
    eventLines,
    tasksJson,
    owner,
    scrape,
    home,
    sources: {
      events: eventsName,
      tasks: tasksJson ? 'tasks.json' : 'events',
      owner: ownerText !== null ? 'owner.jsonl' : embedded('owner').length > 0 ? 'events' : 'none',
      scrape: scrapeText !== null ? 'scrape.jsonl' : embedded('scrape').length > 0 ? 'events' : 'none',
      home: homeText !== null ? 'home.jsonl' : embedded('home').length > 0 ? 'events' : 'none'
    }
  }
}

function indexLines (lines) {
  const starts = new Map()
  const deadlines = new Map()
  const samples = new Map()
  const events = new Map()

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    if (line.type === 'sample' && typeof line.task === 'string') {
      if (!samples.has(line.task)) samples.set(line.task, [])
      samples.get(line.task).push(line)
      continue
    }
    if (line.type !== 'event' || typeof line.task !== 'string') continue
    if (!events.has(line.task)) events.set(line.task, [])
    events.get(line.task).push(line)
    if (line.ev === 'start' && !starts.has(line.task)) starts.set(line.task, line)
    if (line.ev === 'deadline') deadlines.set(line.task, line)
  }

  for (const list of samples.values()) {
    list.sort((a, b) => (toNum(a.ts) || 0) - (toNum(b.ts) || 0))
  }
  for (const list of events.values()) {
    list.sort((a, b) => (toNum(a.ts) || 0) - (toNum(b.ts) || 0))
  }

  return { starts, deadlines, samples, events }
}

function countByRole (tasks) {
  const counts = new Map()
  for (const task of tasks) {
    const key = (task.kind || 'unknown') + '|' + (task.role || 'unknown')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function sameCounts (left, right) {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

function mixCounts (entry) {
  const counts = new Map()
  for (const group of entry.tasks) {
    const key = group.kind + '|' + group.role
    counts.set(key, (counts.get(key) || 0) + group.count)
  }
  return counts
}

function assignStep (sorted, from, to, step, steps) {
  for (let i = from; i < to; i++) steps.set(sorted[i].task, step)
}

function inferSteps (tasks) {
  const steps = new Map()
  const sorted = [...tasks].sort((a, b) => {
    const left = a.startMs === null ? Infinity : a.startMs
    const right = b.startMs === null ? Infinity : b.startMs
    return left - right || a.task.localeCompare(b.task)
  })
  const counts = countByRole(tasks)
  const total = tasks.length
  const matches = index => MIX[index].total === total &&
    sameCounts(mixCounts(MIX[index]), counts)

  if (matches(0)) {
    assignStep(sorted, 0, total, 1, steps)
    return { steps, basis: 'MIX order (1)' }
  }
  if (matches(1)) {
    assignStep(sorted, 0, 1, 1, steps)
    assignStep(sorted, 1, total, 5, steps)
    return { steps, basis: 'MIX order (1/5)' }
  }
  if (matches(2)) {
    assignStep(sorted, 0, 1, 1, steps)
    assignStep(sorted, 1, 5, 5, steps)
    assignStep(sorted, 5, total, 20, steps)
    return { steps, basis: 'MIX order (1/5/20)' }
  }

  // Fall back to start-time clusters when a task failed to launch or a step
  // was skipped. Ten minutes separates one step's blind relays from the rest
  // of that step without splitting a normal launch.
  const clusters = []
  for (const task of sorted) {
    if (task.startMs === null) continue
    const last = clusters[clusters.length - 1]
    if (!last || task.startMs - last.lastMs > 10 * 60 * 1000) {
      clusters.push({ lastMs: task.startMs, tasks: [task] })
    } else {
      last.lastMs = Math.max(last.lastMs, task.startMs)
      last.tasks.push(task)
    }
  }
  const clusterSizes = clusters.map(cluster => cluster.tasks.length)
  const expectedSizes = MIX.slice(0, clusters.length).map((entry, index) =>
    entry.total - (index === 0 ? 0 : MIX[index - 1].total))
  const sizesMatch = clusters.length >= 2 && clusters.length <= MIX.length &&
    clusterSizes.every((size, index) => size === expectedSizes[index])
  if (!sizesMatch) return { steps, basis: 'unknown' }

  for (let i = 0; i < clusters.length; i++) {
    for (const task of clusters[i].tasks) steps.set(task.task, MIX[i].step)
  }
  return {
    steps,
    basis: clusters.length === 2 ? 'start-time clusters (1/5)' : 'start-time clusters (1/5/20)'
  }
}

function buildTaskSkeletons (tasksJson, index) {
  let tasks
  let source

  if (Array.isArray(tasksJson) && tasksJson.length > 0) {
    source = 'tasks.json'
    tasks = tasksJson
      .filter(task => task && typeof task === 'object' && typeof task.task === 'string')
      .map(task => ({
        task: task.task,
        kind: typeof task.kind === 'string' ? task.kind : null,
        role: typeof task.role === 'string' ? task.role : null,
        step: toNum(task.step),
        startedAt: task.startedAt ?? null,
        stoppedAt: task.stoppedAt ?? null,
        vcpu: toNum(task.vcpu),
        memMiB: toNum(task.memMiB),
        publicIp: typeof task.publicIp === 'string' && task.publicIp ? task.publicIp : null,
        image: typeof task.image === 'string' ? task.image : null
      }))
  } else if (index.starts.size > 0) {
    source = 'events'
    tasks = [...index.starts.values()].map(start => ({
      task: start.task,
      kind: typeof start.kind === 'string' ? start.kind : null,
      role: typeof start.role === 'string' ? start.role : null,
      step: null,
      startedAt: start.detail?.startedAt ?? start.ts ?? null,
      stoppedAt: null,
      vcpu: toNum(start.detail?.vcpu),
      memMiB: toNum(start.detail?.memMiB),
      publicIp: null,
      image: typeof start.detail?.image === 'string' ? start.detail.image : null
    }))
  } else {
    source = index.samples.size > 0 ? 'sample events' : 'none'
    tasks = [...index.samples.entries()].map(([task, list]) => {
      const sample = list[0]
      return {
        task,
        kind: typeof sample.kind === 'string' ? sample.kind : null,
        role: typeof sample.role === 'string' ? sample.role : null,
        step: null,
        startedAt: sample.ts ?? null,
        stoppedAt: null,
        vcpu: null,
        memMiB: null,
        publicIp: null,
        image: null
      }
    })
  }

  for (const task of tasks) {
    const start = index.starts.get(task.task)
    const samples = index.samples.get(task.task) || []
    const last = samples.length > 0 ? samples[samples.length - 1] : null

    if (task.kind === null) task.kind = typeof start?.kind === 'string' ? start.kind : null
    if (task.role === null) task.role = typeof start?.role === 'string' ? start.role : null
    if (task.startedAt === null) {
      task.startedAt = start?.detail?.startedAt ?? start?.ts ?? samples[0]?.ts ?? null
    }
    if (task.vcpu === null) task.vcpu = toNum(start?.detail?.vcpu)
    if (task.memMiB === null) task.memMiB = toNum(start?.detail?.memMiB)
    if (task.stoppedAt === null) {
      task.stoppedAt = index.deadlines.get(task.task)?.ts ?? last?.ts ?? null
    }
    task.step = toNum(task.step)
    task.startMs = timeMs(task.startedAt)
    task.stopMs = timeMs(task.stoppedAt)
    task.samples = samples
    task.lastSample = last
    task.events = index.events.get(task.task) || []
  }

  let stepBasis = 'tasks.json'
  let stepNote = null
  if (tasks.some(task => task.step === null)) {
    const inferred = inferSteps(tasks)
    for (const task of tasks) {
      if (task.step === null) task.step = inferred.steps.get(task.task) ?? null
    }
    stepBasis = inferred.basis
    if (inferred.basis === 'unknown') {
      stepNote = 'Some tasks have no step: tasks.json had no step and start times could not group them.'
    }
  }

  return { tasks, source, stepBasis, stepNote }
}

function eventOffset (event, startMs) {
  const detailMs = toNum(event?.detail?.ms)
  if (detailMs !== null) return detailMs
  const relative = toNum(event?.t)
  if (relative !== null) return relative
  const ts = toNum(event?.ts)
  if (ts !== null && startMs !== null) return ts - startMs
  return null
}

function sampleOffset (sample, startMs) {
  const relative = toNum(sample?.t)
  if (relative !== null) return relative
  const ts = toNum(sample?.ts)
  if (ts !== null && startMs !== null) return ts - startMs
  return null
}

function firstEvent (raw, name) {
  return (raw.events || []).find(event => event.ev === name) || null
}

function groupOwnerLines (lines) {
  const groups = new Map()
  for (const line of lines) {
    if (line.type !== 'owner' || typeof line.bp !== 'string') continue
    const id = keyId(line.bp)
    if (!groups.has(id)) groups.set(id, { key: line.bp, lines: [] })
    groups.get(id).lines.push(line)
  }

  for (const group of groups.values()) {
    group.lines.sort((a, b) => (timeMs(a.ts) || 0) - (timeMs(b.ts) || 0))
    const last = group.lines[group.lines.length - 1]
    const haveBytes = maxOf(group.lines.map(line => toNum(line.haveBytes)))
    const targetBytes = maxOf(group.lines.map(line => toNum(line.targetBytes)))
    const fullLine = targetBytes !== null && targetBytes > 0
      ? group.lines.find(line => {
        const have = toNum(line.haveBytes)
        const cores = Object.values(line.cores || {}).filter(core => core && core.length > 0)
        return have !== null && have >= targetBytes && cores.length > 0 &&
          cores.every(core => (core.remoteContiguousLength ?? core.remoteContiguous ?? 0) >= core.length)
      })
      : null

    const cores = last?.cores && typeof last.cores === 'object' ? last.cores : null
    let coreCount = 0
    let length = 0
    let remoteLength = 0
    let remoteContiguous = 0
    if (cores) {
      for (const core of Object.values(cores)) {
        if (!core || typeof core !== 'object') continue
        coreCount += 1
        length += toNum(core.length) || 0
        remoteLength += toNum(core.remoteLength) || 0
        remoteContiguous += toNum(core.remoteContiguousLength ?? core.remoteContiguous) || 0
      }
    }

    group.summary = {
      key: group.key,
      events: group.lines.length,
      remote: typeof last?.remote === 'string' ? last.remote : null,
      haveBytes,
      targetBytes,
      cores: coreCount > 0
        ? { count: coreCount, length, remoteLength, remoteContiguous }
        : null,
      progress: targetBytes !== null && targetBytes > 0 && haveBytes !== null
        ? haveBytes / targetBytes
        : null,
      fullAt: fullLine ? timeMs(fullLine.ts) : null
    }
  }

  return groups
}

function pearTubeRelayCount (samples) {
  let found = null
  const take = value => {
    const number = toNum(value)
    if (number !== null) found = found === null ? number : Math.max(found, number)
  }
  for (const sample of samples) {
    const pt = sample.pt
    if (!pt || typeof pt !== 'object') continue
    take(pt.forcedRelays)
    take(pt.relayedConnections)
    take(pt.relayedConns)
    const routes = pt.routes
    if (!routes || typeof routes !== 'object') continue
    take(routes.relayed)
    if (routes.relayed && typeof routes.relayed === 'object') {
      take(routes.relayed.peers)
      take(routes.relayed.connections)
    }
  }
  return found
}

function collectRpConns (raw) {
  const records = new Map()
  const add = record => {
    if (!record || typeof record !== 'object') return
    const key = [record.peer ?? '', record.relay ?? '', record.remote ?? ''].join('|')
    const candidate = {
      peer: typeof record.peer === 'string' ? record.peer : null,
      relay: typeof record.relay === 'string' ? record.relay : null,
      remote: typeof record.remote === 'string' ? record.remote : null,
      pairMs: toNum(record.pairMs),
      rtt: toNum(record.rtt),
      rx: toNum(record.rx),
      tx: toNum(record.tx),
      ageMs: toNum(record.ageMs),
      ok: record.ok !== false,
      err: typeof record.err === 'string' ? record.err : null
    }
    const existing = records.get(key)
    if (!existing || (candidate.ageMs ?? 0) >= (existing.ageMs ?? 0)) {
      records.set(key, candidate)
    }
  }

  for (const event of raw.events || []) {
    if (event.ev === 'conn-open' || event.ev === 'conn-close') add(event.detail)
  }
  for (const sample of raw.samples || []) {
    if (!Array.isArray(sample.rp?.conns)) continue
    for (const record of sample.rp.conns) add(record)
  }

  return [...records.values()]
}

function relayTestSummary (samples) {
  let tests = null
  for (let i = samples.length - 1; i >= 0; i--) {
    const list = samples[i].probe?.relayTests
    if (Array.isArray(list) && list.length > 0) {
      tests = list
      break
    }
  }
  if (tests === null) return { tests: [], summary: null }

  const pairMs = []
  const mbps = []
  const addedRttMs = []
  let ok = 0
  for (const test of tests) {
    if (test?.ok !== false) ok += 1
    const pair = toNum(test?.pairMs)
    if (pair !== null) pairMs.push(pair)
    const rate = toNum(test?.mbps)
    if (rate !== null) mbps.push(rate)
    const rtt = toNum(test?.rttMs)
    const direct = toNum(test?.directRttMs)
    if (rtt !== null && direct !== null) addedRttMs.push(rtt - direct)
  }

  return {
    tests,
    summary: {
      n: tests.length,
      ok,
      pairMs: stat(pairMs),
      mbps: stat(mbps),
      addedRttMs: stat(addedRttMs)
    }
  }
}

function buildProbeSummary (samples) {
  const last = samples.length > 0 ? samples[samples.length - 1] : null
  const lastProbe = last?.probe
  if (!lastProbe || typeof lastProbe !== 'object') return null

  const connects = {
    client: { attempted: null, opened: null },
    server: { attempted: null, opened: null }
  }
  for (const sample of samples) {
    for (const side of ['client', 'server']) {
      for (const field of ['attempted', 'opened']) {
        const value = toNum(sample.probe?.connects?.[side]?.[field])
        if (value === null) continue
        const current = connects[side][field]
        connects[side][field] = current === null ? value : Math.max(current, value)
      }
    }
  }

  const nat = lastProbe.nat && typeof lastProbe.nat === 'object'
    ? {
        firewalled: typeof lastProbe.nat.firewalled === 'boolean' ? lastProbe.nat.firewalled : null,
        randomized: typeof lastProbe.nat.randomized === 'boolean' ? lastProbe.nat.randomized : null
      }
    : null

  const relay = relayTestSummary(samples)

  return {
    connects,
    nat,
    relayTests: relay.tests,
    relaySummary: relay.summary
  }
}

function buildTaskModel (raw, ownerByKey, subsetBytes) {
  const samples = raw.samples || []
  const last = raw.lastSample || null
  const durationSec = raw.startMs !== null && raw.stopMs !== null && raw.stopMs >= raw.startMs
    ? (raw.stopMs - raw.startMs) / 1000
    : null

  const cpuValues = samples.map(sample => sumNumbers(sample.ecs?.cpuPct)).filter(isNum)
  const memoryValues = samples.map(sample => sumNumbers(sample.ecs?.memBytes)).filter(isNum)
  const cpuPct = mean(cpuValues)
  const memoryBytes = mean(memoryValues)
  const memMiBMean = memoryBytes === null ? null : memoryBytes / MIB
  const txBytes = maxOf(samples.map(sample => toNum(sample.ecs?.tx)))
  const rxBytes = maxOf(samples.map(sample => toNum(sample.ecs?.rx)))

  const pt = last?.pt
    ? {
        peers: toNum(last.pt.peers),
        publicPeers: toNum(last.pt.publicPeers),
        rxBytes: toNum(last.pt.rxBytes),
        txBytes: toNum(last.pt.txBytes),
        cachedBytes: toNum(last.pt.cachedBytes),
        replicatedBytes: maxOf(samples.map(sample => toNum(sample.pt?.rep?.replicatedBytes))),
        targetBytes: maxOf(samples.map(sample => toNum(sample.pt?.rep?.targetBytes))),
        skippedDiskFull: maxOf(samples.map(sample => toNum(sample.pt?.rep?.skippedDiskFull))),
        skippedUnavailable: maxOf(samples.map(sample => toNum(sample.pt?.rep?.skippedUnavailable))),
        forcedRelayCount: pearTubeRelayCount(samples)
      }
    : null

  const bpKey = (() => {
    for (let i = samples.length - 1; i >= 0; i--) {
      const key = samples[i].bp?.key
      if (typeof key === 'string' && key !== '') return key
    }
    return raw.loggedPeerKey || null
  })()
  const owner = bpKey !== null ? ownerByKey.get(keyId(bpKey)) || null : null
  const series = samples.map(sample => ({
    ts: timeMs(sample.ts),
    bytes: raw.kind === 'peartube' ? toNum(sample.pt?.rep?.replicatedBytes) : raw.kind === 'relayed-peer' ? toNum(sample.rp?.haveBytes) : null,
    cpu: sample.ecs?.cpuPct || {},
    memory: sample.ecs?.memBytes || {},
    skipped: toNum(sample.pt?.rep?.skippedDiskFull)
  }))
  if (raw.kind === 'blind-peer' && owner) {
    for (const line of owner.lines) series.push({ ts: timeMs(line.ts), bytes: toNum(line.haveBytes), cpu: {}, memory: {} })
  }
  series.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  const bp = (bpKey !== null || samples.some(sample => sample.bp))
    ? {
        key: bpKey,
        storeBytes: maxOf(samples.map(sample => toNum(sample.bp?.storeBytes))),
        owner: owner ? owner.summary : null
      }
    : null

  const rpLast = last?.rp
  const rp = rpLast || samples.some(sample => sample.rp)
    ? {
        haveBytes: maxOf(samples.map(sample => toNum(sample.rp?.haveBytes))),
        targetBytes: maxOf(samples.map(sample => toNum(sample.rp?.targetBytes))),
        firstByteT: toNum(rpLast?.firstByteT),
        fullCopyT: toNum(rpLast?.fullCopyT),
        reads: Array.isArray(rpLast?.reads) ? rpLast.reads : [],
        conns: collectRpConns(raw)
      }
    : null

  const probe = buildProbeSummary(samples)

  let firstMs = eventOffset(firstEvent(raw, 'first-byte'), raw.startMs)
  let fullMs = eventOffset(firstEvent(raw, 'full-copy'), raw.startMs)
  let delivered = null
  let target = null
  let skippedDiskFull = null
  let skippedUnavailable = null

  if (raw.kind === 'peartube') {
    delivered = pt?.replicatedBytes ?? null
    target = pt?.targetBytes ?? null
    skippedDiskFull = pt?.skippedDiskFull ?? null
    skippedUnavailable = pt?.skippedUnavailable ?? null
    const expected = isNum(subsetBytes) && subsetBytes > 0 ? subsetBytes : target
    const reported = toNum(firstEvent(raw, 'full-copy')?.detail?.replicatedBytes)
    if (!isNum(expected) || !isNum(target) || target < expected || reported === null || reported < expected) fullMs = null
    if (firstMs === null && delivered !== null && delivered > 0) {
      for (const sample of samples) {
        const bytes = toNum(sample.pt?.rep?.replicatedBytes)
        if (bytes !== null && bytes > 0) {
          firstMs = sampleOffset(sample, raw.startMs)
          break
        }
      }
    }
    if (fullMs === null && isNum(expected) && expected > 0) {
      for (const sample of samples) {
        const rep = sample.pt?.rep
        const bytes = toNum(rep?.replicatedBytes), size = toNum(rep?.targetBytes)
        if (isNum(bytes) && isNum(size) && size >= expected && bytes >= size &&
            rep.replicatedEntries > 0 && rep.replicatedEntries >= rep.totalEntries) {
          fullMs = sampleOffset(sample, raw.startMs)
          break
        }
      }
    }
  } else if (raw.kind === 'blind-peer') {
    delivered = bp?.owner?.haveBytes ?? null
    target = bp?.owner?.targetBytes ?? null
    fullMs = null
    if (firstMs === null && bp?.storeBytes !== null && bp?.storeBytes > 1 * MIB) {
      for (const sample of samples) {
        const bytes = toNum(sample.bp?.storeBytes)
        if (bytes !== null && bytes > 1 * MIB) {
          firstMs = sampleOffset(sample, raw.startMs)
          break
        }
      }
    }
    if (fullMs === null && target !== null && target > 0 && (!isNum(subsetBytes) || target >= subsetBytes) && bp?.owner?.fullAt != null) {
      fullMs = bp.owner.fullAt - raw.startMs
    }
  } else if (raw.kind === 'relayed-peer') {
    delivered = rp?.haveBytes ?? null
    target = rp?.targetBytes ?? null
    if (isNum(subsetBytes) && (!isNum(target) || target < subsetBytes)) fullMs = null
    if (firstMs === null && rp?.firstByteT != null) firstMs = rp.firstByteT
    if (fullMs === null && rp?.fullCopyT != null && (!isNum(subsetBytes) || target >= subsetBytes)) fullMs = rp.fullCopyT
    if (firstMs === null && delivered !== null && delivered > 0) {
      for (const sample of samples) {
        const bytes = toNum(sample.rp?.haveBytes)
        if (bytes !== null && bytes > 0) {
          firstMs = sampleOffset(sample, raw.startMs)
          break
        }
      }
    }
    if (fullMs === null && target !== null && target > 0 && (!isNum(subsetBytes) || target >= subsetBytes)) {
      for (const sample of samples) {
        const bytes = toNum(sample.rp?.haveBytes)
        if (bytes !== null && bytes >= target) {
          fullMs = sampleOffset(sample, raw.startMs)
          break
        }
      }
    }
  }

  let throughputMbps = null
  let throughputSeconds = null
  let throughputBasis = null
  if (delivered !== null && delivered > 0 && firstMs !== null && fullMs !== null && fullMs > firstMs) {
    throughputSeconds = (fullMs - firstMs) / 1000
    throughputMbps = delivered / throughputSeconds / 1e6
    throughputBasis = 'first byte to full copy'
  }

  const reasons = {}
  if (firstMs === null) reasons.firstByte = 'no first-byte event or counter'
  if (fullMs === null) reasons.fullCopy = 'no full-copy event or counter'
  if (throughputMbps === null) reasons.throughput = 'no delivered bytes or timing'
  if (cpuPct === null) reasons.cpu = 'no ECS cpuPct samples'
  if (memMiBMean === null) reasons.memory = 'no ECS memBytes samples'
  if (txBytes === null) reasons.tx = 'no ECS tx counter'
  if (probe === null) reasons.probe = 'no probe section in the task samples'
  if (skippedDiskFull === null && raw.kind === 'peartube') {
    reasons.skipped = 'no p2p-replicate skip counter in the samples'
  }
  if (raw.kind !== 'peartube') reasons.skipped = 'kind has no skip counter'

  return {
    task: raw.task,
    kind: raw.kind,
    role: raw.role,
    step: raw.step,
    image: raw.image,
    startedAt: raw.startMs !== null ? new Date(raw.startMs).toISOString() : null,
    stoppedAt: raw.stopMs !== null ? new Date(raw.stopMs).toISOString() : null,
    startMs: raw.startMs,
    stopMs: raw.stopMs,
    durationSec,
    vcpu: raw.vcpu,
    memMiB: raw.memMiB,
    publicIp: raw.publicIp,
    hasPublicIp: raw.publicIp !== null,
    samples: samples.length,
    series,
    br: raw.kind === 'blind-relay' ? { key: [...samples].reverse().find(sample => sample.br?.key)?.br.key ?? null } : null,
    cpuPct,
    memMiBMean,
    rxBytes,
    txBytes,
    firstByteSec: firstMs !== null ? firstMs / 1000 : null,
    fullCopySec: fullMs !== null ? fullMs / 1000 : null,
    deliveredBytes: delivered,
    targetBytes: target,
    throughputMbps,
    throughputSeconds,
    throughputBasis,
    skippedDiskFull,
    skippedUnavailable,
    pt,
    bp,
    rp,
    probe,
    reasons
  }
}

function aggregateGroup (tasks, step, kind, role, window) {
  const firstByte = stat(tasks.map(task => isNum(task.firstByteSec) && task.startMs + task.firstByteSec * 1000 <= window.end ? task.firstByteSec : null))
  const fullCopy = stat(tasks.map(task => isNum(task.fullCopySec) && task.startMs + task.fullCopySec * 1000 <= window.end ? task.fullCopySec : null))
  const peerRate = stat(tasks.map(task => isNum(task.fullCopySec) && task.startMs + task.fullCopySec * 1000 <= window.end ? task.throughputMbps : null))
  const resources = new Map()
  const changes = []
  for (const task of tasks) {
    const points = task.series.filter(point => isNum(point.ts) && point.ts <= window.end)
    const before = points.filter(point => point.ts <= window.start && isNum(point.bytes)).at(-1)
    const after = points.filter(point => point.ts >= window.start && isNum(point.bytes)).at(-1)
    const baseline = before?.bytes ?? (task.startMs >= window.start ? 0 : null)
    if (after && baseline !== null && after.bytes >= baseline) changes.push(after.bytes - baseline)
    for (const point of points.filter(point => point.ts >= window.start)) {
      for (const [name, value] of Object.entries(point.cpu)) {
        if (!resources.has(name)) resources.set(name, { cpu: [], memory: [] })
        if (isNum(value)) resources.get(name).cpu.push(value)
      }
      for (const [name, value] of Object.entries(point.memory)) {
        if (!resources.has(name)) resources.set(name, { cpu: [], memory: [] })
        if (isNum(value)) resources.get(name).memory.push(value / MIB)
      }
    }
  }
  const bytes = changes.length ? changes.reduce((sum, value) => sum + value, 0) : null
  const seconds = (window.end - window.start) / 1000
  const containers = [...resources].map(([name, values]) => ({
    name, cpuMedian: median(values.cpu), memoryMax: maxOf(values.memory)
  }))
  const peartubeTasks = tasks.filter(task => task.kind === 'peartube')
  const skippedValues = peartubeTasks.map(task => maxOf(task.series.filter(point =>
    point.ts >= window.start && point.ts <= window.end).map(point => point.skipped)))
  const skipped = peartubeTasks.length && skippedValues.every(isNum)
    ? { diskFull: skippedValues.reduce((sum, value) => sum + value, 0), n: peartubeTasks.length }
    : null
  return {
    step, kind, role, tasks: tasks.length, firstByte, fullCopy,
    throughput: {
      mbps: peerRate.median, n: peerRate.n, bytes,
      totalMbps: bytes !== null && isNum(seconds) && seconds > 0 ? bytes / seconds / 1e6 : null,
      contributing: changes.length, seconds
    },
    containers, skipped,
    skippedReason: peartubeTasks.length ? 'a disk-full counter is missing' : 'kind has no skip counter',
    reasons: {
      firstByte: 'no first-byte event or counter',
      fullCopy: 'no owner-confirmed full copy or full-copy event',
      throughput: 'no completed copy with first-byte and full-copy times',
      cpu: 'no ECS cpuPct samples',
      memory: 'no ECS memBytes samples'
    }
  }
}

function buildGroups (tasks) {
  const windows = stepWindows(tasks)
  if (!windows.length) windows.push({ step: null, start: -Infinity, end: Infinity })
  const groups = []
  for (const window of windows) {
    const active = tasks.filter(task => window.step === null || (task.step !== null &&
      task.step <= window.step && task.startMs <= window.end && (task.stopMs === null || task.stopMs >= window.start)))
    const byKind = new Map()
    for (const task of active) {
      const kind = task.kind || 'unknown', role = task.role || kind, key = kind + '|' + role
      if (!byKind.has(key)) byKind.set(key, { kind, role, tasks: [] })
      byKind.get(key).tasks.push(task)
    }
    for (const group of byKind.values()) groups.push(aggregateGroup(group.tasks, window.step, group.kind, group.role, window))
    if (active.length) groups.push(aggregateGroup(active, window.step, 'all', 'all', window))
  }
  groups.sort((a, b) => {
    const leftStep = a.step === null ? Infinity : a.step, rightStep = b.step === null ? Infinity : b.step
    if (leftStep !== rightStep) return leftStep - rightStep
    if (a.kind === 'all' && b.kind !== 'all') return 1
    if (b.kind === 'all' && a.kind !== 'all') return -1
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
  })
  return groups
}

function buildRoutes (tasks, scrapeLines) {
  const relayed = []
  const relayIps = new Set(tasks.filter(task => task.kind === 'blind-relay' && task.publicIp).map(task => task.publicIp))
  for (const task of tasks) {
    if (task.kind !== 'relayed-peer' || !task.rp) continue
    for (const conn of task.rp.conns) {
      relayed.push({
        step: task.step,
        task: task.task,
        peer: conn.peer,
        relay: conn.relay,
        relayIpMatch: conn.remote && relayIps.size && !conn.remote.startsWith('[address]')
          ? relayIps.has(conn.remote.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))
          : null,
        remote: conn.remote,
        ok: conn.ok,
        err: conn.err,
        pairMs: conn.pairMs,
        rtt: conn.rtt,
        rx: conn.rx,
        tx: conn.tx
      })
    }
  }

  const peartube = tasks
    .filter(task => task.kind === 'peartube')
    .map(task => ({
      step: task.step,
      task: task.task,
      role: task.role,
      peers: task.pt?.peers ?? null,
      publicPeers: task.pt?.publicPeers ?? null,
      forcedRelayCount: null
    }))

  const forcedRelays = {
    observable: false, count: null, tasks: 0,
    reason: "not observable from PearTube's API"
  }

  const relays = new Set()
  let ok = 0
  let failed = 0
  for (const conn of relayed) {
    if (conn.relay !== null) relays.add(conn.relay)
    if (conn.ok) ok += 1
    else failed += 1
  }

  const scrapeByAlias = new Map()
  for (const line of scrapeLines) {
    if (line.type !== 'scrape' || typeof line.alias !== 'string') continue
    if (!scrapeByAlias.has(line.alias)) {
      scrapeByAlias.set(line.alias, { alias: line.alias, samples: 0, metrics: {} })
    }
    const entry = scrapeByAlias.get(line.alias)
    entry.samples += 1
    if (line.metrics && typeof line.metrics === 'object') {
      Object.assign(entry.metrics, line.metrics)
    }
  }
  const relayTasks = tasks.filter(task => task.kind === 'blind-relay').map(task => {
    const key = keyId(task.br?.key)
    const scrape = [...scrapeByAlias.values()].find(entry =>
      key && keyId(entry.alias.replace(/^blind-relay-/, '')) === key)
    const metrics = scrape?.metrics || {}
    const opened = toNum(metrics.blind_relay_streams_opened)
    const closed = toNum(metrics.blind_relay_streams_closed)
    const active = opened !== null && closed !== null ? Math.max(0, opened - closed) : null
    const cpu = median(task.series.flatMap(point => Object.entries(point.cpu)
      .filter(([name]) => name !== 'probe').map(([, value]) => value)))
    return { step: task.step, task: task.task, key: task.br?.key ?? null, metrics,
      rx: task.rxBytes, tx: task.txBytes, activeStreams: active,
      cpuPerStream: cpu !== null && active > 0 ? cpu / active : null }
  })

  return {
    relayed,
    relayedCounts: {
      connections: relayed.length,
      relays: relays.size,
      ok,
      failed
    },
    peartube,
    forcedRelays,
    scrape: [...scrapeByAlias.values()],
    relayTasks,
    blindPeer: tasks
      .filter(task => task.kind === 'blind-peer')
      .map(task => ({
        step: task.step,
        task: task.task,
        key: task.bp?.key ?? null,
        owner: task.bp?.owner ?? null
      }))
  }
}

function metricNumberText (value) {
  return value >= 1000 ? value.toFixed(0) : value.toFixed(2)
}

function metricText (name, value) {
  if (isNum(value)) return name + '=' + metricNumberText(value)
  if (!value || typeof value !== 'object') return null
  if (isNum(value.value)) return name + '=' + metricNumberText(value.value)
  if (value.labels && typeof value.labels === 'object') {
    const values = Object.values(value.labels).filter(isNum)
    if (values.length === 0) return null
    const total = values.reduce((sum, number) => sum + number, 0)
    return name + '=' + metricNumberText(total)
  }
  const series = Object.entries(value).filter(([, number]) => isNum(number))
  if (series.length === 0) return null
  if (series.length === 1) {
    const [label, number] = series[0]
    if (label === '') return name + '=' + metricNumberText(number)
    return name + '{' + label + '=' + metricNumberText(number) + '}'
  }
  return name + '{' + series.map(([label, number]) =>
    (label === '' ? 'unlabelled' : label) + '=' + metricNumberText(number)).join(', ') + '}'
}

function parseHomePoints (homeLines) {
  const points = []
  for (const line of homeLines) {
    if (line.type !== 'home') continue
    const ts = timeMs(line.ts)
    if (ts === null) continue
    const relays = Array.isArray(line.relays) ? line.relays : [line]
    for (const relay of relays) {
      const alias = typeof relay.alias === 'string'
        ? relay.alias
        : typeof relay.name === 'string'
          ? relay.name
          : typeof line.alias === 'string'
            ? line.alias
            : (typeof line.relay === 'string' || typeof line.relay === 'number')
              ? 'relay ' + line.relay
              : (typeof relay.relay === 'string' || typeof relay.relay === 'number')
                ? 'relay ' + relay.relay
                : 'home'
      points.push({
        alias,
        ts,
        ms: toNum(relay.latencyMs ?? relay.ms ?? relay.latency ?? relay.rtt),
        txBytes: toNum(relay.txBytes ?? relay.tx ?? relay.uplinkBytes),
        ok: relay.ok !== false
      })
    }
  }
  return points
}

function stepWindows (tasks) {
  const map = new Map()
  for (const task of tasks) {
    if (task.step === null || task.startMs === null) continue
    const key = String(task.step)
    if (!map.has(key)) {
      map.set(key, {
        step: task.step,
        start: task.startMs,
        end: task.stopMs === null ? task.startMs : task.stopMs
      })
    }
    const entry = map.get(key)
    entry.start = Math.min(entry.start, task.startMs)
    entry.end = Math.max(entry.end, task.stopMs === null ? entry.end : task.stopMs)
  }
  const list = [...map.values()].sort((a, b) => a.step - b.step)
  for (let i = 0; i < list.length; i++) {
    if (i + 1 < list.length) list[i].end = list[i + 1].start
  }
  return list
}

function buildHome (homeLines, tasks) {
  if (homeLines.length === 0) {
    return {
      available: false,
      reason: 'no home.jsonl and no home lines in events',
      steps: []
    }
  }
  const points = parseHomePoints(homeLines)
  if (points.length === 0) {
    return {
      available: false,
      reason: 'home lines carry no ts',
      steps: []
    }
  }
  const windows = stepWindows(tasks)
  const scopes = windows.length > 0
    ? windows
    : [{
        step: null,
        start: Math.min(...points.map(point => point.ts)),
        end: Math.max(...points.map(point => point.ts))
      }]

  const steps = scopes.map(scope => {
    const last = scope.step === null
    const inWindow = points.filter(point =>
      point.ts >= scope.start && (last || point.ts < scope.end))
    const aliases = [...new Set(inWindow.map(point => point.alias))]
    const relays = aliases.map(alias => {
      const own = inWindow
        .filter(point => point.alias === alias)
        .sort((a, b) => a.ts - b.ts)
      const okPoints = own.filter(point => point.ok)
      const ms = stat(okPoints.map(point => point.ms).filter(isNum))
      const txPoints = okPoints.filter(point => point.txBytes !== null)
      let txDelta = null
      let txReason = null
      if (txPoints.length < 2) {
        txReason = 'fewer than two tx samples in the step'
      } else {
        const first = txPoints[0].txBytes
        const lastTx = txPoints[txPoints.length - 1].txBytes
        if (lastTx < first) txReason = 'tx counter reset in the step'
        else txDelta = lastTx - first
      }
      return {
        alias,
        samples: own.length,
        latencyMs: ms,
        txBytes: txDelta,
        txReason
      }
    })
    return {
      step: scope.step,
      start: scope.start,
      end: scope.end,
      relays: relays.length > 0
        ? relays
        : [{
            alias: 'all',
            samples: 0,
            latencyMs: { n: 0, median: null, max: null },
            txBytes: null,
            txReason: 'no home sample in the step'
          }]
    }
  })

  return { available: true, reason: null, steps }
}

function buildStepModels (tasks) {
  const map = new Map()
  for (const task of tasks) {
    const key = task.step === null ? 'unknown' : String(task.step)
    if (!map.has(key)) map.set(key, { step: task.step, tasks: [] })
    map.get(key).tasks.push(task)
  }
  return [...map.values()]
    .sort((a, b) => (a.step === null ? Infinity : a.step) - (b.step === null ? Infinity : b.step))
    .map(entry => {
      const starts = entry.tasks.map(task => timeMs(task.startedAt)).filter(isNum)
      const stops = entry.tasks.map(task => timeMs(task.stoppedAt)).filter(isNum)
      const start = starts.length > 0 ? Math.min(...starts) : null
      const stop = stops.length > 0 ? Math.max(...stops) : null
      return {
        step: entry.step,
        tasks: entry.tasks.length,
        startedAt: start === null ? null : new Date(start).toISOString(),
        stoppedAt: stop === null ? null : new Date(stop).toISOString(),
        wallMinutes: start !== null && stop !== null ? (stop - start) / 60000 : null,
        taskHours: entry.tasks.reduce((sum, task) =>
          sum + (task.durationSec === null ? 0 : task.durationSec / 3600), 0),
        byKind: [...entry.tasks.reduce((counts, task) => {
          const key = (task.kind || 'unknown') + '|' + (task.role || 'unknown')
          counts.set(key, (counts.get(key) || 0) + 1)
          return counts
        }, new Map())].map(([key, count]) => {
          const [kind, role] = key.split('|')
          return { kind, role, count }
        })
      }
    })
}

function buildCounts (tasks) {
  const byKind = {}
  for (const task of tasks) {
    const kind = task.kind || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
  }
  const byRole = {}
  for (const task of tasks) {
    const role = task.role || task.kind || 'unknown'
    byRole[role] = (byRole[role] || 0) + 1
  }
  return { total: tasks.length, byKind, byRole }
}

function defaultScheduleHours () {
  const minutes = [45, 40, 40]
  let previous = 0
  let total = 0
  MIX.forEach((entry, index) => {
    const remaining = minutes.slice(index).reduce((sum, value) => sum + value, 0)
    total += (entry.total - previous) * remaining / 60
    previous = entry.total
  })
  return total
}

function buildModel ({ run, arch, logBytes, inputs, generatedAt, subsetBytes }) {
  const index = indexLines(inputs.eventLines)
  const ownerByKey = groupOwnerLines(inputs.owner)
  const skeletons = buildTaskSkeletons(inputs.tasksJson, index)
  const rawTasks = skeletons.tasks
  for (const line of inputs.eventLines) {
    if (line.type !== 'raw') continue
    const peer = blindPeerLogKey({ logStreamName: line.stream, message: line.message })
    const task = peer && rawTasks.find(item => item.task === peer.task && item.kind === 'blind-peer')
    if (task) task.loggedPeerKey = peer.key
  }
  const tasks = rawTasks.map(raw => buildTaskModel(raw, ownerByKey, subsetBytes))
  const groups = buildGroups(tasks)
  const routes = buildRoutes(tasks, inputs.scrape)
  const home = buildHome(inputs.home, tasks)
  const steps = buildStepModels(tasks)
  const costTasks = rawTasks.map(task => ({
    task: task.task,
    kind: task.kind,
    role: task.role,
    step: task.step,
    startedAt: task.startedAt,
    stoppedAt: task.stoppedAt,
    vcpu: task.vcpu,
    memMiB: task.memMiB,
    publicIp: task.publicIp
  }))
  const cost = calculateCost(costTasks, inputs.eventLines, logBytes, arch)

  const notes = []
  if (skeletons.source !== 'tasks.json') {
    notes.push('tasks.json was absent; task metadata came from start, deadline and sample events. Step assignment: ' +
      skeletons.stepBasis + '.')
  }
  if (skeletons.stepNote) notes.push(skeletons.stepNote)
  notes.push('pt-relayed forced relay usage is ' +
    (routes.forcedRelays.observable
      ? 'reported by the probe: ' + routes.forcedRelays.count + ' connection(s) across ' +
        routes.forcedRelays.tasks + ' task(s).'
      : 'not observable: ' + routes.forcedRelays.reason + '.'))
  notes.push('Connectivity check numbers come from the probe DHT and forced relay tests, never from PearTube transfers.')
  notes.push('Missing values are null in JSON and `n/a: reason` in the report. Nothing is estimated into a blank cell.')
  notes.push('ECR storage is not priced: image sizes are not part of the run counters.')

  return {
    run,
    generatedAt,
    arch,
    source: inputs.sources,
    tasksSource: skeletons.source,
    stepBasis: skeletons.stepBasis,
    counts: buildCounts(tasks),
    tasks,
    steps,
    groups,
    routes,
    connectivity: tasks.map(task => ({
      task: task.task,
      step: task.step,
      kind: task.kind,
      role: task.role,
      probe: task.probe,
      reason: task.probe === null ? 'no probe section in the task samples' : null
    })),
    home,
    cost,
    notes
  }
}

// Markdown helpers -----------------------------------------------------------

function md (value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function table (headers, rows) {
  return [
    '| ' + headers.join(' | ') + ' |',
    '|' + headers.map(() => '---').join('|') + '|',
    ...rows.map(row => '| ' + row.map(md).join(' | ') + ' |')
  ].join('\n')
}

function na (reason) {
  return 'n/a: ' + reason
}

function fnum (value, digits = 1) {
  return isNum(value) ? value.toFixed(digits) : null
}

function fsec (seconds) {
  return isNum(seconds) ? seconds.toFixed(1) + ' s' : null
}

function fms (milliseconds) {
  return isNum(milliseconds) ? milliseconds.toFixed(0) + ' ms' : null
}

function fmb (bytes) {
  return isNum(bytes) ? (bytes / 1e6).toFixed(1) + ' MB' : null
}

function fmbs (value) {
  return isNum(value) ? value.toFixed(1) + ' MB/s' : null
}

function fpercent (value) {
  return isNum(value) ? value.toFixed(1) + '%' : null
}

function fmib (value) {
  return isNum(value) ? value.toFixed(1) + ' MiB' : null
}

function fusd (value) {
  return isNum(value) ? '$' + value.toFixed(4) : null
}

function fgb (bytes) {
  return isNum(bytes) ? (bytes / 1e9).toFixed(3) + ' GB' : null
}

function medCell (entry, format, reason) {
  if (!entry || entry.n === 0) return na(reason)
  return format(entry.median) + ' med / ' + format(entry.max) + ' max (n=' + entry.n + ')'
}

function stepLabel (step) {
  return step === null ? 'unknown' : String(step)
}

function groupLabel (group) {
  if (group.kind === 'all') return 'all kinds'
  if (group.kind === 'peartube') return 'peartube (' + group.role + ')'
  return group.kind
}

function countsText (counts) {
  if (counts.total === 0) return na('no task in these results')
  const parts = []
  for (const kind of KIND_ORDER) {
    const count = counts.byKind[kind]
    if (!count) continue
    if (kind === 'peartube') {
      const direct = counts.byRole['pt-direct'] || 0
      const relayed = counts.byRole['pt-relayed'] || 0
      parts.push('peartube ' + count + ' (' + direct + ' pt-direct, ' + relayed + ' pt-relayed)')
    } else {
      parts.push(kind + ' ' + count)
    }
  }
  for (const [kind, count] of Object.entries(counts.byKind)) {
    if (!KIND_ORDER.includes(kind)) parts.push(kind + ' ' + count)
  }
  return parts.join(', ')
}

function isoWindow (start, end) {
  if (!isNum(start) || !isNum(end)) return na('no step window')
  const format = value => {
    const date = new Date(value)
    return String(date.getUTCHours()).padStart(2, '0') + ':' +
      String(date.getUTCMinutes()).padStart(2, '0')
  }
  return format(start) + '-' + format(end) + ' UTC'
}

function renderMarkdown (model) {
  const lines = []
  const cost = model.cost
  const counts = model.counts
  const storageTasks = model.tasks.filter(task => task.kind !== 'blind-relay')
  const fullCopyTasks = storageTasks.filter(task => task.fullCopySec !== null)
  const relayConnections = model.routes.relayedCounts.connections
  const relayTests = model.tasks
    .map(task => task.probe?.relaySummary)
    .filter(summary => summary && summary.n > 0)
  const relayTestCount = relayTests.reduce((sum, summary) => sum + summary.n, 0)
  const relayTestOk = relayTests.reduce((sum, summary) => sum + summary.ok, 0)
  const windowStart = model.tasks.map(task => timeMs(task.startedAt)).filter(isNum)
  const windowStop = model.tasks.map(task => timeMs(task.stoppedAt)).filter(isNum)
  const wallMinutes = windowStart.length > 0 && windowStop.length > 0
    ? (Math.max(...windowStop) - Math.min(...windowStart)) / 60000
    : null
  const expectedTotal = cost.expected.usd.total
  const partial = cost.expected.complete ? '' : ' (partial: ' +
    cost.expected.missingFields.join(', ') + ')'

  lines.push('# Fargate swarm test report')
  lines.push('')
  lines.push('Run `' + model.run + '`. Generated ' + model.generatedAt + '.')
  lines.push('Events source: `' + model.source.events + '`. Prices: ' +
    PRICES.region + ', read ' + PRICES.pricedAt + '. Money is USD; GB is decimal (1e9 bytes).')
  if (model.tasksSource !== 'tasks.json') {
    lines.push('')
    lines.push('`tasks.json` was absent. Task metadata came from `start`, `deadline` and sample events; ' +
      'step assignment: ' + model.stepBasis + '.')
  } else if (model.stepBasis !== 'tasks.json') {
    lines.push('')
    lines.push('Step assignment: ' + model.stepBasis + '.')
  }
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push('- Tasks: ' + countsText(counts) + '.')
  lines.push('- Steps: ' + (model.steps.length > 0
    ? model.steps.map(step => stepLabel(step.step)).join(', ') + '. Wall time: ' +
      (isNum(wallMinutes) ? wallMinutes.toFixed(1) + ' min.' : na('no task start and stop times'))
    : na('no task in these results')))
  lines.push('- Full copy: ' + (storageTasks.length > 0
    ? fullCopyTasks.length + '/' + storageTasks.length + ' download tasks reached the subset.'
    : na('no download task in these results')))
  lines.push('- Real relay streams: ' + (relayConnections > 0
    ? relayConnections + ' connection(s) over ' + model.routes.relayedCounts.relays +
      ' relay key(s), ' + model.routes.relayedCounts.failed + ' failed.'
    : na('no relayed-peer connection record')))
  lines.push('- Connectivity check: ' + (relayTestCount > 0
    ? relayTestCount + ' forced relay test(s), ' + relayTestOk + ' ok. Not PearTube routes.'
    : na('no forced relay test in the samples')))
  lines.push('- Cost: expected ' + (isNum(expectedTotal) ? fusd(expectedTotal) : na('no cost data')) +
    partial + '; at the hard caps ' + fusd(cost.worst.usd.total) +
    ' before unmeasured ECR storage.')
  lines.push('')

  lines.push('## 1. Per step and kind')
  lines.push('')
  lines.push('Peer throughput uses completed copies, from first byte to full copy. Total throughput ' +
    'is the sampled increase in bytes during the step divided by its wall time. CPU and memory ' +
    'are shown for each container. Blind-peer byte counts come from the owner and exclude the channel core.')
  lines.push('')
  const resourceCell = (group, field, format, reason) => group.containers.length
    ? group.containers.map(container => container.name + ': ' + (format(container[field]) || na(reason))).join('; ')
    : na(reason)
  const groupRows = model.groups.map(group => [
    stepLabel(group.step),
    groupLabel(group),
    String(group.tasks),
    medCell(group.firstByte, fsec, group.reasons.firstByte),
    medCell(group.fullCopy, fsec, group.reasons.fullCopy),
    group.throughput.bytes === null ? na('no progress counters in the step') : fmb(group.throughput.bytes) + ' (n=' + group.throughput.contributing + '/' + group.tasks + ')',
    group.throughput.mbps === null ? na(group.reasons.throughput) : fmbs(group.throughput.mbps) + ' (n=' + group.throughput.n + ')',
    group.throughput.totalMbps === null ? na('no progress or step wall time') : fmbs(group.throughput.totalMbps),
    resourceCell(group, 'cpuMedian', fpercent, group.reasons.cpu),
    resourceCell(group, 'memoryMax', fmib, group.reasons.memory),
    group.skipped ? String(group.skipped.diskFull) : na(group.skippedReason)
  ])
  lines.push(table(
    ['Step', 'Kind / role', 'Tasks', 'First replicated byte', 'Full copy', 'Bytes replicated', 'Median peer throughput', 'Total throughput', 'Median CPU by container', 'Max memory by container', 'Skipped disk-full'],
    groupRows
  ))
  lines.push('')
  lines.push('`n/a` reasons name the absent event or counter. Step `all kinds` rows sum only ' +
    'peartube skip counters; other kinds have none.')
  lines.push('')
  lines.push('### Per task')
  lines.push('')
  const taskRows = [...model.tasks]
    .sort((a, b) => {
      const leftStep = a.step === null ? Infinity : a.step
      const rightStep = b.step === null ? Infinity : b.step
      if (leftStep !== rightStep) return leftStep - rightStep
      const leftKind = KIND_ORDER.indexOf(a.kind)
      const rightKind = KIND_ORDER.indexOf(b.kind)
      if (leftKind !== rightKind) return leftKind - rightKind
      return a.task.localeCompare(b.task)
    })
    .map(task => [
      stepLabel(task.step),
      task.task,
      task.kind + (task.role ? ' (' + task.role + ')' : ''),
      task.firstByteSec === null ? na(task.reasons.firstByte) : fsec(task.firstByteSec),
      task.fullCopySec === null ? na(task.reasons.fullCopy) : fsec(task.fullCopySec),
      task.throughputMbps === null
        ? na(task.reasons.throughput)
        : fmbs(task.throughputMbps) + ' (' + task.throughputBasis + ')',
      task.cpuPct === null ? na(task.reasons.cpu) : fpercent(task.cpuPct),
      task.memMiBMean === null ? na(task.reasons.memory) : fmib(task.memMiBMean),
      task.skippedDiskFull === null || task.skippedUnavailable === null
        ? na(task.reasons.skipped || 'no skip counter')
        : task.skippedDiskFull + ' disk-full / ' + task.skippedUnavailable + ' unavailable'
    ])
  lines.push(table(
    ['Step', 'Task', 'Kind / role', 'First replicated byte', 'Full copy', 'Throughput', 'CPU', 'Memory', 'Skipped'],
    taskRows
  ))
  lines.push('')
  lines.push('One row per peer. Throughput is shown only when the peer reached a full copy.')
  lines.push('')

  lines.push('## 2. Route evidence')
  lines.push('')
  lines.push('Stream rows come from the replication connection. Relay rows also show ECS ' +
    'network totals, which include the probe and are not proof of individual transfers.')
  lines.push('')
  lines.push('### Relayed-peer streams (real relay routes)')
  lines.push('')
  if (model.routes.relayed.length === 0) {
    lines.push(na('no relayed-peer connection record in these results'))
  } else {
    const routeRows = model.routes.relayed.map(conn => [
      stepLabel(conn.step),
      conn.task,
      conn.peer === null ? na('no peer key in the record') : conn.peer,
      conn.relay === null ? na('no relay key in the record') : conn.relay,
      conn.remote === null ? na('no remote address in the record') : conn.remote,
      conn.relayIpMatch === null ? na('relay task IP or remote address unavailable') : conn.relayIpMatch ? 'yes' : 'no',
      conn.ok ? 'yes' : 'no' + (conn.err ? ' (' + conn.err + ')' : ''),
      fms(conn.pairMs) || na('no pairing time'),
      fms(conn.rtt) || na('no RTT'),
      fmb(conn.rx) || na('no stream rx counter'),
      fmb(conn.tx) || na('no stream tx counter')
    ])
    lines.push(table(
      ['Step', 'Task', 'Peer', 'Relay', 'Remote address', 'Matches relay IP', 'Opened', 'Pairing', 'RTT', 'Stream rx', 'Stream tx'],
      routeRows
    ))
  }
  lines.push('')
  lines.push('These are the relayed peer\'s own udx stream counters, the relay key the stream ' +
    'was dialed through, and the remote address of the actual replication connection. The ' +
    'route is not inferred from ECS totals or from a separate probe connection.')
  lines.push('')

  lines.push('### PearTube tasks')
  lines.push('')
  if (model.routes.peartube.length === 0) {
    lines.push(na('no peartube task in these results'))
  } else {
    const peartubeRows = model.routes.peartube.map(task => [
      stepLabel(task.step),
      task.task,
      task.role === null ? na('no role in the record') : task.role,
      task.peers === null ? na('no peer count in the sample') : String(task.peers),
      task.publicPeers === null ? na('no public peer count in the sample') : String(task.publicPeers),
      task.role === 'pt-direct'
        ? '0 (no relay configured)'
        : na("not observable from PearTube's API"),
      task.role === 'pt-direct'
        ? 'probe sample; direct by construction'
        : "not observable from PearTube's API"
    ])
    lines.push(table(
      ['Step', 'Task', 'Role', 'Peers', 'Public peers', 'Forced relay routes', 'Evidence'],
      peartubeRows
    ))
  }
  lines.push('')
  lines.push("`pt-relayed` relay usage is not observable from PearTube's API. " +
    'The relayed-peer connections and the blind relay counters provide separate route evidence.')
  lines.push('')

  lines.push('### Blind relay and blind peer counters (scrape)')
  lines.push('')
  if (model.routes.scrape.length === 0) {
    lines.push(na('no scrape lines in these results'))
  } else {
    const scrapeRows = model.routes.scrape.map(entry => {
      const metrics = Object.entries(entry.metrics)
        .map(([name, value]) => metricText(name, value))
        .filter(text => text !== null)
        .slice(0, 6)
      return [
        entry.alias,
        String(entry.samples),
        metrics.length === 0
          ? na('no numeric metric')
          : metrics.join(', ')
      ]
    })
    lines.push(table(['Alias', 'Samples', 'Metrics'], scrapeRows))
  }
  lines.push('')
  lines.push('Aliases are the scraper\'s own names. These are the blind services\' counters, ' +
    'read the stock way through the dht-prometheus scraper.')
  lines.push('')
  lines.push('### Blind relay tasks')
  lines.push('')
  if (!model.routes.relayTasks.length) {
    lines.push(na('no blind relay task'))
  } else {
    const metric = (entry, name) => isNum(entry.metrics[name]) ? String(entry.metrics[name]) : na('counter not scraped')
    const rows = model.routes.relayTasks.map(entry => [
      stepLabel(entry.step), entry.task, entry.key || na('relay key not sampled'),
      metric(entry, 'blind_relay_pairings_requested'), metric(entry, 'blind_relay_pairings_matched'),
      metric(entry, 'blind_relay_pairings_active'), metric(entry, 'blind_relay_streams_opened'),
      metric(entry, 'blind_relay_streams_closed'), metric(entry, 'blind_relay_streams_errors'),
      fmb(entry.rx) || na('ECS rx not sampled'), fmb(entry.tx) || na('ECS tx not sampled'),
      fpercent(entry.cpuPerStream) || na('relay CPU or active stream count unavailable')
    ])
    lines.push(table(['Step', 'Task', 'Relay key', 'Pairings requested', 'Pairings matched', 'Pairings active',
      'Streams opened', 'Streams closed', 'Stream errors', 'ECS rx', 'ECS tx', 'CPU per active stream'], rows))
    lines.push('')
    lines.push('ECS rx and tx include the probe. CPU per stream divides the relay container median by opened minus closed streams.')
  }
  lines.push('')

  lines.push('### Blind peer owner view')
  lines.push('')
  if (model.routes.blindPeer.length === 0) {
    lines.push(na('no blind-peer task in these results'))
  } else if (model.routes.blindPeer.every(entry => entry.owner === null)) {
    lines.push(na('owner.jsonl is absent or has no line for these blind peers'))
  } else {
    const ownerRows = model.routes.blindPeer.map(entry => {
      const owner = entry.owner
      return [
        stepLabel(entry.step),
        entry.task,
        entry.key === null ? na('no blind peer key in the samples') : entry.key,
        owner === null ? na('no owner-client line for this blind peer') : String(owner.events),
        owner === null || owner.remote === null ? na('no remote address in the owner lines') : owner.remote,
        owner === null || owner.cores === null
          ? na('no core view in the owner lines')
          : owner.cores.count + ' cores, ' + owner.cores.remoteContiguous + '/' +
            owner.cores.length + ' blocks contiguous',
        owner === null ? na('no haveBytes') : fmb(owner.haveBytes) || na('no haveBytes'),
        owner === null ? na('no targetBytes') : fmb(owner.targetBytes) || na('no targetBytes'),
        owner === null || owner.progress === null
          ? na('no progress')
          : (owner.progress * 100).toFixed(1) + '%'
      ]
    })
    lines.push(table(
      ['Step', 'Task', 'Blind peer', 'Owner events', 'Remote', 'Cores', 'Have', 'Target', 'Progress'],
      ownerRows
    ))
  }
  lines.push('')

  lines.push('## 3. Connectivity check (not PearTube)')
  lines.push('')
  lines.push('> These are the probe\'s own HyperDHT and forced-relay test measurements. They show ' +
    'what a fresh peer in the task\'s network position could do. They are not PearTube transfer ' +
    'routes and must never be read as holepunch success for PearTube.')
  lines.push('')
  const checksByStep = stepWindows(model.tasks).map(window => {
    const probes = model.tasks.filter(task => task.step !== null && task.step <= window.step &&
      task.startMs <= window.end && (task.stopMs === null || task.stopMs >= window.start)).map(task => task.probe).filter(Boolean)
    const counts = side => {
      const attempted = probes.map(probe => probe.connects[side].attempted).filter(isNum)
      const opened = probes.map(probe => probe.connects[side].opened).filter(isNum)
      if (!attempted.length || !opened.length) return na('connect counts unavailable')
      return opened.reduce((a, b) => a + b, 0) + '/' + attempted.reduce((a, b) => a + b, 0) +
        ' (opened/attempted; n=' + Math.min(opened.length, attempted.length) + '/' + probes.length + ')'
    }
    const nat = probes.map(probe => probe.nat).filter(Boolean)
    const tests = probes.flatMap(probe => probe.relayTests || [])
    const measured = (field, format) => format(median(tests.map(test => toNum(test[field])))) || na('no relay test value')
    return [
      stepLabel(window.step), counts('client'), counts('server'),
      nat.length ? nat.filter(view => view.firewalled === true).length + ' firewalled / ' +
        nat.filter(view => view.firewalled === false).length + ' open / ' +
        nat.filter(view => view.randomized === true).length + ' randomized (n=' + nat.length + ')' : na('no NAT view'),
      measured('pairMs', fms), measured('mbps', value => fnum(value, 1)),
      measured('rttMs', fms), measured('directRttMs', fms)
    ]
  })
  if (checksByStep.length) {
    lines.push('### Per step')
    lines.push('')
    lines.push(table(['Step', 'Client', 'Server', 'NAT view counts', 'Median pairing', 'Median Mbps',
      'Median relay RTT', 'Median direct RTT'], checksByStep))
    lines.push('')
  }
  if (model.connectivity.length === 0) {
    lines.push(na('no task in these results'))
  } else {
    const connectivityRows = model.connectivity.map(entry => {
      const probe = entry.probe
      if (probe === null) {
        return [
          stepLabel(entry.step),
          entry.task,
          entry.kind || na('no kind'),
          na(entry.reason),
          na(entry.reason),
          na(entry.reason),
          na(entry.reason),
          na(entry.reason),
          na(entry.reason),
          na(entry.reason)
        ]
      }
      const side = values => {
        const attempted = values.attempted
        const opened = values.opened
        if (attempted === null && opened === null) return na('no connect stats')
        if (attempted === null) return String(opened) + ' opened / n/a attempted'
        if (opened === null) return 'n/a opened / ' + attempted + ' attempted'
        return opened + ' opened / ' + attempted + ' attempted'
      }
      const nat = probe.nat === null
        ? na('no NAT view')
        : (probe.nat.firewalled === null ? 'n/a firewalled' :
            probe.nat.firewalled ? 'firewalled' : 'open') + ', ' +
          (probe.nat.randomized === null ? 'n/a randomized' :
            probe.nat.randomized ? 'randomized' : 'not randomized')
      const summary = probe.relaySummary
      return [
        stepLabel(entry.step),
        entry.task,
        entry.kind || na('no kind'),
        side(probe.connects.client),
        side(probe.connects.server),
        nat,
        summary === null ? na('no forced relay test in samples') : summary.ok + '/' + summary.n + ' ok',
        summary === null || summary.pairMs.n === 0
          ? na('no relay pairing time')
          : fms(summary.pairMs.median) + ' median',
        summary === null || summary.mbps.n === 0
          ? na('no relay throughput')
          : fnum(summary.mbps.median, 1) + ' Mbps median',
        summary === null || summary.addedRttMs.n === 0
          ? na('no relayed and direct RTT pair')
          : fms(summary.addedRttMs.median) + ' median'
      ]
    })
    lines.push(table(
      ['Step', 'Task', 'Kind', 'Client opened/attempted', 'Server opened/attempted', 'NAT', 'Relay tests', 'Pairing', 'Throughput', 'Added RTT'],
      connectivityRows
    ))
  }
  lines.push('')
  lines.push('Attempted/opened are Hyperswarm\'s connect stats for the probe\'s own topic. ' +
    'Added RTT is the relayed stream\'s RTT minus a direct stream\'s RTT to the same probe.')
  lines.push('')

  lines.push('## 4. Home relay latency and uplink')
  lines.push('')
  if (!model.home.available) {
    lines.push(na(model.home.reason))
  } else {
    const homeRows = []
    for (const step of model.home.steps) {
      for (const relay of step.relays) {
        homeRows.push([
          stepLabel(step.step),
          relay.alias,
          String(relay.samples),
          relay.latencyMs.n === 0 ? na('no latency sample') : fms(relay.latencyMs.median) + ' median',
          relay.latencyMs.n === 0 ? na('no latency sample') : fms(relay.latencyMs.p95) + ' p95',
          relay.latencyMs.n === 0 ? na('no latency sample') : fms(relay.latencyMs.max) + ' max',
          relay.txBytes === null ? na(relay.txReason) : fmb(relay.txBytes),
          isoWindow(step.start, step.end)
        ])
      }
    }
    lines.push(table(
      ['Step', 'Relay', 'Samples', 'Latency median', 'Latency p95', 'Latency max', 'Tx delta', 'Window'],
      homeRows
    ))
    lines.push('')
    lines.push('Samples counts every home line in the window. Latency and tx use only `ok:true` ' +
      'samples; a failed poll keeps its measured time but contributes no counter. Tx delta is the ' +
      'last minus first cumulative uplink counter; a reset counter is reported, not smoothed.')
  }
  lines.push('')

  lines.push('## 5. Cost')
  lines.push('')
  lines.push('Expected uses measured task lifetimes and network bytes. It assumes all task traffic ' +
    'is regional, because the counters do not identify its destination. Log bytes use the larger ' +
    'of stored bytes and observed event sizes; both can lag. Worst uses the full hard caps, ' +
    'the highest task compute rate and both transfer rates. Neither total includes unmeasured ECR storage.')
  lines.push('')
  const expectedLogs = cost.expected.usd.logs === null
    ? na('no logBytes input; pass the CloudWatch ingested size')
    : fgb(cost.expected.logBytes)
  const expectedMissing = cost.expected.missingFields.length > 0
    ? cost.expected.missingFields.join(', ')
    : 'none'
  const costRows = [
    [
      'Expected (regional traffic)',
      String(cost.expected.tasks),
      hoursOrNa(cost.expected.taskHours),
      hoursOrNa(cost.expected.vcpuHours),
      hoursOrNa(cost.expected.gbHours),
      hoursOrNa(cost.expected.ipv4Hours),
      cost.expected.txBytes === null ? na('no tx counter') : (cost.expected.txBytes / 1e9).toFixed(3),
      expectedLogs,
      fusd(cost.expected.usd.compute) || na('no compute data'),
      fusd(cost.expected.usd.ipv4) || na('no IPv4 data'),
      fusd(cost.expected.usd.tx) || na('no tx data'),
      fusd(cost.expected.usd.logs) || na('no logBytes input'),
      fusd(cost.expected.usd.storage) || na('no storage data'),
      na('image sizes not collected'),
      fusd(cost.expected.usd.total) +
        (cost.expected.complete ? '' : ' (partial: ' + expectedMissing + ')')
    ],
    [
      'Worst (hard caps)',
      String(MIX[MIX.length - 1].total),
      hoursOrNa(cost.worst.taskHours),
      hoursOrNa(cost.worst.vcpuHours),
      hoursOrNa(cost.worst.gbHours),
      hoursOrNa(cost.worst.ipv4Hours),
      (cost.worst.txBytes / 1e9).toFixed(3),
      (cost.worst.logBytes / 1e9).toFixed(3) + ' GB',
      fusd(cost.worst.usd.compute),
      fusd(cost.worst.usd.ipv4),
      fusd(cost.worst.usd.tx),
      fusd(cost.worst.usd.logs),
      '$0.0000',
      na('image sizes not collected'),
      fusd(cost.worst.usd.total) + ' (excl. ECR)'
    ]
  ]
  lines.push(table(
    ['Basis', 'Tasks', 'Task-hours', 'vCPU-h', 'GB-h', 'IPv4-h', 'Tx GB', 'Logs', 'Compute', 'IPv4', 'Tx', 'Logs', 'Storage', 'ECR', 'Total'],
    costRows
  ))
  lines.push('')
  lines.push('### Measured cost by step')
  lines.push('')
  const stepKeys = Object.keys(cost.byStep).sort((a, b) => {
    if (a === 'unknown') return 1
    if (b === 'unknown') return -1
    return Number(a) - Number(b)
  })
  const stepCostRows = stepKeys.map(key => {
    const bucket = cost.byStep[key]
    return [
      key,
      String(bucket.tasks),
      hoursOrNa(bucket.taskHours),
      fusd(bucket.usd.compute) || na('no compute data'),
      fusd(bucket.usd.ipv4) || na('no IPv4 data'),
      fusd(bucket.usd.tx) || na('no tx data'),
      fusd(bucket.usd.storage) || na('no storage data'),
      fusd(bucket.usd.total) + ' (excl. logs, ECR)'
    ]
  })
  lines.push(table(
    ['Step', 'Tasks', 'Task-hours', 'Compute', 'IPv4', 'Tx', 'Storage', 'Total'],
    stepCostRows
  ))
  lines.push('')
  lines.push('Logs are billed for the run, not per step; they appear in the expected row only.')
  lines.push('')
  lines.push('- Fargate ' + model.arch + ': $' + cost.rates.vcpuHour.toFixed(5) +
    '/vCPU-hour, $' + cost.rates.gbHour.toFixed(6) + '/GB-hour.')
  lines.push('- IPv4: $' + cost.rates.ipv4Hour.toFixed(3) + '/hour. Expected tx: $0.02/GB regional. ' +
    'Worst tx: $' + cost.rates.txGb.toFixed(2) + '/GB ($0.09 internet + $0.02 regional).')
  lines.push('- Logs: $' + cost.rates.logsGb.toFixed(2) + '/GB ingested. Storage above 20 GiB: $' +
    cost.rates.storageGbHour.toFixed(6) + '/GB-hour. ECR: $' + cost.rates.ecrGbMonth.toFixed(2) +
    '/GB-month.')
  lines.push('- Caps: ' + CAPS.hours + ' task-hours, ' + (CAPS.txBytes / 1e9) +
    ' GB tx, ' + (CAPS.logBytes / 1e9) + ' GB logs; trip at ' + (CAPS.trip * 100).toFixed(0) + '%.')
  lines.push('- Default 45/40/40 minute schedule: ' + defaultScheduleHours().toFixed(2) +
    ' task-hours. At the hard caps: ' + fusd(cost.worst.usd.total) + ' before unmeasured ECR storage.')
  lines.push('')

  lines.push('## Notes')
  lines.push('')
  for (const note of model.notes) lines.push('- ' + note)
  lines.push('')

  return lines.join('\n')
}

function hoursOrNa (value) {
  return isNum(value) ? value.toFixed(2) : na('no value')
}

// Public entry point ---------------------------------------------------------

export async function writeReport ({ run, from, resultsDir, arch = 'amd64', logBytes = null, subsetBytes = null } = {}) {
  const outDir = resultsDir
    ? path.resolve(resultsDir)
    : path.join(FARGATE_DIR, 'results')
  const inDir = from ? path.resolve(from) : path.join(outDir, run || '')
  const runId = run || path.basename(inDir) || 'run'

  const inputs = await readInputs(inDir)
  const generatedAt = new Date().toISOString()
  const built = buildModel({ run: runId, arch, logBytes, inputs, generatedAt, subsetBytes })
  const taskIps = new Set(built.tasks.map(task => task.publicIp).filter(ip => typeof ip === 'string' &&
    !/^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|f[cd]|fe[89ab]|::1)/i.test(ip)))
  const model = scrubArtifact(built, taskIps)

  await mkdir(outDir, { recursive: true })
  const reportPath = path.join(outDir, 'report.md')
  const summaryPath = path.join(outDir, 'summary.json')
  const costPath = path.join(outDir, 'cost.json')
  await writeFile(reportPath, renderMarkdown(model) + '\n', 'utf8')
  await writeFile(summaryPath, JSON.stringify({
    v: 1,
    run: model.run,
    generatedAt: model.generatedAt,
    arch: model.arch,
    source: model.source,
    tasksSource: model.tasksSource,
    stepBasis: model.stepBasis,
    counts: model.counts,
    tasks: model.tasks,
    steps: model.steps,
    groups: model.groups,
    routes: model.routes,
    connectivity: model.connectivity,
    home: model.home,
    cost: model.cost,
    notes: model.notes
  }, null, 2) + '\n', 'utf8')
  await writeFile(costPath, JSON.stringify(model.cost, null, 2) + '\n', 'utf8')

  return {
    reportPath,
    summaryPath,
    costPath,
    tasks: model.tasks.length,
    expectedUsd: model.cost.expected.usd.total,
    worstUsd: model.cost.worst.usd.total
  }
}
